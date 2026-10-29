/**
 * Generate docs/declarations.md: what this project says about itself in public.
 *
 * A declaration is a claim that leaves the repository. When the developer did
 * not write the code, it is carried rather than known: true as of the last
 * time someone re-derived it from the product, and nothing in the build fails
 * when it drifts. The study behind this tool sent a false signing claim to an
 * app reviewer from an agent's memory (DEF-216); a public README overstated
 * the product by 47% for two months (DEF-217); caselaw's own README said its
 * source app had shipped (DEF-748). Each was caught only when someone went
 * back to the product.
 *
 * So every surface gets a row, and every row asks for the same four things:
 * what it claims, where the truth lives, how to re-derive it, and when that was
 * last done. Rows nobody has filled are shown as holes, never invented.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { render } from '../render/engine.js'
import { cell, plain } from './authority-split.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const TEMPLATE_PATH = join(HERE, '../../templates/docs/declarations.md.tmpl')

/** Human labels for the claim surfaces session 2 collects. */
export const CLAIM_LABELS = {
  readme: 'the README',
  'privacy-policy': 'the privacy policy',
  terms: 'the terms of service',
  'store-listing': 'the store listing',
  'package-listing': 'the package listing',
  website: 'the website',
  'docs-site': 'the documentation site',
}

const HOLE = '_not recorded_'

/**
 * @param {object} o
 * @param {object} o.answers     `outside.claims` lists the surfaces; `declarations`
 *                               (edited by hand, or drafted) fills their rows:
 *                               {surface: [{claim, truth, rederive, checked}]}
 */
export function buildModel({ answers = {}, detected = {}, projectName }) {
  const surfaces = answers['outside.claims'] || []
  const filled = answers.declarations || {}
  const pathOf = new Map((detected.signals?.claims || []).map((c) => [c.kind, c.source]))
  const label = (s) => `${CLAIM_LABELS[s] || plain(s, 120)}${pathOf.get(s) ? ` (\`${pathOf.get(s)}\`)` : ''}`
  const rows = []
  const unrecorded = []
  // A surface with no recorded claim is one line saying so, not a row of empty
  // cells: the DEF-274 reviewer read a table of holes as an unfinished form.
  for (const s of surfaces) {
    const entries = Array.isArray(filled[s]) ? filled[s].filter((e) => e && e.claim) : []
    if (!entries.length) { unrecorded.push(label(s)); continue }
    for (const e of entries) {
      rows.push({
        where: cell(label(s), 200),
        claim: cell(e.claim, 300),
        truth: e.truth ? cell(e.truth, 200) : HOLE,
        rederive: e.rederive ? `\`${cell(e.rederive, 200)}\`` : HOLE,
        checked: e.checked ? cell(e.checked, 30) : 'never',
      })
    }
  }
  return { project: { name: plain(projectName || 'this project', 120) }, rows, unrecorded: unrecorded.join(', ') }
}

export async function generate(input) {
  const template = await readFile(TEMPLATE_PATH, 'utf8')
  const model = buildModel(input)
  return { content: render(template, model), model }
}
