/**
 * Claims this repository makes about itself, recounted.
 *
 * docs/methodology.md said "468 tests, 163 of them positive controls" while
 * the suite ran 470 and no counting method produced 163. The README said
 * "fifteen minutes" for a four-minute interview and listed a generated file
 * that nothing generates. None of it was malicious; all of it was prose that
 * was true once and had no measurement behind it. The rule the methodology
 * itself states — a quantitative claim needs a command behind it — applied
 * to the methodology.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SESSIONS } from '../../src/interview/questions.js'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen']

/** Static counts over the suite's source: every test() call, and every one named as a positive control. */
export async function countTests() {
  const dir = join(REPO, 'test/unit')
  let cases = 0
  let controls = 0
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.test.js')).sort()) {
    const text = await readFile(join(dir, f), 'utf8')
    cases += (text.match(/^\s*test\(\s*['"`]/gm) || []).length
    controls += (text.match(/^\s*test\(\s*['"`]POSITIVE CONTROL/gm) || []).length
  }
  return { cases, controls }
}

describe('claims this repository makes about itself', () => {
  test('POSITIVE CONTROL: the methodology counts its own tests correctly', async () => {
    // Prose wraps; collapse whitespace before matching, or a reflow reads as a stale claim.
    const text = (await readFile(join(REPO, 'docs/methodology.md'), 'utf8')).replace(/\s+/g, ' ')
    const m = text.match(/has (\d+) `test\(\)` cases in source, (\d+) of them named POSITIVE CONTROL/)
    assert.ok(m, 'docs/methodology.md must state the counts in the sentence this test knows how to read')
    const real = await countTests()
    assert.equal(Number(m[1]), real.cases, `docs/methodology.md says ${m[1]} test cases; the suite has ${real.cases}. Update the sentence.`)
    assert.equal(Number(m[2]), real.controls, `docs/methodology.md says ${m[2]} positive controls; the suite has ${real.controls}. Update the sentence.`)
  })

  test('POSITIVE CONTROL: the README states the interview length the sessions add up to', async () => {
    const readme = await readFile(join(REPO, 'README.md'), 'utf8')
    const minutes = SESSIONS.reduce((s, x) => s + x.minutes, 0)
    assert.ok(WORDS[minutes], `no word for ${minutes} minutes; extend the table`)
    assert.match(readme, new RegExp(`About ${WORDS[minutes]} minutes\\.`), `the README must say "About ${WORDS[minutes]} minutes." — the sessions total ${minutes}`)
  })

  test('POSITIVE CONTROL: the README counts the shipped candidates correctly', async () => {
    const readme = await readFile(join(REPO, 'README.md'), 'utf8')
    const n = (await readdir(join(REPO, 'templates/rules/candidates'))).filter((f) => f.endsWith('.md')).length
    assert.match(readme, new RegExp(`\\b${WORDS[n][0].toUpperCase() + WORDS[n].slice(1)} universal rules ship as \\*\\*candidates\\*\\*`),
      `templates/rules/candidates/ holds ${n}; the README must say so`)
  })

  test('every generated file the README lists is one an artifact produces', async () => {
    const { buildArtifacts } = await import('../../src/generate/artifacts.js')
    const { emptyAnswers } = await import('../../src/core/answers.js')
    const readme = await readFile(join(REPO, 'README.md'), 'utf8')
    const block = readme.match(/## What lands in your repo\n\n```\n([\s\S]*?)```/)
    assert.ok(block, 'the README keeps a "What lands in your repo" block')
    const doc = emptyAnswers({ templateVersion: '1.0', project: { name: 'P' } })
    doc.generatedAt = '2026-08-13T00:00:00.000Z'
    doc.answers['authority.cannot'] = []
    const produced = new Set((await buildArtifacts({ doc, detected: { agentConfig: { claudeMd: true, agentsMd: true }, commands: {}, deploySurface: [] } })).map((a) => a.path))
    // Lines like "  authority-split.md      what you and…" under a "docs/" heading name docs/<file>.
    let prefix = ''
    for (const line of block[1].split('\n')) {
      const dir = line.match(/^(\S+\/)\s*$/)
      if (dir) { prefix = dir[1]; continue }
      const file = line.match(/^\s{2}([\w.-]+\.md)\s/)
      if (file) assert.ok(produced.has(prefix + file[1]), `README lists ${prefix}${file[1]} as generated, but no artifact produces it`)
    }
  })
})
