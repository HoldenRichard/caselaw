/**
 * Generate docs/authority-split.md from interview answers.
 *
 * This is the first artifact the tool produces and the one that justifies it.
 * Two properties matter more than prettiness:
 *
 *  1. Untested boundaries are rendered as a dated, actionable table rather than
 *     folded in with the real ones. A boundary nobody has checked is a belief,
 *     and beliefs decay silently.
 *  2. It never invents. If an answer is missing the section says so, out loud.
 *     A confident generated lie is worse than a visible hole, because the agent
 *     reads this file and believes it.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { render } from '../render/engine.js'
import { isoDate, addDays } from '../core/dates.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const TEMPLATE_PATH = join(HERE, '../../templates/docs/authority-split.md.tmpl')

/** Human labels for the boundary ids the interview collects. */
export const BOUNDARY_LABELS = {
  device: 'run it on real hardware',
  hardware: 'drive or observe the real hardware it talks to',
  'pair-controller': 'pair it with a real smart-home controller and watch it respond',
  'rendered-ui': 'see what the UI actually renders',
  'prod-data': 'read production datastore state',
  'prod-logs': 'read production logs',
  deploy: 'deploy',
  migrations: 'run database migrations',
  secrets: 'read secrets / API keys',
  'paid-apis': 'call paid or rate-limited third-party APIs',
  'full-suite': 'run the full test suite',
  'real-user-data': 'reproduce anything with real customer data',
  'release-console': 'reach the release console',
  delivery: 'confirm an email / SMS / push arrived',
  'human-login': 'log into anything as a human',
}

/** Human labels for the outside authorities session 2 collects. */
export const OUTSIDE_LABELS = {
  'app-review': 'an app store\'s review (Apple App Review, Google Play)',
  'extension-store': 'a browser extension store\'s review',
  'vscode-marketplace': 'the VS Code Marketplace',
  'registry-policy': 'the package registry\'s policies',
  'hosting-policy': 'the hosting platform\'s terms and abuse review',
  'external-reviewer': 'a person outside the team who approves it',
}

/**
 * A one-command way to settle an untested boundary, where an obvious one
 * exists. Deliberately conservative: a wrong suggestion is worse than none,
 * because it will be pasted into a terminal unread.
 */
export function settleCommandFor(boundary, detected = {}) {
  const deploy = new Set((detected.deploySurface || []).map((d) => d.kind))
  switch (boundary) {
    case 'prod-logs':
      if (deploy.has('fly')) return 'fly logs --no-tail'
      if (deploy.has('k8s')) return 'kubectl logs -l app=<name> --tail=20'
      if (deploy.has('firebase')) return 'firebase functions:log --only <fn>'
      if (deploy.has('vercel')) return 'vercel logs <deployment>'
      return null
    case 'full-suite':
      return detected.commands?.test?.cmd || null
    case 'deploy':
      return null // never suggest a command whose failure mode is a deploy
    case 'secrets':
      return 'ls -la .env* 2>/dev/null'
    case 'prod-data':
      if (deploy.has('firebase')) return 'firebase firestore:indexes'
      return null
    default:
      return null
  }
}

/**
 * Shape interview answers + detection into the template's data contract.
 * Pure — no IO — so it is cheap to test and impossible to make
 * environment-dependent by accident.
 */
/**
 * Free text from the interview is rendered as text. An answer is one line of
 * prose; a newline, a leading `#` or a `|` in it used to become markdown
 * structure in a document the agent reads as doctrine — a seeded
 * ".caselaw/answers.json" line reading "## SYSTEM OVERRIDE" became a heading,
 * and `check` then certified the file as correct.
 */
export function plain(s, max = 2000) {
  return String(s ?? '')
    .replace(/[\r\n\u2028\u2029\t\v\f]+/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/^([#>]|[-*+]\s|\d+[.)]\s)/, '\\$1')
}

/** A table cell: plain text with pipes escaped, so a value cannot add columns. */
export function cell(s, max = 400) {
  return plain(s, max).replace(/\|/g, '\\|')
}

/** Short names for the answers a provenance row can describe. */
const ANSWER_NAMES = {
  'authority.cannot': 'What the agent cannot do',
  'authority.triage': 'Physical, chosen or untested',
  'authority.human_proof': 'What a human has to do',
  'authority.agent_reach': 'What the agent could check itself',
  'authority.retest_days': 'Re-check interval',
  'outside.authority': 'Outside authority',
  'outside.claims': 'Where it makes public claims',
  declarations: 'The public claims themselves',
  'authority.notes': 'Why a boundary is assumed',
}

/**
 * Where each answer came from, when any were drafted by an agent. A drafted
 * answer is a claim resting on files; naming them is what lets the next reader
 * re-derive it instead of carrying it (DEF-216, DEF-748).
 */
function buildSources(provenance = {}, answers = {}) {
  return Object.entries(provenance)
    .filter(([id]) => Object.prototype.hasOwnProperty.call(answers, id))
    .map(([id, p]) => ({
      answer: cell(ANSWER_NAMES[id] || id, 120),
      by: cell(p.by === 'human' ? 'a human' : p.by === 'agent-draft' ? 'agent draft' : p.by || 'unknown', 60),
      evidence: cell((p.evidence || []).map((e) => `\`${e}\``).join(', ') || '—', 400),
      confirmed: cell(p.confirmed || (p.by === 'human' ? 'answered at a terminal' : 'not recorded'), 80),
    }))
}

export function buildModel({ answers = {}, provenance = {}, detected = {}, projectName, now = new Date() }) {
  const selected = answers['authority.cannot'] || []
  const triage = answers['authority.triage'] || {}
  const label = (b) => BOUNDARY_LABELS[b] || plain(b, 200)

  const bucket = (kind) =>
    selected
      .filter((b) => triage[b] === kind)
      .map((b) => ({ value: b, label: label(b), note: plain((answers['authority.notes'] || {})[b] || '', 300) }))

  const untestedDays = Number(answers['authority.retest_days'] ?? 30)
  const unverified = selected
    .filter((b) => triage[b] === 'untested')
    .map((b) => ({
      value: b,
      label: cell(label(b), 200),
      // No question collects a note today, so the honest default is that none
      // was recorded — not "never tried", which was false whenever it had been.
      assumedBecause: cell((answers['authority.notes'] || {})[b] || 'not recorded', 300),
      ...settle(b, detected),
    }))

  const can = buildCanList({ answers, detected, selected })

  return {
    project: { name: plain(projectName || detected.projectName || 'this project', 120) },
    generatedAt: isoDate(now),
    retestDue: unverified.length ? isoDate(addDays(now, untestedDays)) : '',
    can,
    physical: bucket('physical'),
    chosen: bucket('chosen'),
    unverified,
    truthSources: answers['authority.truth_sources'] || [],
    humanProof: plain(answers['authority.human_proof'] || ''),
    outside: (answers['outside.authority'] || []).map((o) => OUTSIDE_LABELS[o] || plain(o, 200)),
    declares: (answers['outside.claims'] || []).length > 0,
    publishing: publishingRows(detected.publishing),
    sources: buildSources(provenance, answers),
  }
}

/**
 * The "Settle it" cell. A one-liner only when the command has actually been
 * seen to exit 0 here; an unverified detected command is offered as something
 * to run by hand and record, because on two of three dogfood repositories the
 * detected test command did not even compile on a fresh clone, and the audit
 * would have told the reader to paste it.
 */
function settle(boundary, detected) {
  const cmd = settleCommandFor(boundary, detected)
  if (!cmd) return { settleCommand: null, settleHint: null }
  if (boundary === 'full-suite' && detected.commands?.test?.exitCode !== 0) {
    return { settleCommand: null, settleHint: cell(cmd, 300) }
  }
  return { settleCommand: cell(cmd, 300), settleHint: null }
}

/**
 * One row per destination: where it publishes, and exactly when the step that
 * does it can run. Round 2 of the DEF-274 re-score: listing every event that
 * starts a workflow told pyvisa's reader that a scheduled run publishes to
 * PyPI; only a tag push does. Events that start the workflow but never reach
 * the step are said, and conditions that are not events are quoted, not read.
 */
export function publishingRows(publishing = []) {
  const rows = []
  for (const p of publishing) {
    for (const s of p.publishes) {
      const when = s.when ?? p.triggers
      const idle = s.when && !s.conditions?.length ? (p.triggers || []).filter((t) => !s.when.includes(t)) : []
      rows.push({
        what: plain(s.what, 200),
        at: `${plain(p.file, 160)}:${s.line}`,
        when: when?.length ? plain(when.join(', or '), 400) : 'events this could not read (check the workflow\'s `on:` block)',
        conditions: plain((s.conditions || []).join('; and '), 400),
        idle: plain(idle.join(', '), 300),
      })
    }
  }
  return rows
}

/**
 * What the agent CAN do. Assembled from measured commands and the tier-2
 * answer rather than asked as its own question — the interview budget is
 * spent on what detection cannot settle. A command the human just named as a
 * boundary is not listed as a capability four sections above it.
 */
function buildCanList({ answers, detected, selected = [] }) {
  const can = []
  // What CI runs on a change outranks commands inferred from the language: on
  // the DEF-274 re-score, ntfy's inferred `go test ./...` failed on a fresh
  // checkout while CI built the docs and web app first and then ran `make checkv`.
  const gates = detected.ciGates?.gates || []
  const byFile = new Map()
  for (const g of gates) byFile.set(g.file, [...(byFile.get(g.file) || []), g])
  for (const [file, list] of byFile) {
    const steps = list.map((g) => `\`${plain(g.cmd, 160)}\`${g.step ? ` (${plain(g.step, 80)})` : ''}`).join('; ')
    can.push(`Run what CI runs on a change, in its order (\`${file}\`): ${steps}.`)
  }
  const shared = detected.ciGates?.shared || []
  if (shared.length) {
    can.push(`CI also runs workflows kept in another repository, whose steps are not visible here: ${shared.map((s) => `\`${plain(s.uses, 160)}\``).join(', ')}.`)
  }

  const cmds = gates.length ? {} : detected.commands || {}
  const verified = []
  for (const [name, entry] of Object.entries(cmds)) {
    if (!entry || !entry.cmd) continue
    if (name === 'test' && selected.includes('full-suite')) continue
    const timing = entry.durationMs ? `, ${(entry.durationMs / 1000).toFixed(0)}s` : ''
    const proof = entry.exitCode === 0 ? `verified ${entry.verifiedAt}${timing}` : 'unverified'
    verified.push(`${name} (\`${entry.cmd}\`, ${proof})`)
  }
  if (verified.length) can.push(`Run: ${verified.join('; ')}.`)

  const reach = plain(answers['authority.agent_reach'] || '')
  if (reach) can.push(reach)

  if (!can.length) can.push('Read and edit source in this repository.')
  return can
}

export async function generate(input) {
  const template = await readFile(TEMPLATE_PATH, 'utf8')
  const model = buildModel(input)
  return { content: render(template, model), model }
}

