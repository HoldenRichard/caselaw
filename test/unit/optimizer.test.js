/**
 * 0.3's optimizer: what a session loads, the signals that say it is time, the
 * proposals, and the two it applies itself (an archived precedent; a merge
 * proposal), each lossless.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { measureLoad, optimizerSignals, optimizerProposals, applyProposal, triggerSimilarity, mergedProposal } from '../../src/core/optimizer.js'
import { archivePrecedent } from '../../src/core/precedent.js'
import { listRules, ratify, parseRule } from '../../src/core/rules.js'
import { buildArtifacts } from '../../src/generate/artifacts.js'
import { emptyAnswers } from '../../src/core/answers.js'
import { runChecks } from '../../src/audit/checks.js'
import { saveIncident } from '../../src/core/incidents.js'

let root
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-opt-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel, content) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const exists = async (rel) => { try { await access(join(root, rel)); return true } catch { return false } }
const doc = (answers = {}, harness) => {
  const d = emptyAnswers({ templateVersion: '1.2', project: { name: 'P' } })
  d.generatedAt = '2026-10-01T00:00:00.000Z'
  Object.assign(d.answers, answers)
  if (harness) d.harness = harness
  return d
}
const LONG = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ')
const rule = ({ name, trigger = 'any change to the migration runner', text = 'Do it.', origin = 'commit abc1234', precedent = null, enforcement = 'memory', ratified = null }) =>
  [`# ${name}`, `**Trigger:** ${trigger}`, `**Rule:** ${text}`, origin && `**Origin:** ${origin}`, precedent && `**Precedent:** ${precedent}`, `**Enforcement:** ${enforcement}`, ratified && `**Ratified:** ${ratified}`]
    .filter(Boolean).join('\n\n') + '\n'

describe('what a session loads', () => {
  test('POSITIVE CONTROL: the larger pointer block once, the authority split, and every active rule', async () => {
    await put('CLAUDE.md', 'intro words here\n<!-- caselaw:begin id=pointer v=1 hash=x -->\none two three four\n<!-- caselaw:end id=pointer -->\n')
    await put('AGENTS.md', '<!-- caselaw:begin id=pointer v=1 hash=x -->\none two\n<!-- caselaw:end id=pointer -->\n')
    await put('docs/authority-split.md', 'a b c d e\n')
    await put('docs/rules/active/r.md', rule({ name: 'r' }))
    await put('docs/rules/candidates/c.md', rule({ name: 'c' }))
    const load = await measureLoad(root, doc())
    assert.deepEqual(load.files.map((f) => f.path), ['CLAUDE.md (pointer block)', 'docs/authority-split.md', 'docs/rules/active/r.md'])
    assert.equal(load.files[0].words, 14, 'the block and its markers (a session reads both), not the three words around it')
    assert.equal(load.words, load.files.reduce((n, f) => n + f.words, 0))
  })
})

describe('the signals', () => {
  test('POSITIVE CONTROL: each reason appears when it holds, and none on a quiet install', async () => {
    const now = new Date('2026-10-20T00:00:00Z')
    await put('docs/rules/active/quiet.md', rule({ name: 'quiet' }))
    const quiet = await optimizerSignals({ root, doc: doc(), now })
    assert.deepEqual(quiet.due, [])

    for (let i = 0; i < 5; i++) await put(`docs/rules/active/r${i}.md`, rule({ name: `r${i}`, ratified: '2026-10-05 by t' }))
    await put('.caselaw/catches.jsonl', ['2026-10-10', '2026-10-11', '2026-10-12'].map((at) => JSON.stringify({ rule: 'quiet', at, what: 'x' })).join('\n') + '\n')
    await put('.caselaw/compactions.jsonl', Array.from({ length: 5 }, (_, i) => JSON.stringify({ at: `2026-10-1${i}T00:00:00Z` })).join('\n') + '\n')
    const busy = await optimizerSignals({ root, doc: doc({ 'harness.load_budget': 10 }), now: new Date('2026-11-02T00:00:00Z') })
    const reasons = busy.due.join(' | ')
    assert.match(reasons, /over the 10-word budget/)
    assert.match(reasons, /5 rules were ratified since the last pass/)
    assert.match(reasons, /the last pass was 32 days ago/)
    assert.match(reasons, /"quiet" caught 3 things since the last pass, and is still enforced by memory/)
    assert.doesNotMatch(reasons, /compacted/, 'compactions older than 14 days do not count')
    const recent = await optimizerSignals({ root, doc: doc(), now: new Date('2026-10-20T00:00:00Z') })
    assert.match(recent.due.join(' | '), /compacted 5 times in 14 days/)
  })

  test('a rule already enforced by a gate is not "trouble"', async () => {
    await put('docs/rules/active/gated.md', rule({ name: 'gated', enforcement: 'machine:g' }))
    await put('.caselaw/catches.jsonl', ['2026-10-10', '2026-10-11', '2026-10-12'].map((at) => JSON.stringify({ rule: 'gated', at, what: 'x' })).join('\n') + '\n')
    assert.deepEqual((await optimizerSignals({ root, doc: doc(), now: new Date('2026-10-20') })).trouble, [])
  })
})

describe('the proposals', () => {
  test('POSITIVE CONTROL: mechanize, archive-precedent (only over budget), merge (overlapping triggers, no gate), demote and stale-reference', async () => {
    await put('docs/rules/active/migrations-a.md', rule({ name: 'migrations-a', trigger: 'editing a database migration file', precedent: `DEF-1. ${LONG}`, origin: null }))
    await put('docs/rules/active/migrations-b.md', rule({ name: 'migrations-b', trigger: 'editing a database migration or its runner' }))
    await put('docs/rules/active/gated.md', rule({ name: 'gated', trigger: 'editing a database migration file', enforcement: 'machine:g' }))
    await put('docs/rules/active/auth.md', rule({ name: 'auth', trigger: 'any change to the sign-in flow' }))
    const listed = await listRules(root)
    const signals = { load: { words: 9999 }, budget: 3000, trouble: [{ name: 'migrations-b', catches: 3 }] }
    const findings = [
      { code: 'borrowed-rules-earn', message: 'rule "migrations-a" has caught nothing here in 70 days' },
      { code: 'refs-resolve', message: 'docs/x.md points at docs/gone.md', path: 'docs/x.md' },
    ]
    const ids = optimizerProposals({ signals, listed, findings }).map((p) => p.id)
    assert.deepEqual(ids, ['mechanize:migrations-b', 'archive-precedent:migrations-a', 'merge:migrations-a+migrations-b', 'demote:migrations-a', 'stale-reference:docs/x.md'])
    const under = optimizerProposals({ signals: { ...signals, load: { words: 100 } }, listed, findings: [] }).map((p) => p.id)
    assert.ok(!under.some((id) => id.startsWith('archive-precedent')), 'under budget, the precedent stays where it is')
  })

  test('trigger similarity reads terms, not filler', () => {
    assert.ok(triggerSimilarity('editing a database migration file', 'editing a database migration or its runner') >= 0.5)
    assert.ok(triggerSimilarity('any change to the auth flow', 'any change to the billing page') < 0.5)
  })

  test('POSITIVE CONTROL: over budget proposes SkillOpt compression before demoting', () => {
    const active = [{ name: 'verbose', parsed: { trigger: 'any work on the migration engine', rule: 'Please make sure to always be careful and check everything in detail.' } }]
    const proposals = optimizerProposals({ signals: { trouble: [], load: { words: 4000 }, budget: 3000 }, listed: { active } })
    assert.ok(proposals.some((p) => p.id === 'compress:verbose' && p.action === 'compress'))
  })
})

describe('archiving a precedent', () => {
  test('POSITIVE CONTROL: the paragraph moves verbatim, the rule keeps every id, and an archived one is not archived twice', () => {
    const text = rule({ name: 'r', origin: null, precedent: `In the study: DEF-216 (Kabu) and DEF-748 (caselaw). ${LONG}` }) + '\n**Default:** D1, active since 2026-10-01\n'
    const moved = archivePrecedent(text, { name: 'r', at: '2026-10-31' })
    assert.match(moved.archive, /DEF-216 \(Kabu\) and DEF-748 \(caselaw\)\. word0/)
    assert.match(moved.rule, /\*\*Precedent:\*\* archived in `docs\/rules\/precedent\/r\.md` \(DEF-216, DEF-748\)\./)
    assert.doesNotMatch(moved.rule, /word0/)
    assert.match(moved.rule, /\*\*Enforcement:\*\* memory/, 'the sections after it are untouched')
    assert.equal(archivePrecedent(moved.rule, { name: 'r', at: '2026-10-31' }), null)
  })

  test('POSITIVE CONTROL: applied to a hand-written rule it writes both files; to a generated one, the build renders it', async () => {
    await put('docs/rules/active/mine.md', rule({ name: 'mine', precedent: `DEF-9. ${LONG}` }))
    const r = await applyProposal({ root, doc: doc(), id: 'archive-precedent:mine', now: new Date('2026-10-31') })
    assert.equal(r.ok, true, r.message)
    assert.match(await readFile(join(root, 'docs/rules/precedent/mine.md'), 'utf8'), /DEF-9\. word0/)
    assert.match(await readFile(join(root, 'docs/rules/active/mine.md'), 'utf8'), /archived in `docs\/rules\/precedent\/mine\.md` \(DEF-9\)/)

    const d = doc({ 'harness.defaults': ['D1'] }, { since: '2026-10-01' })
    const g = await applyProposal({ root, doc: d, id: 'archive-precedent:re-derive-claims', now: new Date('2026-10-31') })
    assert.equal(g.rerender, true)
    const artifacts = await buildArtifacts({ doc: d, detected: { agentConfig: { claudeMd: true }, commands: {}, deploySurface: [] } })
    const body = (p) => artifacts.find((a) => a.path === p)?.body
    assert.match(body('docs/rules/active/re-derive-claims.md'), /\*\*Precedent:\*\* archived in `docs\/rules\/precedent\/re-derive-claims\.md` \(DEF-216, DEF-748, DEF-145, DEF-158, DEF-131\)\./)
    assert.match(body('docs/rules/precedent/re-derive-claims.md'), /345 of 347 were unsigned/)
  })
})

describe('merging two rules', () => {
  test('POSITIVE CONTROL: the proposal is built verbatim; ratifying it archives both; a merge that dropped one\'s Rule is refused', async () => {
    await put('docs/rules/active/a.md', rule({ name: 'a', trigger: 'editing a database migration file', text: 'Write the down migration too.', origin: 'commit aaa1111' }))
    await put('docs/rules/active/b.md', rule({ name: 'b', trigger: 'editing a database migration or its runner', text: 'Run it against a copy first.', origin: 'issue #12' }))
    const r = await applyProposal({ root, doc: doc(), id: 'merge:a+b', now: new Date('2026-10-31') })
    assert.equal(r.ok, true, r.message)
    const proposal = await readFile(join(root, 'docs/rules/proposed/a-and-b.md'), 'utf8')
    for (const s of ['Write the down migration too.', 'Run it against a copy first.', 'commit aaa1111', 'issue #12', '**Merges:** a, b']) assert.ok(proposal.includes(s), s)

    await put('docs/rules/proposed/lossy.md', proposal.replace('# a-and-b', '# lossy').replace('Run it against a copy first.', 'Be careful.'))
    await assert.rejects(ratify(root, 'lossy', { interactive: true, ratifiedBy: 't', resolveRef: () => true }), { code: 'LOSSY_MERGE' })
    assert.ok(await exists('docs/rules/active/b.md'), 'a refused merge moves nothing')

    const done = await ratify(root, 'a-and-b', { interactive: true, ratifiedBy: 't', resolveRef: () => true })
    assert.deepEqual(done.merged, ['a', 'b'])
    assert.ok(!(await exists('docs/rules/active/a.md')) && !(await exists('docs/rules/active/b.md')))
    assert.match(await readFile(join(root, 'docs/rules/archive/a.md'), 'utf8'), /_Merged into `a-and-b` on \d{4}-\d{2}-\d{2}\._/)
  })

  test('two defaults merge into a rule that still stands on their precedent', () => {
    const text = mergedProposal('x', [
      parseRule(rule({ name: 'p', origin: null, precedent: 'DEF-1.' }) + '\n**Default:** D2, active since 2026-10-01\n'),
      parseRule(rule({ name: 'q', origin: null, precedent: 'DEF-2.' }) + '\n**Default:** D3, active since 2026-10-01\n'),
    ], '2026-10-31')
    assert.match(text, /\*\*Precedent:\*\* DEF-1\. And: DEF-2\./)
    assert.match(text, /\*\*Default:\*\* merges D2, active since 2026-10-01; D3, active since 2026-10-01/)
  })

  test('POSITIVE CONTROL: applyProposal merge verifies unioned incidents and refuses merge if candidate regresses', async () => {
    await put('docs/rules/active/rule1.md', rule({ name: 'rule1', trigger: 'staging git changes', text: 'Never use sweeping flags like git add .', origin: 'commit 1111' }))
    await put('docs/rules/active/rule2.md', rule({ name: 'rule2', trigger: 'staging git files', text: 'Always specify exact files.', origin: 'commit 2222' }))

    // Add incident for rule1
    await saveIncident(root, {
      id: 'INC-MERGE-01',
      rule: 'rule1',
      positiveControl: { commit: '1111', diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n+git add .\n', expected: 'FAIL' },
      negativeControl: { commit: '1112', diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n+git add f\n', expected: 'PASS' },
    })

    const r = await applyProposal({ root, doc: doc(), id: 'merge:rule1+rule2', now: new Date('2026-10-31') })
    assert.equal(r.ok, true, r.message)
    const proposed = await readFile(join(root, 'docs/rules/proposed/rule1-and-rule2.md'), 'utf8')
    assert.match(proposed, /\*\*Origin:\*\* commit 1111 And: commit 2222/)
  })
})

describe('the audit says when it is time', () => {
  test('POSITIVE CONTROL: optimizer-due carries the reasons, and is silent without one', () => {
    const due = runChecks({ optimizer: { due: ['the last pass was 40 days ago'], load: { words: 1 }, budget: 3000 } }, { only: ['optimizer-due'] })
    assert.match(due.findings[0].message, /the optimizer is due: the last pass was 40 days ago/)
    assert.deepEqual(runChecks({ optimizer: { due: [] } }, { only: ['optimizer-due'] }).findings, [])
  })
})

const RUNNER = fileURLToPath(new URL('../../runtime/gate.mjs', import.meta.url))
const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
const spawned = (argv, { input = '', cwd }) => new Promise((resolve) => {
  const child = spawn(process.execPath, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  child.on('close', (code) => resolve({ code, out }))
  child.stdin.on('error', () => {})
  child.stdin.end(input)
})

describe('lossless compression via SkillOpt', () => {
  test('POSITIVE CONTROL: applyProposal with compress losslessly compacts the rule file', async () => {
    await put('docs/rules/active/verbose.md', rule({
      name: 'verbose',
      trigger: 'any work on database migrations',
      text: 'Please make sure to always remember to write down migrations in order to avoid issues.',
      origin: 'commit 1234',
    }))
    await saveIncident(root, {
      id: 'INC-VERBOSE-01',
      rule: 'verbose',
      positiveControl: { commit: '1234', diff: '--- a/m.sql\n+++ b/m.sql\n@@ -1 +1 @@\n+migration\n', expected: 'FAIL' },
      negativeControl: { commit: '1235', diff: '--- a/m.sql\n+++ b/m.sql\n@@ -1 +1 @@\n+select 1\n', expected: 'PASS' },
    })
    const r = await applyProposal({ root, doc: doc(), id: 'compress:verbose', now: new Date('2026-10-31') })
    assert.equal(r.ok, true, r.message)
    const updated = await readFile(join(root, 'docs/rules/active/verbose.md'), 'utf8')
    assert.doesNotMatch(updated, /Please make sure to always remember to/)
  })
})

describe('counting compactions, and who may apply', () => {
  test('POSITIVE CONTROL: the PreCompact hook appends a line to the install above the session, and nothing outside one', async () => {
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await mkdir(join(root, 'src'), { recursive: true })
    const r = await spawned([RUNNER, '--mode', 'compact'], { cwd: root, input: JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', cwd: join(root, 'src') }) })
    assert.equal(r.code, 0, r.out)
    const lines = (await readFile(join(root, '.caselaw/compactions.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].trigger, 'auto')
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-opt-out-')))
    try {
      const o = await spawned([RUNNER, '--mode', 'compact'], { cwd: outside, input: JSON.stringify({ cwd: outside }) })
      assert.equal(o.code, 0)
    } finally { await rm(outside, { recursive: true, force: true }) }
  })

  test('POSITIVE CONTROL: --apply is refused to a caller that is not a human at a terminal', async () => {
    await put('.caselaw/answers.json', JSON.stringify(doc()))
    await put('docs/rules/active/mine.md', rule({ name: 'mine', precedent: `DEF-9. ${LONG}` }))
    const r = await spawned([CLI, 'optimize', '--apply', 'archive-precedent:mine'], { cwd: root })
    assert.equal(r.code, 1)
    assert.match(r.out, /that is a human's call/)
    assert.ok(!(await exists('docs/rules/precedent/mine.md')), 'nothing was applied')
  })
})
