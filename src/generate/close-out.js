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
import { BOUNDARY_LABELS, plain } from './authority-split.js'

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

  const anyCommand =
    detected.commands?.test?.cmd || detected.commands?.build?.cmd || 'npm test'

  return {
    project: { name: plain(projectName || 'this project', 120) },
    humanOnly,
    tier1Example: anyCommand,
  }
}

export async function generate(input) {
  const template = await readFile(TEMPLATE_PATH, 'utf8')
  const model = buildModel(input)
  return { content: render(template, model), model }
}
