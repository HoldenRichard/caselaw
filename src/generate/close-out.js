/**
 * Generate docs/close-out.md.
 *
 * The close-out is the flywheel. Everything else in this harness is machinery
 * for holding rules; this is the only artifact that asks whether there is a new
 * one. Ship the rules directory without it and `proposed/` stays empty forever.
 *
 * It is deliberately short. A thorough close-out nobody fills in is worth less
 * than a rough one they actually do, and the failure mode of process documents
 * is always abandonment rather than imprecision.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { render } from '../render/engine.js'
import { BOUNDARY_LABELS, plain, publishingRows } from './authority-split.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const TEMPLATE_PATH = join(HERE, '../../templates/docs/close-out.md.tmpl')

export function buildModel({ answers = {}, detected = {}, projectName }) {
  const selected = answers['authority.cannot'] || []
  const triage = answers['authority.triage'] || {}

  // The human-only tier is carried straight into the close-out so the handover
  // list is the same list, not a second one that drifts from the first.
  const humanOnly = selected
    .filter((b) => triage[b] === 'physical' || triage[b] === 'chosen')
    .map((b) => ({ value: b, label: BOUNDARY_LABELS[b] || plain(b, 200) }))
  // Untested boundaries are handed over as their own group: nobody knows yet
  // whether the agent could have checked them, so a human either settles the
  // boundary or verifies by hand. They used to be dropped from the handover
  // entirely — the one boundary the rest of the tool works hardest to flag.
  const untested = selected
    .filter((b) => triage[b] === 'untested')
    .map((b) => ({ value: b, label: BOUNDARY_LABELS[b] || plain(b, 200) }))

  // The DEF-274 re-score found the close-out identical across three different
  // projects. These three carry the project into it: the gates its CI runs,
  // how a human proves a change here, and which pushes publish.
  const gates = (detected.ciGates?.gates || []).slice(0, 8).map((g) => `\`${plain(g.cmd, 160)}\``)
  const anyCommand =
    detected.ciGates?.gates?.[0]?.cmd || detected.commands?.test?.cmd || detected.commands?.build?.cmd || 'npm test'
  const publishing = publishingRows(detected.publishing).map((r) =>
    `${r.when} — publishes to ${r.what} (\`${r.at}\`)${r.conditions ? `, only if ${r.conditions}` : ''}`)

  return {
    project: { name: plain(projectName || 'this project', 120) },
    humanOnly,
    untested,
    gates,
    humanProof: plain(answers['authority.human_proof'] || '', 600),
    publishing,
    tier1Example: anyCommand,
  }
}

export async function generate(input) {
  const template = await readFile(TEMPLATE_PATH, 'utf8')
  const model = buildModel(input)
  return { content: render(template, model), model }
}
