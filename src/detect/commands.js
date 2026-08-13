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
 * @param {{stack?: object, walked?: object}} [ctx]
 * @returns {Promise<{commands: object, warnings: object[]}>}
 */
export async function detectCommands(root, opts = {}, ctx = {}) {
  const warnings = []
  const commands = emptyCommands()
  /** First provider to fill a slot wins; providers are ordered by how precise they are. */
  const set = (slot, cmd, source) => {
    if (!commands[slot] && cmd) commands[slot] = { cmd, source }
  }

  const rootFiles = new Set(
    (ctx.walked?.files || (await safeReaddir(root))).filter((f) => !f.includes('/')),
  )
  const rootDirs = (ctx.walked?.dirs || (await safeReaddir(root, true))).filter((d) => !d.includes('/'))
  const pm = ctx.stack?.packageManager || 'npm'

  // 1. package.json scripts — the most precise source there is.
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

  // 2. pyproject.toml tool sections.
  if (rootFiles.has('pyproject.toml')) {
    const text = await readText(join(root, 'pyproject.toml'))
    if (text !== null) {
      const sections = tomlSections(text)
      const has = (s) => sections.some((x) => x === s || x.startsWith(`${s}.`))
      const src = (s) => `pyproject.toml:[${s}]`
      if (has('tool.pytest')) set('test', 'pytest', src('tool.pytest.ini_options'))
      if (has('tool.ruff')) set('lint', 'ruff check .', src('tool.ruff'))
      if (has('tool.flake8')) set('lint', 'flake8', src('tool.flake8'))
      if (has('tool.black')) set('format', 'black .', src('tool.black'))
      if (sections.includes('tool.ruff.format')) set('format', 'ruff format .', src('tool.ruff.format'))
      if (has('tool.mypy')) set('typecheck', 'mypy .', src('tool.mypy'))
      if (has('tool.pyright')) set('typecheck', 'pyright', src('tool.pyright'))
      if (has('tool.poetry')) set('build', 'poetry build', src('tool.poetry'))
      if (has('build-system')) set('build', 'python -m build', src('build-system'))
    }
  }

  // 3. Ecosystems whose commands are fixed by convention rather than declared.
  if (rootFiles.has('Cargo.toml')) {
    set('test', 'cargo test', 'Cargo.toml')
    set('lint', 'cargo clippy -- -D warnings', 'Cargo.toml')
    set('format', 'cargo fmt --check', 'Cargo.toml')
    set('build', 'cargo build', 'Cargo.toml')
  }
  if (rootFiles.has('go.mod')) {
    set('test', 'go test ./...', 'go.mod')
    set('lint', 'go vet ./...', 'go.mod')
    set('format', 'gofmt -l .', 'go.mod')
    set('build', 'go build ./...', 'go.mod')
  }
  if (rootFiles.has('Package.swift')) {
    set('test', 'swift test', 'Package.swift')
    set('build', 'swift build', 'Package.swift')
  }

  // 4. Xcode. Optional, timeout-guarded, and never fatal.
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

  // 5. Generic task runners, last: they are real but say nothing about which
  //    target is the one CI runs.
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

  return { commands, warnings }
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
