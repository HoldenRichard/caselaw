/**
 * 0.3's defaults: rules in force at install on the study's precedent, that
 * earn this project's own Origin at their first catch here, and that the audit
 * asks about when they have caught nothing in a window of real work.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { parseRule, validateRule, recordCatch, readCatches, demote } from '../../src/core/rules.js'
import { gather } from '../../src/audit/gather.js'
import { runChecks } from '../../src/audit/checks.js'

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'caselaw-defaults-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel, content) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const commit = (date) => {
  execFileSync('git', ['add', '-A'], { cwd: root })
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'x'], { cwd: root, env })
}
const exists = async (p) => { try { await access(join(root, p)); return true } catch { return false } }

const DEFAULT = (since = '2026-01-01', { precedent = 'DEF-216 (Kabu, 2026-08-16) and DEF-748 (caselaw, 2026-10-30).' } = {}) =>
  `# re-derive-claims\n\n**Trigger:** sending a claim out of the project.\n\n**Rule:** re-derive it from the product first; if it does not re-derive, do not send it.\n\n` +
  `**Precedent:** ${precedent}\n\n**Enforcement:** memory\n\n**Default:** D1, active since ${since} (caselaw 0.3)\n`

const codes = (r, c) => r.findings.filter((f) => f.code === c).map((f) => f.message)

describe('a default stands on its precedent until its first catch here', () => {
  test('POSITIVE CONTROL: a default with a Precedent and no Origin is valid; the same rule without its Default line is not', () => {
    const ok = validateRule(parseRule(DEFAULT()), { filename: 're-derive-claims.md', resolveRef: false })
    assert.equal(ok.ok, true, JSON.stringify(ok.problems))
    const notDefault = validateRule(parseRule(DEFAULT().replace(/\*\*Default:\*\*.*\n/, '')), { filename: 're-derive-claims.md', resolveRef: false })
    assert.equal(notDefault.ok, false, 'a precedent alone is not an Origin: only a shipped default may stand on one')
    assert.ok(notDefault.problems.some((p) => p.code === 'missing-section'))
  })

  test('a precedent that cites nothing is warned about', () => {
    const v = validateRule(parseRule(DEFAULT('2026-01-01', { precedent: 'a lot of experience' })), { filename: 're-derive-claims.md', resolveRef: false })
    assert.ok(v.problems.some((p) => p.code === 'origin-unverified' && p.severity === 'warn'))
  })
})

describe('catches', () => {
  test('POSITIVE CONTROL: the first catch writes this project\'s Origin; later catches only add to the log', async () => {
    await put('docs/rules/active/re-derive-claims.md', DEFAULT())
    const first = await recordCatch(root, 're-derive-claims', { what: 'commit abc1234: the README count was carried', by: 't', now: new Date('2026-03-01') })
    assert.equal(first.firstLocal, true)
    const text = await readFile(join(root, 'docs/rules/active/re-derive-claims.md'), 'utf8')
    assert.match(text, /\*\*Origin:\*\* commit abc1234: the README count was carried \(first catch here, recorded 2026-03-01\)/)
    assert.match(text, /\*\*Precedent:\*\* DEF-216/, 'the precedent stays beside the local Origin')

    const second = await recordCatch(root, 're-derive-claims', { what: 'issue #12: a second carried figure', by: 't', now: new Date('2026-03-05') })
    assert.equal(second.firstLocal, false)
    assert.match(await readFile(join(root, 'docs/rules/active/re-derive-claims.md'), 'utf8'), /Origin:\*\* commit abc1234/, 'the first Origin is not overwritten')
    assert.deepEqual((await readCatches(root)).map((c) => [c.rule, c.at, c.firstLocal]), [['re-derive-claims', '2026-03-01', true], ['re-derive-claims', '2026-03-05', false]])
  })

  test('a catch that names nothing anyone can follow is refused', async () => {
    await put('docs/rules/active/re-derive-claims.md', DEFAULT())
    await assert.rejects(recordCatch(root, 're-derive-claims', { what: 'it caught something' }), { code: 'NO_REFERENCE' })
  })
})

describe('demotion', () => {
  test('POSITIVE CONTROL: demoting needs a human, keeps the file, and says why', async () => {
    await put('docs/rules/active/re-derive-claims.md', DEFAULT())
    await assert.rejects(demote(root, 're-derive-claims', {}), { code: 'NOT_INTERACTIVE' })
    assert.ok(await exists('docs/rules/active/re-derive-claims.md'), 'refused means nothing moved')
    const r = await demote(root, 're-derive-claims', { interactive: true, reason: 'no claims leave this project', now: new Date('2026-04-01') })
    assert.equal(r.to, 'docs/rules/candidates/re-derive-claims.md')
    assert.ok(!(await exists('docs/rules/active/re-derive-claims.md')))
    assert.match(await readFile(join(root, r.to), 'utf8'), /_Demoted from active 2026-04-01: no claims leave this project\./)
  })
})

describe('the audit asks about a borrowed rule that has caught nothing', () => {
  test('POSITIVE CONTROL: 60 days and commits since, no catches: asked; a catch, or no commits, or a local Origin: not asked', async () => {
    await put('src/a.js', 'x\n')
    commit('2026-01-02T00:00:00')
    await put('docs/rules/active/re-derive-claims.md', DEFAULT('2026-01-01'))
    await put('src/a.js', 'y\n')
    commit('2026-02-01T00:00:00')
    const now = new Date('2026-03-15')

    const idle = runChecks(await gather(root, { now }), { only: ['borrowed-rules-earn', 'origin-resolves'] })
    assert.equal(codes(idle, 'borrowed-rules-earn').length, 1, JSON.stringify(idle.findings))
    assert.match(codes(idle, 'borrowed-rules-earn')[0], /caught nothing here in 73 days and 2 commit\(s\) since 2026-01-01/)
    assert.deepEqual(codes(idle, 'origin-resolves'), [], 'a default without a local Origin is not an origin error')

    const early = runChecks(await gather(root, { now: new Date('2026-02-15') }), { only: ['borrowed-rules-earn'] })
    assert.deepEqual(codes(early, 'borrowed-rules-earn'), [], 'inside the window')

    await recordCatch(root, 're-derive-claims', { what: 'commit abc1234: caught', now: new Date('2026-03-01') })
    const caught = runChecks(await gather(root, { now }), { only: ['borrowed-rules-earn'] })
    assert.deepEqual(codes(caught, 'borrowed-rules-earn'), [], 'a catch earns it its place, and gives it an Origin')
  })

  test('POSITIVE CONTROL: a logged catch counts even when the rule file lost its Origin (an upgrade rewrote it)', async () => {
    await put('src/a.js', 'x\n')
    commit('2026-01-02T00:00:00')
    await put('docs/rules/active/re-derive-claims.md', DEFAULT('2026-01-01'))
    await put('.caselaw/catches.jsonl', JSON.stringify({ rule: 're-derive-claims', at: '2026-02-01', what: 'commit abc1234', by: 't', firstLocal: true }) + '\n')
    const r = runChecks(await gather(root, { now: new Date('2026-03-15') }), { only: ['borrowed-rules-earn'] })
    assert.deepEqual(codes(r, 'borrowed-rules-earn'), [])
  })

  test('no commits since: nothing to have caught, nothing asked', async () => {
    await put('docs/rules/active/re-derive-claims.md', DEFAULT('2026-05-01'))
    await put('src/a.js', 'x\n')
    commit('2026-01-02T00:00:00')
    const r = runChecks(await gather(root, { now: new Date('2026-09-01') }), { only: ['borrowed-rules-earn'] })
    assert.deepEqual(codes(r, 'borrowed-rules-earn'), [])
  })
})
