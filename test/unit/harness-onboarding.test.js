/**
 * 0.3's harness session: the autonomy preset, the defaults chosen at install,
 * and what they put in the repository.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'

import { buildArtifacts } from '../../src/generate/artifacts.js'
import { emptyAnswers } from '../../src/core/answers.js'
import { DEFAULTS, DEFAULTS_ROOT, defaultsSince } from '../../src/core/defaults.js'
import { parseRule, validateRule } from '../../src/core/rules.js'
import { ttyPrompt } from '../../src/interview/prompt.js'
import { QUESTIONS } from '../../src/interview/questions.js'
import { validateDraft } from '../../src/interview/draft.js'

const DETECTED = { agentConfig: { claudeMd: true }, commands: {}, deploySurface: [] }
const docWith = (answers = {}) => {
  const doc = emptyAnswers({ templateVersion: '1.2', project: { name: 'P' } })
  doc.generatedAt = '2026-10-30T00:00:00.000Z'
  Object.assign(doc.answers, answers)
  return doc
}
const paths = (artifacts) => artifacts.map((a) => a.path)

describe('the defaults chosen at install', () => {
  test('POSITIVE CONTROL: the chosen defaults land in active/ with their precedent; the explainer for an empty active/ does not', async () => {
    const doc = docWith({ 'harness.defaults': ['D1', 'D4'] })
    doc.harness = { since: '2026-10-30' }
    const artifacts = await buildArtifacts({ doc, detected: DETECTED })
    const active = paths(artifacts).filter((p) => p.startsWith('docs/rules/active/'))
    assert.deepEqual(active.sort(), ['docs/rules/active/one-writer-per-tree.md', 'docs/rules/active/re-derive-claims.md'])
    const d1 = artifacts.find((a) => a.path === 'docs/rules/active/re-derive-claims.md').body
    assert.match(d1, /\*\*Precedent:\*\* In the study caselaw came from/)
    assert.match(d1, /\*\*Default:\*\* D1, active since 2026-10-30 \(caselaw 0\.3\)/)
    assert.match(d1, /caselaw rule catch re-derive-claims --what/)
    assert.match(d1, /after 60 days of commits/)
  })

  test('POSITIVE CONTROL: no defaults chosen, or never asked: active/ explains why it is empty', async () => {
    for (const answers of [{ 'harness.defaults': [] }, {}]) {
      const artifacts = await buildArtifacts({ doc: docWith(answers), detected: DETECTED })
      const active = paths(artifacts).filter((p) => p.startsWith('docs/rules/active/'))
      assert.deepEqual(active, ['docs/rules/active/WHY-THIS-IS-EMPTY.md'], JSON.stringify(answers))
    }
  })

  test('POSITIVE CONTROL: the date they came into force is stamped once, and an upgrade does not move it', () => {
    const doc = docWith({ 'harness.defaults': ['D2'] })
    assert.equal(defaultsSince(doc, new Date('2026-11-01T10:00:00Z')), '2026-11-01')
    assert.equal(defaultsSince(doc, new Date('2027-01-15T10:00:00Z')), '2026-11-01')
    assert.equal(defaultsSince(docWith({}), new Date('2026-11-01')), null, 'no defaults, no date')
  })

  test('POSITIVE CONTROL: every shipped default is a valid rule whose precedent cites, under its own name', async () => {
    const files = (await readdir(DEFAULTS_ROOT)).filter((f) => f.endsWith('.md')).sort()
    assert.deepEqual(files, DEFAULTS.map((d) => `${d.name}.md`).sort(), 'one template per default, and no stray ones')
    for (const d of DEFAULTS) {
      const doc = docWith({ 'harness.defaults': [d.id] })
      doc.harness = { since: '2026-10-30' }
      const body = (await buildArtifacts({ doc, detected: DETECTED })).find((a) => a.path === `docs/rules/active/${d.name}.md`).body
      const parsed = parseRule(body, { path: `${d.name}.md` })
      assert.equal(parsed.name, d.name)
      assert.equal(parsed.origin, null, `${d.name} must not ship an Origin: that is this project's to write`)
      const v = validateRule(parsed, { filename: `${d.name}.md`, resolveRef: false })
      assert.deepEqual(v.problems, [], `${d.name}: ${JSON.stringify(v.problems)}`)
      // Short second mentions ("the record", "the marketing pipeline") are the same project, not another.
      const same = { record: "study's record", 'marketing pipeline': "Kabu's marketing pipeline" }
      const projects = new Set([...parsed.precedent.matchAll(/DEF-\d+ \(([^,]+),/g)].map((m) => m[1].replace(/^the /, '')).map((n) => same[n] || n))
      assert.ok(projects.size >= 2 || /caselaw itself/.test(parsed.precedent), `${d.name}: a default recurred in two or more projects; its precedent names ${[...projects].join(', ')}`)
      assert.doesNotMatch(body, /\{\{|\}\}/, 'every placeholder rendered')
    }
  })
})

describe('the harness section of the authority split', () => {
  test('POSITIVE CONTROL: the preset and the defaults in force are written where the agent reads them', async () => {
    const doc = docWith({ 'harness.autonomy': 'tune-itself', 'harness.defaults': ['D1', 'D6'] })
    doc.harness = { since: '2026-10-30' }
    const split = (await buildArtifacts({ doc, detected: DETECTED })).find((a) => a.path === 'docs/authority-split.md').body
    assert.match(split, /## How the harness changes\n\nTune itself: a rule that only adds enforcement may apply on its own/)
    assert.match(split, /Whatever the setting, weakening a rule, widening what the agent may do,\ndeleting evidence, and anything that leaves the project wait for a human\./)
    assert.match(split, /Defaults in force since 2026-10-30, each in `docs\/rules\/active\/`: D1 `re-derive-claims`, D6 `stop-the-chain-on-failure`\./)
  })

  test('unanswered, the section is not invented', async () => {
    const split = (await buildArtifacts({ doc: docWith({}), detected: DETECTED })).find((a) => a.path === 'docs/authority-split.md').body
    assert.doesNotMatch(split, /How the harness changes/)
  })
})

describe('preselected answers at a terminal', () => {
  const run = async (q, line) => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const p = ttyPrompt({ input, output })
    const answer = q.type === 'select' ? p.select(q) : p.multiselect(q)
    input.write(`${line}\n`)
    try { return await answer } finally { await p.close() }
  }
  const autonomy = QUESTIONS.find((q) => q.id === 'harness.autonomy')
  const defaults = QUESTIONS.find((q) => q.id === 'harness.defaults')
  const withOptions = (q) => ({ ...q, options: typeof q.options === 'function' ? q.options({}) : q.options })

  test('POSITIVE CONTROL: blank takes "Ask me first"; blank accepts every default; "-" accepts none', async () => {
    assert.equal(await run(withOptions(autonomy), ''), 'ask-first')
    assert.equal(await run(withOptions(autonomy), '2'), 'tune-itself')
    assert.deepEqual(await run(withOptions(defaults), ''), DEFAULTS.map((d) => d.id))
    assert.deepEqual(await run(withOptions(defaults), '-'), [])
    assert.deepEqual(await run(withOptions(defaults), '1,3'), ['D1', 'D3'])
  })
})

describe('the harness questions in an agent draft', () => {
  const draft = (questions) => ({ draftVersion: 1, questions })
  test('POSITIVE CONTROL: a preference needs no file to rest on; a fact still does', async () => {
    const pref = await validateDraft(draft([{ id: 'harness.autonomy', answer: 'ask-first', evidence: [] }, { id: 'harness.defaults', answer: ['D1'], evidence: [] }]), { root: process.cwd(), detected: {} })
    assert.deepEqual(pref, [])
    const fact = await validateDraft(draft([{ id: 'authority.human_proof', answer: 'Tap through it.', evidence: [] }]), { root: process.cwd(), detected: {} })
    assert.equal(fact.length, 1)
    assert.match(fact[0], /an answer with no evidence/)
  })
})
