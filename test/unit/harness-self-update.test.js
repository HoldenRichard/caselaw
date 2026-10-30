/**
 * 0.3's self-update: the harness changing itself, under the constitution.
 * The plan's own test: an auto-mode agent change that weakens enforcement is
 * refused and turned into a proposal.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { classify, proposeChange, applyChange, rejectChange, readLog, changes, evaluateChanges, reverseOf, HARNESS_LOG } from '../../src/core/harness.js'
import { emptyAnswers } from '../../src/core/answers.js'
import { runChecks } from '../../src/audit/checks.js'

let root
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-self-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel, content) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const exists = async (rel) => { try { await access(join(root, rel)); return true } catch { return false } }
const doc = (answers = {}) => {
  const d = emptyAnswers({ templateVersion: '1.2', project: { name: 'P' } })
  d.generatedAt = '2026-10-01T00:00:00.000Z'
  Object.assign(d.answers, answers)
  return d
}
const EV = 'commit abc1234: the audit was ignored for a month'
const propose = (d, change, extra = {}) => proposeChange({ root, doc: d, change, evidence: EV, signal: 'load-words', now: new Date('2026-10-31T00:00:00Z'), ...extra })

describe('what kind of change it is', () => {
  test('POSITIVE CONTROL: tune, strengthen, narrow, weaken, widen, other and forbidden, each with the article it touches', () => {
    const d = doc({ 'harness.defaults': ['D1'], 'harness.autonomy': 'custom' })
    const kind = (c) => { const r = classify(c, d); return [r.kind, r.articles] }
    assert.deepEqual(kind({ op: 'set', key: 'harness.demotion_days', value: 50 }), ['tune', []], '17% either way is tuning')
    assert.deepEqual(kind({ op: 'set', key: 'harness.demotion_days', value: 30 }), ['weaken', ['A1']], 'demoting sooner, past the bound')
    assert.deepEqual(kind({ op: 'set', key: 'harness.demotion_days', value: 120 }), ['other', []], 'past the bound in the stricter direction: proposed')
    assert.deepEqual(kind({ op: 'set', key: 'harness.load_budget', value: 6000 }), ['weaken', ['A1']], 'a larger budget trims less')
    assert.deepEqual(kind({ op: 'enable', id: 'D2' }), ['strengthen', []])
    assert.deepEqual(kind({ op: 'disable', id: 'D1' }), ['weaken', ['A1']])
    assert.deepEqual(kind({ op: 'autonomy', value: 'tune-itself' }), ['widen', ['A1']])
    assert.deepEqual(kind({ op: 'autonomy', value: 'ask-first' }), ['narrow', []])
    assert.deepEqual(kind({ op: 'note', text: 'push to main automatically once the tests pass' }), ['forbidden', ['A4']])
    assert.deepEqual(kind({ op: 'note', text: 'send the weekly email without asking' }), ['forbidden', ['A4']])
    assert.deepEqual(kind({ op: 'note', text: 'delete the old catches to keep the log short' }), ['forbidden', ['A2']])
    assert.deepEqual(kind({ op: 'note', text: 'relax the constitution for this repository' }), ['forbidden', ['A5']])
    assert.deepEqual(kind({ op: 'note', text: 'reword the close-out question about rules' }), ['other', []])
    assert.equal(classify({ op: 'set', key: 'harness.anything', value: 1 }, d).kind, 'invalid')
    assert.equal(classify({ op: 'enable', id: 'D1' }, d).kind, 'invalid', 'already in force')
  })
})

describe('the constitution holds under "Tune itself"', () => {
  test('POSITIVE CONTROL: an agent change that weakens enforcement is not applied; it becomes a proposal', async () => {
    await put('docs/rules/active/seen-to-fail.md', '# seen-to-fail\n\n**Trigger:** x.\n\n**Rule:** y.\n\n**Precedent:** DEF-521.\n\n**Enforcement:** memory\n\n**Default:** D2, active since 2026-10-01\n')
    const d = doc({ 'harness.autonomy': 'tune-itself', 'harness.defaults': ['D1', 'D2'] })
    for (const change of [{ op: 'disable', id: 'D2' }, { op: 'set', key: 'harness.demotion_days', value: 30 }]) {
      const r = await propose(d, change)
      assert.equal(r.applied, false, JSON.stringify(change))
      assert.match(r.why, /needs a human: Any change that weakens enforcement/)
    }
    assert.deepEqual(d.answers['harness.defaults'], ['D1', 'D2'], 'nothing changed')
    assert.equal(d.answers['harness.demotion_days'], undefined)
    assert.ok(await exists('docs/rules/active/seen-to-fail.md'))
    assert.deepEqual(changes(await readLog(root)).map((c) => c.state), ['proposed', 'proposed'])
  })

  test('POSITIVE CONTROL: a forbidden change is refused, and nothing is logged', async () => {
    await assert.rejects(propose(doc({ 'harness.autonomy': 'tune-itself' }), { op: 'note', text: 'publish releases automatically' }), { code: 'FORBIDDEN' })
    assert.equal(await exists(HARNESS_LOG), false)
  })

  test('POSITIVE CONTROL: tuning within 25% applies on its own, once a week per mechanism; under "Ask me first" it waits', async () => {
    const d = doc({ 'harness.autonomy': 'tune-itself' })
    const first = await propose(d, { op: 'set', key: 'harness.load_budget', value: 3500 })
    assert.equal(first.applied, true, first.why)
    assert.equal(d.answers['harness.load_budget'], 3500)
    const second = await propose(d, { op: 'set', key: 'harness.load_budget', value: 3200 }, { now: new Date('2026-11-03T00:00:00Z') })
    assert.equal(second.applied, false)
    assert.match(second.why, /once a week is the bound/)
    const other = await propose(d, { op: 'set', key: 'authority.retest_days', value: 33 }, { now: new Date('2026-11-03T00:00:00Z') })
    assert.equal(other.applied, true, 'another mechanism has its own week')
    const asked = doc({ 'harness.autonomy': 'ask-first' })
    assert.equal((await propose(asked, { op: 'enable', id: 'D3' })).applied, false)
  })

  test('POSITIVE CONTROL: a change needs local evidence and a signal to improve', async () => {
    await assert.rejects(proposeChange({ root, doc: doc(), change: { op: 'enable', id: 'D3' }, evidence: 'it seems wise', signal: 'load-words' }), { code: 'NO_EVIDENCE' })
    await assert.rejects(proposeChange({ root, doc: doc(), change: { op: 'enable', id: 'D3' }, evidence: EV, signal: 'vibes' }), { code: 'NO_SIGNAL' })
  })
})

describe('a human applies the rest', () => {
  test('POSITIVE CONTROL: only at a terminal; taking a default out of force moves its rule to candidates, never deletes it; the log only grows', async () => {
    await put('docs/rules/active/seen-to-fail.md', '# seen-to-fail\n\n**Trigger:** x.\n\n**Rule:** y.\n\n**Precedent:** DEF-521.\n\n**Enforcement:** memory\n\n**Default:** D2, active since 2026-10-01\n')
    const d = doc({ 'harness.defaults': ['D1', 'D2'] })
    const r = await propose(d, { op: 'disable', id: 'D2' })
    const before = await readFile(join(root, HARNESS_LOG), 'utf8')
    await assert.rejects(applyChange({ root, doc: d, id: r.id, by: 'human' }), { code: 'NOT_INTERACTIVE' })
    const applied = await applyChange({ root, doc: d, id: r.id, by: 'human', interactive: true, now: new Date('2026-10-31') })
    assert.equal(applied.baseline.signal, 'load-words')
    assert.ok(Number.isFinite(applied.baseline.value))
    assert.deepEqual(d.answers['harness.defaults'], ['D1'])
    assert.ok(!(await exists('docs/rules/active/seen-to-fail.md')) && (await exists('docs/rules/candidates/seen-to-fail.md')))
    const after = await readFile(join(root, HARNESS_LOG), 'utf8')
    assert.ok(after.startsWith(before), 'append-only: every earlier line is still there, unchanged')

    const r2 = await propose(d, { op: 'enable', id: 'D3' })
    await rejectChange({ root, id: r2.id, interactive: true })
    assert.deepEqual(changes(await readLog(root)).map((c) => [c.id, c.state]), [['H-001', 'applied'], ['H-002', 'rejected']])
    await assert.rejects(applyChange({ root, doc: d, id: r2.id, interactive: true }), { code: 'NOT_PROPOSED' })
  })
})

describe('did it help', () => {
  const log = (applied, extra = {}) => [
    { type: 'proposed', id: 'H-001', at: '2026-09-01T00:00:00Z', change: { op: 'set', key: 'harness.load_budget', from: 3000, value: 3600 }, signal: 'load-words', window: 30, ...extra },
    { type: 'applied', id: 'H-001', at: applied, by: 'human', baseline: { signal: 'load-words', value: 2274 } },
  ]

  test('POSITIVE CONTROL: after its window, a change that did not move its signal is one to revert; one that did, or that is too young, is not', () => {
    const now = new Date('2026-10-31T00:00:00Z')
    const worse = evaluateChanges(log('2026-09-01T00:00:00Z'), { 'load-words': 2400 }, now)
    assert.deepEqual(worse.map((e) => [e.id, e.helped]), [['H-001', false]])
    const audit = runChecks({ harnessChanges: worse }, { only: ['harness-changes-helped'] })
    assert.match(audit.findings[0].message, /harness change H-001 was to improve load-words; it was 2274 and after its window it is 2400/)
    assert.match(audit.findings[0].hint, /caselaw harness revert H-001/)
    assert.deepEqual(evaluateChanges(log('2026-09-01T00:00:00Z'), { 'load-words': 2000 }, now).map((e) => e.helped), [true])
    assert.deepEqual(evaluateChanges(log('2026-10-20T00:00:00Z'), { 'load-words': 2400 }, now), [], 'inside its window')
  })

  test('a reverted change is not asked about again, and the revert of an enable is a weakening', () => {
    const now = new Date('2026-10-31T00:00:00Z')
    const reverted = [...log('2026-09-01T00:00:00Z'),
      { type: 'proposed', id: 'H-002', at: '2026-10-02T00:00:00Z', change: { op: 'set', key: 'harness.load_budget', from: 3600, value: 3000 }, signal: 'load-words', window: 30, reverts: 'H-001' },
      { type: 'applied', id: 'H-002', at: '2026-10-02T00:00:00Z', by: 'human', baseline: { signal: 'load-words', value: 2400 } }]
    const e = evaluateChanges(reverted, { 'load-words': 2400 }, now)
    assert.equal(runChecks({ harnessChanges: e }, { only: ['harness-changes-helped'] }).findings.length, 0)
    assert.deepEqual(reverseOf({ id: 'H-9', change: { op: 'enable', id: 'D3' } }), { op: 'disable', id: 'D3' })
    assert.equal(classify({ op: 'disable', id: 'D3' }, doc({ 'harness.defaults': ['D3'] })).kind, 'weaken')
  })
})

describe('at the command line', () => {
  test('POSITIVE CONTROL: `harness apply` is refused to a caller that is not a human at a terminal', async () => {
    const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
    const d = doc({ 'harness.defaults': ['D1'] })
    await put('.caselaw/answers.json', JSON.stringify(d))
    await propose(d, { op: 'disable', id: 'D1' })
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'harness', 'apply', 'H-001', '--yes'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (x) => (out += x))
      child.stderr.on('data', (x) => (out += x))
      child.on('close', (code) => resolve({ code, out }))
      child.stdin.end('')
    })
    assert.equal(r.code, 1)
    assert.match(r.out, /a human's call/)
    assert.deepEqual(changes(await readLog(root)).map((c) => c.state), ['proposed'])
  })
})
