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
import { workflowEvents, publishSteps } from './publishing.js'

const MAX_GATES = 12

const SETUP = /^(cd|echo|export|set|exit|true|sudo\b|apt(-get)?\b|brew\b|choco\b|python3? -m pip\b|pip3? install\b|npm (ci|install|i)\b|yarn( install)?$|pnpm (install|i)\b|corepack\b|go mod (download|tidy)\b|git (config|fetch|submodule)\b|mkdir\b|cp\b|mv\b|rm\b|curl\b|wget\b|source\b|\.\s|touch\b|chmod\b|ls\b|cat\b|env\b|printenv\b|codecov\b|bash -c "\$\(curl)/

const SETUP_STEP = /^(install|set ?up|setup|cache|checkout|print|configure|prepare|download)\b/i

/** A shared workflow counts as a gate only when its name says it builds, tests, lints or checks. */
const GATE_NAME = /(build|test|lint|check|typecheck|ci)[^/]*\.ya?ml/i

export function emptyCiGates() {
  return { gates: [], shared: [] }
}

/**
 * @param {string} root
 * @param {{files: string[]}} walked
 * @returns {Promise<{ciGates: {gates: object[], shared: object[]}, warnings: object[]}>}
 */
export async function detectCiGates(root, walked) {
  const ciGates = emptyCiGates()
  const workflows = walked.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).sort()
  for (const file of workflows) {
    let text
    try { text = await readFile(join(root, file), 'utf8') } catch { continue }
    if (!runsOnChange(text) || publishSteps(text).length) continue
    for (const g of runSteps(text)) if (ciGates.gates.length < MAX_GATES) ciGates.gates.push({ file, ...g })
    for (const s of sharedWorkflows(text)) ciGates.shared.push({ file, ...s })
  }
  return { ciGates, warnings: [] }
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
