import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { generate, buildModel } from '../../src/generate/close-out.js'
import { parseRule } from '../../src/core/rules.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATES = join(HERE, '../../templates')

const MOBILE_APP = {
  answers: {
    'authority.cannot': ['device', 'prod-data', 'prod-logs'],
    'authority.triage': { device: 'physical', 'prod-data': 'chosen', 'prod-logs': 'untested' },
  },
  detected: { commands: { test: { cmd: 'xcodebuild test' } } },
  projectName: 'Northwind',
}

describe('close-out — the handover list is the authority split, not a second list', () => {
  test('carries physical and chosen boundaries through as checkboxes', async () => {
    const { content } = await generate(MOBILE_APP)
    assert.match(content, /- \[ \] run it on real hardware/)
    assert.match(content, /- \[ \] read production datastore state/)
  })

  test('untested boundaries are NOT handed over as if they were known limits', () => {
    const m = buildModel(MOBILE_APP)
    assert.ok(!m.humanOnly.some((h) => h.value === 'prod-logs'),
      'an untested boundary belongs in the re-test table, not on a handover checklist')
  })

  test('says so plainly when nothing is recorded', async () => {
    const { content } = await generate({ answers: {}, detected: {}, projectName: 'P' })
    assert.match(content, /Nothing recorded/)
  })

  test('POSITIVE CONTROL: the rule-proposals prompt is present — it is the whole point', async () => {
    const { content } = await generate(MOBILE_APP)
    assert.match(content, /## Rule proposals/)
    assert.match(content, /caselaw rule propose/,
      'without a standing prompt, proposed/ stays empty and the system is decoration')
  })

  test('uses the project’s own detected command in the example, not a generic one', async () => {
    const { content } = await generate(MOBILE_APP)
    assert.match(content, /xcodebuild test/)
  })
})

describe('shipped case-law templates', () => {
  test('every candidate rule parses under the real parser', async () => {
    const dir = join(TEMPLATES, 'rules/candidates')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'))
    assert.equal(files.length, 5, 'the five universal candidates should ship')

    for (const f of files) {
      const parsed = parseRule(await readFile(join(dir, f), 'utf8'), { path: f })
      assert.ok(parsed.trigger, `${f} has no Trigger`)
      assert.ok(parsed.rule, `${f} has no Rule`)
      assert.equal(parsed.name, f.replace(/\.md$/, ''), `${f} name/filename mismatch`)
    }
  })

  test('POSITIVE CONTROL: no candidate ships a plain Origin that adopt could inherit', async () => {
    const dir = join(TEMPLATES, 'rules/candidates')
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.md')) continue
      const text = await readFile(join(dir, f), 'utf8')
      assert.match(text, /\*\*Origin \(upstream\):\*\*/, `${f} must mark its origin as upstream`)
      assert.doesNotMatch(text, /^\*\*Origin:\*\*/m,
        `${f} must NOT carry a plain Origin — adopting must force the adopter to write their own`)
      assert.match(text, /not in force/i, `${f} must say it is not in force`)
    }
  })

  test('POSITIVE CONTROL: no candidate leaks the source project or a machine path', async () => {
    const dir = join(TEMPLATES, 'rules/candidates')
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.md')) continue
      const text = await readFile(join(dir, f), 'utf8')
      assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]/, `${f} contains a machine path`)
      // Domain terms, not proper nouns. The realistic failure is someone
      // pasting a stack-specific rule into the candidate set; naming the
      // upstream project here would leak the association this repo is
      // deliberately without, and would catch less.
      assert.doesNotMatch(text, /\b(Swift|SwiftUI|SwiftFormat|Xcode|Firebase|Firestore|xcresult|simulator)\b/i,
        `${f} contains a stack-specific term — candidates must be domain-free`)
    }
  })

  test('the active/ directory ships an explainer rather than a starter pack', async () => {
    const text = await readFile(join(TEMPLATES, 'rules/active/WHY-THIS-IS-EMPTY.md'), 'utf8')
    assert.match(text, /zero ratified rules/)
    assert.match(text, /caselaw rule propose/)
  })

  test('the README documents the ladder and the retirement rule', async () => {
    const text = await readFile(join(TEMPLATES, 'rules/README.md'), 'utf8')
    // Collapse whitespace before matching: these are prose assertions about
    // what the document SAYS, and where a sentence happens to wrap is a
    // formatting choice that should never break a content test.
    const prose = text.replace(/\s+/g, ' ')
    assert.match(prose, /machine:/, 'the enforcement ladder must be documented')
    assert.match(prose, /erases its own evidence/,
      'the retirement rule must warn against pruning rules that are working')
    assert.match(prose, /Only a human moves files/)
  })
})
