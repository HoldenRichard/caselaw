/**
 * The gates CI actually runs on a change, in the order it runs them.
 *
 * The DEF-274 re-score found the detected commands were generic rather than
 * the project's own gates: ntfy's `go test ./...` fails on a fresh checkout,
 * because CI builds the docs and the web app first ("required for tests") and
 * then runs `make checkv`; pyvisa's CI formats, lints and type-checks the
 * package directory, not the tree. CI is where a project writes down what has
 * to pass, so its run steps outrank anything inferred from a language.
 *
 * Read line by line from workflows that run on a push or a pull request and
 * publish nothing (a chat announcement aside: a test workflow may post to Slack). Setup lines (installs, `cd`, `echo`) are not gates. A job
 * that `uses:` a workflow from another repository is reported as such: its
 * gates exist, and are not visible from here.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { workflowEvents, publishSteps, jobsOf, stepContext } from './publishing.js'
import { unquoteYamlScalar as unquote } from '../core/text.js'

const MAX_GATES = 12

const SETUP = /^(cd|echo|export|set|exit|true|sudo\b|apt(-get)?\b|brew\b|choco\b|python3? -m pip\b|pip3? install\b|npm (ci|install|i)\b|yarn( install)?$|pnpm (install|i)\b|corepack\b|go mod (download|tidy)\b|uv (sync|pip (install|uninstall))\b|pnpm runtime set\b|tar\b|git (config|fetch|submodule|checkout|switch)\b|mkdir\b|cp\b|mv\b|rm\b|curl\b|wget\b|source\b|\.\s|touch\b|chmod\b|ls\b|cat\b|env\b|printenv\b|codecov\b|bash -c "\$\(curl)/

const ASSIGNMENT_ONLY = /^(?:[A-Za-z_]\w*|\$env:\w+)\s*=\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\([^\n]*\)|[^\s]+)\s*$/

const SETUP_STEP = /^(?:\([^)]*\)\s*)?(install|set|setup|cache|checkout|print|configure|prepare|download|update|uninstall|reinstall|collect|create)\b/i

/** A shared workflow counts as a gate only when its name says it builds, tests, lints or checks. */
const GATE_NAME = /(build|test|lint|check|typecheck|ci)[^/]*\.ya?ml/i

export function emptyCiGates() {
  return { gates: [], setup: [], shared: [], contexts: [], unread: [], unresolved: [] }
}

/**
 * A command that only reports a tool's version is not a check: reprompt's CI
 * printed `xcodebuild -version` and `swift --version`, and both were listed as
 * what an agent runs to verify a change.
 */
const VERSION_PROBE = /^[\w./-]+(?:\s+[\w:.-]+){0,3}\s+(?:--version|-version|-V)\s*(?:2>&1)?\s*$|^(?:go|docker|dotnet|kubectl|terraform)\s+version(?:\s+--?[\w-]+)?\s*$/

export function isVersionProbe(cmd) {
  return VERSION_PROBE.test(String(cmd).trim())
}

/**
 * CI systems other than GitHub Actions. Their gates and anything they publish
 * are not read; the authority split says so rather than implying it covered
 * them (round 4 of the DEF-274 re-score: pyvisa's Azure pipeline builds its
 * Keysight environment on a Python its pyproject.toml no longer allows).
 */
const OTHER_CI = [
  [/^azure-pipelines\.ya?ml$|^\.azure-pipelines\//, 'Azure Pipelines'],
  [/^\.gitlab-ci\.ya?ml$/, 'GitLab CI'],
  [/^\.circleci\/config\.ya?ml$/, 'CircleCI'],
  [/^Jenkinsfile$/, 'Jenkins'],
  [/^\.travis\.ya?ml$/, 'Travis CI'],
  [/^appveyor\.ya?ml$|^\.appveyor\.ya?ml$/, 'AppVeyor'],
  [/^bitbucket-pipelines\.ya?ml$/, 'Bitbucket Pipelines'],
  [/^\.buildkite\/pipeline\.ya?ml$/, 'Buildkite'],
]

/**
 * @param {string} root
 * @param {{files: string[]}} walked
 * @returns {Promise<{ciGates: {gates: object[], shared: object[], contexts: object[]}, warnings: object[]}>}
 */
export async function detectCiGates(root, walked) {
  const ciGates = emptyCiGates()
  const warnings = []
  const workflows = walked.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).sort()
  for (const file of workflows) {
    let text
    try { text = await readFile(join(root, file), 'utf8') } catch { continue }
    if (!runsOnChange(text) || publishSteps(text).some((p) => !p.announce)) continue
    // Each gate carries its job, and each job its own context: pyvisa's matrix
    // belongs to the pytest job only, and round 3 of the DEF-274 re-score found
    // it attached to the format, lint and type checks as well.
    const jobs = jobsOf(text)
    const lines = text.split(/\r?\n/)
    const jobOf = (line) => jobs.find((j) => line - 1 > j.start && line - 1 < j.end)
    const { gates: resolved, dropped } = resolveSteps(text, scanGateSteps(text))
    const gates = resolved.map((g) => ({ ...g, job: jobOf(g.line)?.name ?? null }))
    if (dropped.length) {
      for (const d of dropped) ciGates.unresolved.push({ file, line: d.line, step: d.step, job: jobOf(d.line)?.name ?? null, cmd: d.cmd, expressions: d.expressions })
      warnings.push({
        code: 'ci-expression-unresolved',
        message: `${dropped.length} command${dropped.length === 1 ? '' : 's'} in ${file} (first at line ${dropped[0].line}) contain an expression CI fills in at run time (${dropped[0].expressions[0]}), so ${dropped.length === 1 ? 'it was' : 'they were'} not listed as runnable.`,
        hint: 'Read the workflow to see what CI runs; a matrix value that takes several values has no single local command.',
      })
    }
    const available = Math.max(0, MAX_GATES - ciGates.gates.length)
    ciGates.gates.push(...gates.slice(0, available).map((g) => ({ file, ...g })))
    if (gates.length > available) {
      ciGates.unread.push({ file, system: `additional GitHub Actions commands beyond the ${MAX_GATES}-command reporting limit` })
      warnings.push({ code: 'ci-gates-truncated', message: `Only the first ${MAX_GATES} CI commands are reported; additional commands in ${file} need source review.` })
    }
    const unread = scanSteps(text).filter((step) => step.unread)
    if (unread.length) {
      for (const step of unread) ciGates.unread.push({ file, system: `shell control flow in ${step.step || 'a run step'} at line ${step.line}` })
      warnings.push({ code: 'ci-shell-unread', message: `Shell control flow in ${file} needs source review; its fragments are not standalone checks.` })
    }
    // The project's own setup, which CI runs before its gates: ntfy's gates do
    // not run on a clean machine without `make build-deps-ubuntu` (round 4).
    // Only what runs before the job's first gate: ntfy's "Print build results"
    // runs after `make build`, and is not setup the build needs.
    for (const s of resolveSteps(text, scanSetupSteps(text)).gates) {
      const job = jobOf(s.line)?.name ?? null
      if (gates.some((g) => g.job === job && g.line > s.line)) ciGates.setup.push({ file, ...s, job })
    }
    for (const s of sharedWorkflows(text)) ciGates.shared.push({ file, ...s })
    for (const job of jobs) {
      if (!gates.some((g) => g.job === job.name)) continue
      const context = runContext(lines.slice(job.start, job.end).join('\n'))
      if (context.services.length || context.secrets.length || context.matrix.length) ciGates.contexts.push({ file, job: job.name, ...context })
    }
  }
  for (const [re, system] of OTHER_CI) {
    const file = walked.files.filter((f) => re.test(f)).sort()[0]
    if (file) ciGates.unread.push({ file, system })
  }
  return { ciGates, warnings }
}

/**
 * What CI has that a local run may not: services it starts, secrets it is
 * given, and the matrix it fans out over. Round 2 of the DEF-274 re-score:
 * ntfy's tests run against a Postgres service and an S3 secret and skip
 * themselves locally without them, so a local pass was read as CI's pass.
 */
/** Secrets that upload coverage or publish; a test run does not need them. */
const NOT_FOR_TESTS = /^(GITHUB_TOKEN$|CODECOV|COVERALLS|SONAR|NPM|NODE_AUTH|PYPI|TWINE|DOCKER|GH_PAT)/

export function runContext(text) {
  const lines = text.split(/\r?\n/)
  const indent = (l) => l.match(/^\s*/)[0].length
  const services = []
  const matrix = []
  for (let i = 0; i < lines.length; i++) {
    const s = /^(\s*)services:\s*$/.exec(lines[i])
    if (s) {
      const base = s[1].length
      const child = lines.slice(i + 1).find((l) => l.trim())
      const at = child ? indent(child) : base + 2
      for (let j = i + 1; j < lines.length && (!lines[j].trim() || indent(lines[j]) > base); j++) {
        const m = /^\s*([\w-]+):\s*$/.exec(lines[j])
        if (m && indent(lines[j]) === at) services.push(m[1])
      }
    }
    const mx = /^(\s*)matrix:\s*$/.exec(lines[i])
    if (mx) {
      const base = mx[1].length
      for (let j = i + 1; j < lines.length && (!lines[j].trim() || indent(lines[j]) > base); j++) {
        const m = /^\s*([\w-]+):\s*\[(.*)\]\s*$/.exec(lines[j])
        if (m && m[1] !== 'include' && m[1] !== 'exclude') matrix.push({ key: m[1], count: m[2].split(',').filter((x) => x.trim()).length })
      }
    }
  }
  const secrets = [...new Set([...text.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))].filter((s) => !NOT_FOR_TESTS.test(s))
  return { services: [...new Set(services)], secrets, matrix }
}

/** Does this workflow run on a pull request, or on a push that is not only a tag? */
export function runsOnChange(text) {
  const events = workflowEvents(text)
  if (!events) return false
  return events.some(({ event, filters }) =>
    event === 'pull_request' || event === 'pull_request_target' ||
    (event === 'push' && !(filters.tags && !filters.branches)))
}

/** Each gate command with the line it is on and the name of its step, in file order. */
export function runSteps(text) {
  return resolveSteps(text, scanGateSteps(text)).gates
}

function scanGateSteps(text) {
  return scanSteps(text).filter((c) => !c.setup && !c.unread && !SETUP.test(c.cmd) && !ASSIGNMENT_ONLY.test(c.cmd) && !isVersionProbe(c.cmd)).map(({ cmd, line, step, context }) => ({ cmd, line, step, ...context }))
}

function scanSetupSteps(text) {
  return scanSteps(text).filter((c) => c.setup && !c.unread && !SETUP.test(c.cmd) && !ASSIGNMENT_ONLY.test(c.cmd) && !isVersionProbe(c.cmd)).map(({ cmd, line, step, context }) => ({ cmd, line, step, ...context }))
}

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g

/**
 * `${{ ... }}` is filled in by the CI runner, so a command holding one is not a
 * command anyone can run. A plain `matrix.key` whose job lists exactly one
 * value is substituted (and the gate says so); anything else drops the command
 * and is reported as unresolved. itsdangerous ran its tests as
 * `tox run -e ${{ matrix.tox || format('py{0}', matrix.python) }}`, and the
 * generated docs listed that line as a command.
 */
function resolveSteps(text, steps) {
  const jobs = jobsOf(text)
  const lines = text.split(/\r?\n/)
  const gates = []
  const dropped = []
  for (const s of steps) {
    const found = [...s.cmd.matchAll(EXPRESSION)]
    if (!found.length) { gates.push(s); continue }
    const job = jobs.find((j) => s.line - 1 > j.start && s.line - 1 < j.end)
    const singles = job ? matrixSingles(lines.slice(job.start, job.end)) : {}
    const unresolved = []
    const notes = []
    const cmd = s.cmd.replace(EXPRESSION, (whole, expr) => {
      const key = /^\s*matrix\.([\w-]+)\s*$/.exec(expr)?.[1]
      if (key && singles[key] !== undefined) { notes.push(`matrix.${key} is "${singles[key]}" in this job`); return singles[key] }
      unresolved.push(whole.trim())
      return whole
    })
    if (unresolved.length) dropped.push({ ...s, expressions: unresolved })
    else gates.push({ ...s, cmd, note: `${notes.join('; ')}; substituted into the CI command` })
  }
  return { gates, dropped }
}

/** Matrix keys that hold exactly one value (and no `include`/`exclude` to add more), as {key: value}. */
function matrixSingles(jobLines) {
  const indent = (l) => l.match(/^\s*/)[0].length
  const at = jobLines.findIndex((l) => /^\s*matrix:\s*$/.test(l))
  if (at === -1) return {}
  const base = indent(jobLines[at])
  const body = []
  for (let i = at + 1; i < jobLines.length && (!jobLines[i].trim() || indent(jobLines[i]) > base); i++) if (jobLines[i].trim()) body.push(jobLines[i])
  if (!body.length) return {}
  const keyIndent = indent(body[0])
  const out = {}
  for (let i = 0; i < body.length; i++) {
    if (indent(body[i]) !== keyIndent) continue
    const m = /^\s*([\w-]+):\s*(.*)$/.exec(body[i])
    if (!m) continue
    if (m[1] === 'include' || m[1] === 'exclude') return {}
    let values
    if (m[2].trim().startsWith('[')) values = m[2].trim().replace(/^\[|\]\s*(#.*)?$/g, '').split(',').map((x) => unquote(x.trim())).filter(Boolean)
    else if (!m[2].trim()) {
      values = []
      for (let j = i + 1; j < body.length && indent(body[j]) > keyIndent; j++) {
        const item = /^\s*-\s+(.+?)\s*$/.exec(body[j])
        if (item) values.push(unquote(item[1]))
      }
    } else continue
    if (values.length === 1 && !/\$\{\{/.test(values[0])) out[m[1]] = values[0]
  }
  return out
}

/**
 * The project's own commands inside steps named for setup: `make
 * build-deps-ubuntu`, a repository script. Package-manager installs and shell
 * housekeeping are not listed; a reader knows to install dependencies.
 */
export function setupSteps(text) {
  return resolveSteps(text, scanSetupSteps(text)).gates
}

// A shell comment ends at the physical newline; its trailing slash does not continue it.
function hasShellComment(text) {
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "\\" && quote !== "'") { i++; continue }
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '#' && (i === 0 || /[\s;|&()]/.test(text[i-1]))) return true
  }
  return false
}

/** Ignore quoted command arguments when recognizing shell structure/redirections. */
function shellStructure(command) {
  let quote = null
  let code = ''
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = null
      code += ' '
    } else if (ch === '\\') { i++; code += ' ' }
    else if (ch === '"' || ch === "'") { quote = ch; code += ' ' }
    else {
      // A quoted delimiter is still a heredoc; numeric shifts and here-strings are not.
      if (ch === '<' && command[i - 1] !== '<' && /^<<-?\s*(['"]?)[A-Za-z_]\w*\1(?=\s|$|[;|&])/.test(command.slice(i))) return true
      code += ch
    }
  }
  return /(?:^|;|&&|\|\||\|)\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:if\s|elif\s|else(?:\s|$)|fi(?:\s|$)|for\s|while\s|until\s|case\s|esac(?:\s|$)|[A-Za-z_]\w*\s*\(\)\s*\{)/.test(code)
}

function scanSteps(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  const indent = (l) => l.match(/^\s*/)[0].length
  let stepName = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const name = /^\s*-?\s*name:\s*(.+?)\s*$/.exec(l)
    if (name && /^\s*-\s/.test(l)) stepName = unquote(name[1])
    else if (name && !/^\s*run:/.test(l) && /^\s+name:/.test(l) && /^\s*-\s/.test(lines[i - 1] || '')) stepName = unquote(name[1])
    if (/^\s*-\s+(uses|run):/.test(l) && !name) stepName = /^\s*-\s+run:/.test(l) ? null : stepName
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(l)
    if (!run) continue
    const value = run[2].trim().replace(/^([|>][-+]?)\s+#.*$/, '$1')
    const context = stepContext(text, i + 1)
    const runLine = i + 1
    const commands = []
    if (/^[|>][-+]?$/.test(value)) {
      const base = indent(l) + (/^\s*-\s+run:/.test(l) ? 2 : 0)
      const first = lines.slice(i + 1).find(line => line.trim())
      const contentIndent = first ? indent(first) : base + 2
      let j = i + 1
      for (; j < lines.length && (!lines[j].trim() || indent(lines[j]) > base); j++) {
        const fragment = lines[j].slice(contentIndent)
        if (!fragment.trim()) continue
        const previous = commands.at(-1)
        // YAML folded scalars join lines; literal shell blocks join only explicit continuations.
        const continued = previous && !hasShellComment(previous.cmd) && ((previous.cmd.match(/\\+$/)?.[0].length || 0) % 2 === 1)
        if (previous && (value.startsWith('>') || continued)) {
          previous.cmd = value.startsWith('>') ? previous.cmd + ' ' + fragment : previous.cmd.slice(0, -1) + fragment
        } else commands.push({ cmd: fragment, line: j + 1 })
      }
      i = j - 1 // literal shell/YAML inside a run block is not another workflow step
    } else if (value) {
      commands.push({ cmd: unquote(value), line: i + 1 })
    }
    // A step named for setup is setup, whatever it runs: ntfy's "Install dependencies" is `make build-deps-ubuntu`.
    const setup = SETUP_STEP.test(stepName || '')
    const controlFlow = commands.some((c) => shellStructure(c.cmd))
    if (controlFlow) {
      out.push({ cmd: '', line: runLine, step: stepName, setup, unread: true })
      continue
    }
    for (const c of commands) {
      const cmd = c.cmd.trim()
      if (!cmd || cmd.startsWith('#')) continue
      out.push({ cmd, line: c.line, step: stepName, setup, context })
    }
  }
  return out
}

/** Jobs whose steps are defined in another repository's workflow. */
export function sharedWorkflows(text) {
  const out = []
  text.split(/\r?\n/).forEach((l, i) => {
    const m = /^\s{2,4}uses:\s*([\w.-]+\/[\w.-]+\/\.github\/workflows\/\S+)/.exec(l)
    if (m && GATE_NAME.test(m[1])) out.push({ uses: m[1], line: i + 1 })
  })
  return out
}
