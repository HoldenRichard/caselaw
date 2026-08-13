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
export function buildModel({ answers = {}, detected = {}, projectName, now = new Date() }) {
  const selected = answers['authority.cannot'] || []
  const triage = answers['authority.triage'] || {}
  const label = (b) => BOUNDARY_LABELS[b] || b

  const bucket = (kind) =>
    selected
      .filter((b) => triage[b] === kind)
      .map((b) => ({ value: b, label: label(b), note: (answers['authority.notes'] || {})[b] || '' }))

  const untestedDays = Number(answers['authority.retest_days'] ?? 30)
  const unverified = selected
    .filter((b) => triage[b] === 'untested')
    .map((b) => ({
      value: b,
      label: label(b),
      assumedBecause: (answers['authority.notes'] || {})[b] || 'never tried',
      settleCommand: settleCommandFor(b, detected),
    }))

  const can = buildCanList({ answers, detected })

  return {
    project: { name: projectName || detected.projectName || 'this project' },
    generatedAt: isoDate(now),
    retestDue: unverified.length ? isoDate(addDays(now, untestedDays)) : '',
    can,
    physical: bucket('physical'),
    chosen: bucket('chosen'),
    unverified,
    truthSources: answers['authority.truth_sources'] || [],
    humanProof: (answers['authority.human_proof'] || '').trim(),
  }
}

/**
 * What the agent CAN do. Assembled from measured commands and the tier-2
 * answer rather than asked as its own question — the interview budget is
 * spent on what detection cannot settle.
 */
function buildCanList({ answers, detected }) {
  const can = []
  const cmds = detected.commands || {}
  const verified = []
  for (const [name, entry] of Object.entries(cmds)) {
    if (!entry || !entry.cmd) continue
    const timing = entry.durationMs ? `, ${(entry.durationMs / 1000).toFixed(0)}s` : ''
    const proof = entry.exitCode === 0 ? `verified ${entry.verifiedAt}${timing}` : 'unverified'
    verified.push(`${name} (\`${entry.cmd}\`, ${proof})`)
  }
  if (verified.length) can.push(`Run: ${verified.join('; ')}.`)

  const reach = (answers['authority.agent_reach'] || '').trim()
  if (reach) can.push(reach)

  if (!can.length) can.push('Read and edit source in this repository.')
  return can
}

export async function generate(input) {
  const template = await readFile(TEMPLATE_PATH, 'utf8')
  const model = buildModel(input)
  return { content: render(template, model), model }
}

