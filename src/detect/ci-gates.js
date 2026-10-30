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
 * publish nothing. Setup lines (installs, `cd`, `echo`) are not gates. A job
 * that `uses:` a workflow from another repository is reported as such: its
 * gates exist, and are not visible from here.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { workflowEvents, publishSteps, jobsOf } from './publishing.js'

const MAX_GATES = 12

const SETUP = /^(cd|echo|export|set|exit|true|sudo\b|apt(-get)?\b|brew\b|choco\b|python3? -m pip\b|pip3? install\b|npm (ci|install|i)\b|yarn( install)?$|pnpm (install|i)\b|corepack\b|go mod (download|tidy)\b|git (config|fetch|submodule)\b|mkdir\b|cp\b|mv\b|rm\b|curl\b|wget\b|source\b|\.\s|touch\b|chmod\b|ls\b|cat\b|env\b|printenv\b|codecov\b|bash -c "\$\(curl)/

const SETUP_STEP = /^(install|set ?up|setup|cache|checkout|print|configure|prepare|download)\b/i

/** A shared workflow counts as a gate only when its name says it builds, tests, lints or checks. */
const GATE_NAME = /(build|test|lint|check|typecheck|ci)[^/]*\.ya?ml/i

export function emptyCiGates() {
  return { gates: [], shared: [], contexts: [] }
}

/**
 * @param {string} root
 * @param {{files: string[]}} walked
 * @returns {Promise<{ciGates: {gates: object[], shared: object[], contexts: object[]}, warnings: object[]}>}
 */
export async function detectCiGates(root, walked) {
  const ciGates = emptyCiGates()
  const workflows = walked.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).sort()
  for (const file of workflows) {
    let text
    try { text = await readFile(join(root, file), 'utf8') } catch { continue }
    if (!runsOnChange(text) || publishSteps(text).length) continue
    // Each gate carries its job, and each job its own context: pyvisa's matrix
    // belongs to the pytest job only, and round 3 of the DEF-274 re-score found
    // it attached to the format, lint and type checks as well.
    const jobs = jobsOf(text)
    const lines = text.split(/\r?\n/)
    const jobOf = (line) => jobs.find((j) => line - 1 > j.start && line - 1 < j.end)
    const gates = runSteps(text).map((g) => ({ ...g, job: jobOf(g.line)?.name ?? null }))
    for (const g of gates) if (ciGates.gates.length < MAX_GATES) ciGates.gates.push({ file, ...g })
    for (const s of sharedWorkflows(text)) ciGates.shared.push({ file, ...s })
    for (const job of jobs) {
      if (!gates.some((g) => g.job === job.name)) continue
      const context = runContext(lines.slice(job.start, job.end).join('\n'))
      if (context.services.length || context.secrets.length || context.matrix.length) ciGates.contexts.push({ file, job: job.name, ...context })
    }
  }
  return { ciGates, warnings: [] }
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
    const value = run[2].trim()
    const commands = []
    if (/^[|>][-+]?$/.test(value)) {
      const base = indent(l)
      for (let j = i + 1; j < lines.length && (!lines[j].trim() || indent(lines[j]) > base); j++) {
        if (lines[j].trim()) commands.push({ cmd: lines[j].trim(), line: j + 1 })
      }
    } else if (value) {
      commands.push({ cmd: value, line: i + 1 })
    }
    // A step named for setup is setup, whatever it runs: ntfy's "Install dependencies" is `make build-deps-ubuntu`.
    if (SETUP_STEP.test(stepName || '')) continue
    for (const c of commands) {
      const cmd = c.cmd.replace(/;\s*$/, '').replace(/\s+#.*$/, '').trim()
      if (!cmd || cmd.startsWith('#') || SETUP.test(cmd)) continue
      out.push({ cmd, line: c.line, step: stepName })
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

function unquote(s) {
  return String(s).trim().replace(/^["']|["']$/g, '')
}
