/**
 * The five commands the verification tiers are built out of, and where each
 * one came from.
 *
 * WE DO NOT RUN ANYTHING HERE. A detector that executes `npm test` to find out
 * whether `npm test` works has just run arbitrary code from a repo the user
 * has not yet told us they trust. Verification happens later, once, with
 * consent. The single exception is `xcodebuild -list`, which reads the project
 * file and builds nothing — and even that is timeout-guarded and skippable,
 * because on a cold project it can take tens of seconds out of a 15-minute
 * interview budget.
 *
 * `source` is not decoration. Every inferred command is a guess with a
 * provenance, the interview prints the provenance next to the guess, and the
 * human corrects it in one keystroke instead of typing the command out. An
 * inference the human cannot audit is worse than no inference.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from './exec.js'
import { isVersionProbe } from './ci-gates.js'
import { tomlTable, tomlStrings, tomlEntries } from './toml.js'

export const SLOTS = ['test', 'lint', 'format', 'typecheck', 'build']

/**
 * Budget for `xcodebuild -list`.
 *
 * Measured at 11.3s on a cold mid-size iOS project (486 source files), so the
 * obvious 10s guess would have been a coin flip that silently costs the human
 * their test command. 20s is 2% of the interview's 15-minute budget and only
 * ever spent on Xcode projects; losing the scheme list is the worse trade.
 */
export const DEFAULT_XCODE_TIMEOUT_MS = 20000

/**
 * package.json script names we accept for each slot, best first.
 * Exact slot name always wins over an alias.
 */
const SCRIPT_ALIASES = {
  test: ['test', 'tests', 'test:unit', 'unit', 'spec', 'jest', 'vitest'],
  lint: ['lint', 'lint:js', 'eslint', 'lint:all', 'lint:check'],
  format: ['format', 'fmt', 'format:check', 'prettier', 'prettier:check'],
  typecheck: ['typecheck', 'type-check', 'types', 'tsc', 'check-types', 'check:types'],
  build: ['build', 'compile', 'bundle', 'build:prod'],
}

const MAKE_ALIASES = {
  test: ['test', 'tests', 'check'],
  lint: ['lint', 'vet', 'clippy'],
  format: ['format', 'fmt'],
  typecheck: ['typecheck', 'types', 'mypy'],
  build: ['build', 'compile', 'all'],
}

/**
 * `npm init` writes this as the test script. Treating it as a real test
 * command makes the interview confidently wrong and produces a verification
 * tier whose first command is `exit 1`.
 */
const NPM_PLACEHOLDER = /no test specified/i

export function emptyCommands() {
  return { test: null, lint: null, format: null, typecheck: null, build: null }
}

/**
 * @param {string} root
 * @param {{xcode?: boolean, xcodebuildBin?: string, xcodeTimeoutMs?: number}} [opts]
 * @param {{stack?: object, walked?: object, ciGates?: object}} [ctx]
 * @returns {Promise<{commands: object, warnings: object[]}>}
 */
export async function detectCommands(root, opts = {}, ctx = {}) {
  const warnings = []
  const commands = emptyCommands()
  /**
   * First provider to fill a slot wins. They run in the order a project's own
   * choices outrank ours: CI steps, then task runners (package.json scripts,
   * tox, nox, make, just, task), then the lockfile's runner over pyproject
   * sections, then the language's defaults.
   */
  const set = (slot, cmd, source) => {
    if (!commands[slot] && cmd && !isVersionProbe(cmd)) commands[slot] = { cmd, source }
  }

  const rootFiles = new Set(
    (ctx.walked?.files || (await safeReaddir(root))).filter((f) => !f.includes('/')),
  )
  const rootDirs = (ctx.walked?.dirs || (await safeReaddir(root, true))).filter((d) => !d.includes('/'))
  const pm = ctx.stack?.packageManager || 'npm'

  // 1. What CI runs, resolved. A project writes down what has to pass in its
  //    workflow, with the flags it needs (`go test -race`) and the runner it
  //    uses (`golangci-lint`, not the language's default `go vet`).
  for (const g of ctx.ciGates?.gates || []) {
    // A step that runs elsewhere, or is allowed to fail, says nothing about the root.
    if (g.workingDirectory || g.continueOnError) continue
    const slot = slotOfCommand(g.cmd)
    if (slot) set(slot, g.cmd, `${g.file}:${g.line}`)
  }

  // 2. Task runners: the project's own names for its checks.
  if (rootFiles.has('package.json')) {
    const pkg = await readJson(join(root, 'package.json'))
    if (pkg === undefined) {
      warnings.push({
        code: 'unparseable-package-json',
        message: 'package.json could not be parsed; its scripts were skipped.',
        hint: 'Fix the JSON, or supply the commands by hand during the interview.',
      })
    } else if (pkg && typeof pkg.scripts === 'object' && pkg.scripts) {
      for (const slot of SLOTS) {
        const name = pickScript(pkg.scripts, SCRIPT_ALIASES[slot])
        if (!name) continue
        if (slot === 'test' && NPM_PLACEHOLDER.test(String(pkg.scripts[name]))) {
          warnings.push({
            code: 'placeholder-test-script',
            message: 'package.json has the `npm init` placeholder test script, not a real one.',
            hint: 'Treated as "no test command". This project has no automated tests until one is written.',
          })
          continue
        }
        set(slot, `${pm} run ${name}`, `package.json:scripts.${name}`)
      }
    }
  }

  const pyText = rootFiles.has('pyproject.toml') ? await readText(join(root, 'pyproject.toml')) : null
  const py = pythonRunner(rootFiles, pyText)

  // tox and nox: itsdangerous types with `tox -e typing`, and `mypy .` is not what it runs.
  if (rootFiles.has('tox.ini')) {
    const text = await readText(join(root, 'tox.ini'))
    if (text !== null) {
      const envs = toxEnvs(text)
      for (const slot of SLOTS) {
        const env = pickEnv(envs, slot)
        if (env) set(slot, wrapRunner(py, 'tox', `-e ${env.name}`), `tox.ini:${env.source}`)
      }
      if (/^\s*\[testenv\]/m.test(text)) set('test', wrapRunner(py, 'tox', '-e py'), 'tox.ini:[testenv]')
    }
  }
  if (rootFiles.has('noxfile.py')) {
    const text = await readText(join(root, 'noxfile.py'))
    if (text !== null) {
      const sessions = noxSessions(text)
      for (const slot of SLOTS) {
        const s = pickEnv(sessions, slot)
        if (s) set(slot, wrapRunner(py, 'nox', `-s ${s.name}`), `noxfile.py:${s.name}`)
      }
    }
  }

  if (rootFiles.has('Makefile') || rootFiles.has('makefile')) {
    const name = rootFiles.has('Makefile') ? 'Makefile' : 'makefile'
    const text = await readText(join(root, name))
    if (text !== null) {
      const targets = makeTargets(text)
      for (const slot of SLOTS) {
        const t = MAKE_ALIASES[slot].find((a) => targets.includes(a))
        if (t) set(slot, `make ${t}`, `${name}:${t}`)
      }
    }
  }
  for (const jf of ['justfile', 'Justfile', '.justfile']) {
    if (!rootFiles.has(jf)) continue
    const text = await readText(join(root, jf))
    if (text === null) break
    const recipes = justRecipes(text)
    for (const slot of SLOTS) {
      const t = MAKE_ALIASES[slot].find((a) => recipes.includes(a))
      if (t) set(slot, `just ${t}`, `${jf}:${t}`)
    }
    break
  }
  for (const tf of ['Taskfile.yml', 'Taskfile.yaml']) {
    if (!rootFiles.has(tf)) continue
    const text = await readText(join(root, tf))
    if (text === null) break
    const tasks = taskfileTasks(text)
    for (const slot of SLOTS) {
      const t = MAKE_ALIASES[slot].find((a) => tasks.includes(a))
      if (t) set(slot, `task ${t}`, `${tf}:${t}`)
    }
    break
  }

  // 3. pyproject.toml tool sections, through the lockfile's runner: bare
  //    `pytest` is not installed on a machine that has only run `uv sync`.
  if (pyText !== null) {
    const sections = tomlSections(pyText)
    const has = (s) => sections.some((x) => x === s || x.startsWith(`${s}.`))
    const src = (s) => `pyproject.toml:[${s}]${py.runner ? ` (run through ${py.lock})` : ''}`
    if (has('tool.pytest') || rootFiles.has('pytest.ini')) set('test', wrapRunner(py, 'pytest'), src('tool.pytest.ini_options'))
    else if (py.groupWith('pytest') !== null) set('test', wrapRunner(py, 'pytest'), src('dependency-groups'))
    if (has('tool.ruff')) set('lint', wrapRunner(py, 'ruff', 'check .'), src('tool.ruff'))
    if (has('tool.flake8')) set('lint', wrapRunner(py, 'flake8'), src('tool.flake8'))
    if (has('tool.black')) set('format', wrapRunner(py, 'black', '.'), src('tool.black'))
    if (sections.includes('tool.ruff.format')) set('format', wrapRunner(py, 'ruff', 'format .'), src('tool.ruff.format'))
    if (has('tool.mypy')) set('typecheck', wrapRunner(py, 'mypy', '.'), src('tool.mypy'))
    if (has('tool.pyright')) set('typecheck', wrapRunner(py, 'pyright'), src('tool.pyright'))
    if (has('tool.poetry') && py.lock !== 'uv.lock') set('build', 'poetry build', src('tool.poetry'))
    else if (py.lock === 'uv.lock' || has('tool.uv')) set('build', 'uv build', `pyproject.toml:[${has('tool.uv') ? 'tool.uv' : 'build-system'}]`)
    else if (has('build-system')) set('build', 'python -m build', src('build-system'))
  }

  // 4. Ecosystems whose commands are fixed by convention rather than declared.
  if (rootFiles.has('Cargo.toml')) {
    set('test', 'cargo test', 'Cargo.toml')
    set('lint', 'cargo clippy -- -D warnings', 'Cargo.toml')
    set('format', 'cargo fmt --check', 'Cargo.toml')
    set('build', 'cargo build', 'Cargo.toml')
  }
  if (rootFiles.has('go.mod')) {
    set('test', 'go test ./...', 'go.mod')
    // A golangci-lint config is the project saying which linter it means.
    const golangci = ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'].find((f) => rootFiles.has(f))
    if (golangci) set('lint', 'golangci-lint run', golangci)
    set('lint', 'go vet ./...', 'go.mod')
    set('format', 'gofmt -l .', 'go.mod')
    set('build', 'go build ./...', 'go.mod')
  }
  if (rootFiles.has('Package.swift')) {
    set('test', 'swift test', 'Package.swift')
    set('build', 'swift build', 'Package.swift')
  }

  // 5. Xcode. Optional, timeout-guarded, and never fatal.
  const xcodeTarget = pickXcodeTarget(rootFiles, rootDirs)
  if (xcodeTarget && opts.xcode !== false) {
    const res = await listXcodeSchemes(root, xcodeTarget, opts)
    if (res.scheme) {
      const q = /\s/.test(res.scheme) ? `"${res.scheme}"` : res.scheme
      set('test', `xcodebuild test -scheme ${q}`, `xcodebuild -list:${xcodeTarget.name}`)
      set('build', `xcodebuild build -scheme ${q}`, `xcodebuild -list:${xcodeTarget.name}`)
    } else if (res.warning) {
      warnings.push(res.warning)
    }
  }

  return { commands, warnings }
}

// --- classifying commands --------------------------------------------------

/** What a `tox -e <env>` or `nox -s <session>` name does, by the names projects give them. */
function slotOfEnv(name) {
  if (/^(typing|types?|typecheck|type-?check|mypy|pyright)$/i.test(name)) return 'typecheck'
  if (/^(fmt|format|black)$/i.test(name)) return 'format'
  if (/^(lint|linting|style|flake8|ruff|pylint|pre-?commit)$/i.test(name)) return 'lint'
  if (/^(build|package|dist)$/i.test(name)) return 'build'
  if (/^(tests?|pytest|unit|py\d*|pypy\d*)$/i.test(name)) return 'test'
  return null
}

const SLOT_PATTERNS = [
  ['typecheck', /\b(mypy|pyright|pytype)\b|\btsc\b|\b(npm|yarn|pnpm)( run)? (typecheck|type-check|check-types|types)\b|\bmake (typecheck|types|mypy)\b/],
  ['format', /\b(black|ruff format|gofmt|prettier|cargo fmt|isort|swiftformat|rustfmt)\b|\b(npm|yarn|pnpm)( run)? (format|fmt|prettier)\b|\bmake (format|fmt)\b/],
  ['lint', /\b(ruff check|ruff|flake8|pylint|golangci-lint|eslint|clippy|go vet|staticcheck|rubocop|swiftlint|pre-commit run)\b|\b(npm|yarn|pnpm)( run)? lint\b|\bmake (lint|vet)\b/],
  ['test', /\b(pytest|py\.test|go test|cargo (nextest|test)|jest|vitest|mocha|rspec|swift test|dotnet test|phpunit|ctest)\b|\bpython3? -m (pytest|unittest)\b|\b(npm|yarn|pnpm|bun)( run)? test\b|\bmvn\b.*\b(test|verify)\b|\bgradlew?\b.*\b(test|check)\b|\bmake (tests?|check\w*)\b|\bxcodebuild\b.*\btest\b/],
  ['build', /\bpython3? -m build\b|\b(uv|poetry|flit|hatch|pdm) build\b|\bgo build\b|\bcargo build\b|\bswift build\b|\b(npm|yarn|pnpm)( run)? build\b|\bmake (build|all)\b|\bxcodebuild\b.*\bbuild\b|\bgradlew? build\b/],
]

/**
 * Which of the five slots a CI command fills, or null. A chain (`a && b`) is
 * two commands and says neither; a version probe is not a check.
 */
export function slotOfCommand(raw) {
  const cmd = String(raw).trim()
  if (!cmd || /&&|\|\||[;|]/.test(cmd) || isVersionProbe(cmd)) return null
  const tool = /\b(tox|nox)\b(?:\s+run)?(.*)$/.exec(cmd)
  if (tool) {
    const env = /(?:^|\s)(?:-e|-s|--env|--session|-p)[ =]?(\S+)/.exec(tool[2])?.[1]
    return env ? slotOfEnv(env.split(',')[0]) : 'test'
  }
  for (const [slot, re] of SLOT_PATTERNS) if (re.test(cmd)) return slot
  return null
}

/** The tox environments a tox.ini names, as {name, source}. */
export function toxEnvs(text) {
  const out = []
  const add = (name, source) => { if (name && !/[{}]/.test(name) && !out.some((e) => e.name === name)) out.push({ name, source }) }
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s*\[testenv:([^\]]+)\]/.exec(line)
    if (h) add(h[1].trim(), `[testenv:${h[1].trim()}]`)
  }
  // `envlist = a, b` and its indented continuation lines.
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => /^\s*envlist\s*=/.test(l))
  if (at !== -1) {
    const rest = [lines[at].replace(/^\s*envlist\s*=/, '')]
    for (let i = at + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) rest.push(lines[i])
    // Brace groups (`py3{12,13}`) are generated names, not envs of their own.
    for (const name of rest.join(' ').replace(/\{[^}]*\}/g, '{}').split(/[\s,]+/)) add(name, '[tox] envlist')
  }
  return out
}

/** The nox sessions a noxfile.py defines: `def name(session`, or `@nox.session(name="x")`. */
export function noxSessions(text) {
  const out = []
  const add = (name) => { if (name && !out.some((e) => e.name === name)) out.push({ name, source: name }) }
  const renamed = new Set()
  for (const m of text.matchAll(/@nox\.session\(([^)]*)\)\s*\n\s*def\s+(\w+)\s*\(/g)) {
    const name = /name\s*=\s*["']([\w-]+)["']/.exec(m[1])?.[1]
    if (name) renamed.add(m[2])
    add(name || m[2])
  }
  for (const m of text.matchAll(/^def\s+(\w+)\s*\(\s*session\b/gm)) if (!renamed.has(m[1])) add(m[1])
  return out
}

/** The first environment or session whose name does this slot's job. */
function pickEnv(envs, slot) {
  // `py312` is one interpreter's run of the tests, not a name for them: `tox -e py` is.
  return envs.find((e) => slotOfEnv(e.name) === slot && !(slot === 'test' && /^pypy?\d*$/i.test(e.name)))
}

// --- python runners --------------------------------------------------------

/**
 * How this project runs a Python tool: through the lockfile's runner when it
 * has one (`uv run --locked`, `poetry run`), where the tool lives in a
 * dependency group the lock installs. itsdangerous keeps pytest in a `tests`
 * group, so its working command is `uv run --locked --group tests pytest`.
 */
export function pythonRunner(rootFiles, pyText) {
  const lock = ['uv.lock', 'poetry.lock', 'pdm.lock', 'Pipfile.lock'].find((f) => rootFiles.has(f)) || null
  const runner = { 'uv.lock': 'uv', 'poetry.lock': 'poetry', 'pdm.lock': 'pdm', 'Pipfile.lock': 'pipenv' }[lock] || null
  const groups = tomlEntries(pyText ? tomlTable(pyText, 'dependency-groups') : null)
  const uvTable = pyText ? tomlTable(pyText, 'tool.uv') : null
  if (uvTable) {
    const legacy = tomlEntries(uvTable).get('dev-dependencies')
    if (legacy && !groups.has('dev')) groups.set('dev', legacy)
  }
  const defaults = new Set(['dev', ...tomlStrings(uvTable, 'default-groups')])
  const project = pyText ? tomlTable(pyText, 'project') || '' : ''
  const mentions = (text, tool) => new RegExp(`["']${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'i').test(text)
  return {
    lock,
    runner,
    /** '' when `uv sync` installs the tool by default, a group name when it does not, null when no group holds it. */
    groupWith(tool) {
      if (mentions(project, tool)) return ''
      const held = [...groups].filter(([, text]) => mentions(text, tool)).map(([name]) => name)
      if (!held.length) return null
      return held.find((g) => defaults.has(g)) !== undefined ? '' : held[0]
    },
  }
}

/** `tool args`, behind the lockfile's runner when the lock installs the tool. */
export function wrapRunner(py, tool, args = '') {
  const tail = args ? ` ${args}` : ''
  if (py.runner === 'uv') {
    const group = py.groupWith(tool)
    return group === null ? `${tool}${tail}` : `uv run --locked${group ? ` --group ${group}` : ''} ${tool}${tail}`
  }
  return py.runner ? `${py.runner} run ${tool}${tail}` : `${tool}${tail}`
}

// --- parsers ---------------------------------------------------------------

/** Exact slot name first, then aliases in declared order. */
function pickScript(scripts, names) {
  for (const n of names) {
    const body = scripts[n]
    if (typeof body === 'string' && body.trim()) return n
  }
  return null
}

/** Section headers of a TOML file. Not a TOML parser — we only need the keys. */
export function tomlSections(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line)
    if (m) out.push(m[1].trim().replace(/["']/g, ''))
  }
  return out
}

/**
 * Target names in a Makefile. Recipe lines start with a tab, `.PHONY` starts
 * with a dot, and `VAR := value` is an assignment — all three are excluded by
 * requiring an alphanumeric first character and rejecting `:=`.
 */
export function makeTargets(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_./-]*)\s*:(?!=)/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

export function justRecipes(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (line.includes(':=')) continue
    const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+[^:]*)?:/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

export function taskfileTasks(text) {
  const out = []
  let inTasks = false
  for (const line of text.split('\n')) {
    if (/^tasks:\s*$/.test(line)) {
      inTasks = true
      continue
    }
    if (!inTasks) continue
    if (/^\S/.test(line)) {
      inTasks = false
      continue
    }
    const m = /^\s{2}([A-Za-z0-9][A-Za-z0-9_:-]*):/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

// --- xcode -----------------------------------------------------------------

function pickXcodeTarget(rootFiles, rootDirs) {
  // A workspace supersedes the project it contains: building the project
  // directly skips the CocoaPods/SPM integration the workspace wires up.
  const all = [...rootDirs, ...rootFiles]
  const ws = all.find((d) => d.endsWith('.xcworkspace'))
  if (ws) return { flag: '-workspace', name: ws }
  const proj = all.find((d) => d.endsWith('.xcodeproj'))
  if (proj) return { flag: '-project', name: proj }
  return null
}

async function listXcodeSchemes(root, target, opts) {
  const bin = opts.xcodebuildBin || 'xcodebuild'
  const res = await run(bin, ['-list', '-json', target.flag, target.name], {
    cwd: root,
    timeoutMs: opts.xcodeTimeoutMs ?? DEFAULT_XCODE_TIMEOUT_MS,
  })
  if (!res.ok) {
    return {
      scheme: null,
      warning: {
        code: 'xcodebuild-unavailable',
        message: `Could not list Xcode schemes: ${res.reason}`,
        hint: 'Supply the test and build commands by hand; everything else was still detected.',
      },
    }
  }
  let schemes = []
  try {
    const parsed = JSON.parse(res.stdout)
    schemes = parsed.workspace?.schemes || parsed.project?.schemes || []
  } catch {
    return {
      scheme: null,
      warning: {
        code: 'xcodebuild-unparseable',
        message: 'xcodebuild -list returned output that was not JSON.',
        hint: 'Supply the test and build commands by hand.',
      },
    }
  }
  if (schemes.length === 0) return { scheme: null, warning: null }
  const base = target.name.replace(/\.(xcworkspace|xcodeproj)$/, '')
  // Prefer the scheme named after the project; never default to a *Tests
  // scheme, which builds the test bundle and not the app.
  return {
    scheme:
      schemes.find((s) => s === base) ||
      schemes.find((s) => !/tests?$/i.test(s)) ||
      schemes[0],
    warning: null,
  }
}

// --- io --------------------------------------------------------------------

/** @returns {Promise<string|null>} null when unreadable — never throws. */
async function readText(p) {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return null
  }
}

/** @returns {Promise<object|null|undefined>} null = unreadable, undefined = bad JSON. */
async function readJson(p) {
  const text = await readText(p)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function safeReaddir(root, wantDirs = false) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((e) => (wantDirs ? e.isDirectory() : !e.isDirectory())).map((e) => e.name)
  } catch {
    return []
  }
}
