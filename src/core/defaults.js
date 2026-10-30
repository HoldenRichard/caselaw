/**
 * The defaults (0.3): six rules in force from install.
 *
 * Each qualified by recurring in two or more of the study's projects and by
 * being a principle rather than a project's detail. Each arrives at the memory
 * rung with the study's incidents as its Precedent; its first catch here
 * writes this project's own Origin (`caselaw rule catch`), and a default that
 * catches nothing in a window of real work is asked about by the audit
 * (borrowed-rules-earn). The human picks which to accept at install.
 *
 * D1 absorbs the trace-the-premise candidate and D4 the one-writer-per-repo
 * candidate; both left candidates/ when the defaults arrived.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { render } from '../render/engine.js'
import { archivePrecedent } from './precedent.js'
import { personalRuleBody } from './personal.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULTS_ROOT = join(HERE, '../../templates/defaults')

/** The window a borrowed rule has to catch something here before the audit asks about it. */
export const DEMOTION_DAYS = 60

export const DEFAULTS = [
  { id: 'D1', name: 're-derive-claims', label: 'Claims are re-derived, not carried: premises received and claims sent out', caught: 'Kabu, caselaw, the marketing pipeline, the website' },
  { id: 'D2', name: 'seen-to-fail', label: 'A check counts once it has been seen to fail; report the verdict, not "completed"', caught: 'Kabu, the marketing pipeline, the study record' },
  { id: 'D3', name: 'say-what-was-not-covered', label: 'A check states what it did not cover', caught: 'Stir, the marketing pipeline, caselaw' },
  { id: 'D4', name: 'one-writer-per-tree', label: 'One writer per working tree; stage explicit paths', caught: 'the study record, caselaw' },
  { id: 'D5', name: 'outward-actions-wait', label: 'Outward-facing, irreversible or spending actions wait for the human; words in the human\'s voice are theirs', caught: 'Reprompt, Kabu, the marketing pipeline' },
  { id: 'D6', name: 'stop-the-chain-on-failure', label: 'A dependent step never runs after the step before it failed', caught: 'Kabu, Reprompt, the study record' },
]

/** The defaults this install accepted, in order. Unanswered or "I don't know" is none: a gap, not a guess. */
export function acceptedDefaults(doc = {}) {
  const chosen = doc.answers?.['harness.defaults']
  if (!Array.isArray(chosen)) return []
  return DEFAULTS.filter((d) => chosen.includes(d.id))
}

const acceptsAny = (doc) => acceptedDefaults(doc).length > 0 || (doc.answers?.['harness.defaults'] || []).some((v) => typeof v === 'string' && v.startsWith('P:'))

/**
 * The date the defaults came into force here, stamped once. The demotion
 * window counts from it, so it must not move on every upgrade, and an install
 * that accepts them in a later upgrade must not inherit its first install date.
 */
export function defaultsSince(doc, now = new Date()) {
  if (!acceptsAny(doc)) return null
  if (!doc.harness?.since) doc.harness = { ...(doc.harness || {}), since: now.toISOString().slice(0, 10) }
  return doc.harness.since
}

/**
 * The owner's personal defaults this install accepted, snapshotted into the
 * answers at install (doc.harness.personal), so the build never needs the
 * owner's home folder and CI renders the same files.
 */
export function personalArtifacts({ doc, dir }) {
  const chosen = (doc.answers?.['harness.defaults'] || []).filter((v) => typeof v === 'string' && v.startsWith('P:'))
  const since = doc.harness?.since || 'install'
  const days = Number.isFinite(doc.answers?.['harness.demotion_days']) ? doc.answers['harness.demotion_days'] : DEMOTION_DAYS
  const out = []
  for (const id of chosen) {
    const p = doc.harness?.personal?.[id.slice(2)]
    if (p) out.push(...withArchivedPrecedent(doc, dir, p.name, personalRuleBody(p, { since, days })))
  }
  return out
}

/** The accepted defaults as files in active/. */
export async function defaultArtifacts({ doc, dir, now }) {
  const since = defaultsSince(doc, now)
  const days = Number.isFinite(doc.answers?.['harness.demotion_days']) ? doc.answers['harness.demotion_days'] : DEMOTION_DAYS
  const out = []
  for (const d of acceptedDefaults(doc)) {
    const template = await readFile(join(DEFAULTS_ROOT, `${d.name}.md`), 'utf8')
    out.push(...withArchivedPrecedent(doc, dir, d.name, render(template, { id: d.id, name: d.name, since, days })))
  }
  return out
}

/**
 * A generated rule whose precedent the optimizer archived is rendered that
 * way, with its archive beside it, so the build and the files agree and an
 * upgrade can still update the rule.
 */
export function withArchivedPrecedent(doc, dir, name, body) {
  const at = doc.harness?.precedentArchived?.[name]
  const rulePath = `${dir}/rules/active/${name}.md`
  const moved = at ? archivePrecedent(body, { name, at }) : null
  if (!moved) return [{ path: rulePath, kind: 'file', body }]
  return [
    { path: rulePath, kind: 'file', body: moved.rule },
    { path: `${dir}/rules/precedent/${name}.md`, kind: 'file', body: moved.archive },
  ]
}
