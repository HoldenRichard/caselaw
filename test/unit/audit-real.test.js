/**
 * The audit, run against real gather() output.
 *
 * Every earlier audit test built its context by hand, in the shape the checks
 * expected. Production's gather() emitted a different one — the rule's content
 * lived under .parsed, its problems under .validation, and .file was a bare
 * basename — so on a real repository every active rule reported "has no
 * Origin", the mechanisation ratio was always 100% memory, every committed
 * rule file was reported untracked, and dead-rules, proposed-backlog and
 * enforcement-truth could never fire. The tests were green. Nobody had watched
 * these checks fail on data the gatherer actually produced.
 *
 * So the fixtures here go through the real gatherer, and one test pins the
 * contract between what gather() emits and what the checks read.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gather, parseEnforcement } from '../../src/audit/gather.js'
import { runChecks } from '../../src/audit/checks.js'
import { propose } from '../../src/core/rules.js'
import { buildReviewPrompt } from '../../src/commands/review.js'
import { agentPrompt } from '../../src/audit/report.js'

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'caselaw-audit-real-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel, content) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const commit = () => {
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'x'], { cwd: root })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

const RULE = ({ name, trigger = 'any change to `src/index.js`', rule = 'Do the thing. If the check fails, stop and ask.', origin, enforcement = 'memory', ratified = '2026-01-01 by t' }) =>
  `# ${name}\n\n**Trigger:** ${trigger}\n\n**Rule:** ${rule}\n\n**Origin:** ${origin}\n\n**Enforcement:** ${enforcement}\n\n**Ratified:** ${ratified}\n`

const codes = (r, c) => r.findings.filter((f) => f.code === c).map((f) => f.message)

describe('audit — real gather() output', () => {
  test('POSITIVE CONTROL: gather() emits the shape the checks read', async () => {
    await put('src/index.js', 'export const x = 1\n')
    const sha = commit()
    await put('docs/rules/active/alpha.md', RULE({ name: 'alpha', origin: `commit ${sha} — the base commit.`, enforcement: 'machine:some-gate' }))
    commit()

    const ctx = await gather(root)
    const r = ctx.rules.active[0]
    for (const k of ['name', 'file', 'path', 'origin', 'trigger', 'rule', 'enforcement', 'problems', 'ageDays', 'unresolvedRefs', 'missingSubjects']) {
      assert.ok(k in r, `gather() must emit "${k}" — a check reads it`)
    }
    assert.equal(r.file, 'docs/rules/active/alpha.md', 'file is the repo-relative path the checks hand to git and stat()')
    assert.equal(r.basename, 'alpha.md')
    assert.deepEqual(r.enforcement, { mode: 'machine', gateId: 'some-gate', raw: 'machine:some-gate' })
    assert.equal(r.origin, `commit ${sha} — the base commit.`)
    assert.equal(r.trigger, 'any change to `src/index.js`')
    assert.ok(Array.isArray(r.problems))
    assert.ok(Number.isFinite(r.ageDays), 'ageDays comes from stat() on the real path')
  })

  test('parseEnforcement reads the three rungs and nothing else', () => {
    assert.deepEqual(parseEnforcement('memory'), { mode: 'memory', gateId: null, raw: 'memory' })
    assert.deepEqual(parseEnforcement('machine:no-em-dash'), { mode: 'machine', gateId: 'no-em-dash', raw: 'machine:no-em-dash' })
    assert.deepEqual(parseEnforcement(' Checklist '), { mode: 'checklist', gateId: null, raw: 'Checklist' })
    assert.equal(parseEnforcement(''), null)
    assert.equal(parseEnforcement(undefined), null)
  })

  test('POSITIVE CONTROL: the checks fire on real rule files, and stay quiet on a clean one', async () => {
    await put('src/index.js', 'export const x = 1\n')
    const sha = commit()

    // (a) real Origin SHA + a machine: claim for a gate that does not exist
    await put('docs/rules/active/alpha-rule.md', RULE({ name: 'alpha-rule', origin: `commit ${sha} — the base commit.`, enforcement: 'machine:no-such-gate' }))
    // (b) Trigger names a backticked path that does not exist
    await put('docs/rules/active/beta-rule.md', RULE({ name: 'beta-rule', trigger: 'any change to `src/gone/missing-file.js`', origin: 'session 2026-02-02 — a documented incident.' }))
    // (c) an Origin citing a SHA this repository does not contain
    await put('docs/rules/active/delta-rule.md', RULE({ name: 'delta-rule', origin: 'commit deadbeefcafe1234567890abcdef1234567890ab — an incident.' }))
    // (d) a clean rule: real origin, checklist, existing trigger path
    await put('docs/rules/active/gamma-rule.md', RULE({ name: 'gamma-rule', origin: `commit ${sha} — the base commit.`, enforcement: 'checklist' }))
    // (e) a proposal older than the 21-day backlog threshold, written through the real API
    await propose(root, { name: 'epsilon-rule', trigger: 'any change to `src/index.js`', rule: 'Do a fifth thing. If the check fails, stop and ask.', origin: 'session 2026-03-03 — an incident.' })
    commit()
    const now = new Date()
    const old = new Date(now.getTime() - 400 * 86400000)
    await utimes(join(root, 'docs/rules/proposed/epsilon-rule.md'), old, old)

    const ctx = await gather(root, { now })
    const r = runChecks(ctx)

    // committed rule files must never be reported as untracked (the basename bug)
    assert.deepEqual(codes(r, 'doctrine-tracked'), [])
    // a rule citing a real commit, or a dated session, has an Origin
    assert.ok(!codes(r, 'origin-resolves').some((m) => /"alpha-rule" has no Origin/.test(m)))
    assert.ok(!codes(r, 'origin-resolves').some((m) => /"beta-rule" has no Origin/.test(m)))
    assert.ok(!codes(r, 'origin-resolves').some((m) => /"gamma-rule"/.test(m)), 'the clean rule is silent')
    // the unresolved-SHA branch fires
    assert.ok(codes(r, 'origin-resolves').some((m) => /delta-rule/.test(m) && /deadbeefcafe/.test(m)))
    // the ratio counts rungs from the Enforcement line
    assert.match(codes(r, 'mechanization-ratio')[0] ?? '', /4 active rule\(s\): 1 machine \(25%\), 1 checklist, 2 memory/)
    // a claimed gate that does not exist
    assert.ok(codes(r, 'enforcement-truth').some((m) => /alpha-rule/.test(m) && /no-such-gate/.test(m)))
    // a trigger whose subject is gone
    assert.ok(codes(r, 'dead-rules').some((m) => /beta-rule/.test(m) && /missing-file\.js/.test(m)))
    assert.ok(!codes(r, 'dead-rules').some((m) => /gamma-rule/.test(m)), 'a rule whose subject exists is not dead')
    // a proposal nobody has decided on
    assert.ok(codes(r, 'proposed-backlog').some((m) => /epsilon-rule/.test(m)))
  })

  test('POSITIVE CONTROL: a committed rule file is not reported as untracked', async () => {
    await put('docs/rules/active/one-writer.md', RULE({ name: 'one-writer', trigger: 'any change to the migration runner', origin: '2026-08-01 — the double-write incident.' }))
    commit()
    const g = await gather(root)
    assert.deepEqual(g.untracked, [], `a committed rule was collected as untracked: ${JSON.stringify(g.untracked)}`)
    assert.deepEqual(codes(runChecks(g), 'doctrine-tracked'), [])
  })

  test('POSITIVE CONTROL: a gitignore claim about a dash-prefixed path is checked, not silently dropped', async () => {
    // gather passed the doc's path to `git check-ignore` with no `--`, so a path
    // that starts with a dash was parsed as an option: git exited 129, and the
    // claim was dropped without a word. The doc said the file was gitignored;
    // it was committed; the audit said nothing.
    await put('-p/x.md', 'tracked\n')
    await put('docs/authority-split.md', '# Authority split\n\nThe scratch note `-p/x.md` is gitignored.\n')
    commit()
    const g = await gather(root)
    assert.ok(g.gitignoreClaims.some((c) => c.path === '-p/x.md' && c.actuallyIgnored === false),
      `the claim must be checked and found false: ${JSON.stringify(g.gitignoreClaims)}`)
    assert.ok(codes(runChecks(g), 'claims-verifiable').some((m) => /-p\/x\.md/.test(m)))
  })

  test('the review prompt and the agent prompt see the rule, not "undefined"', async () => {
    await put('src/index.js', 'export const x = 1\n')
    const sha = commit()
    await put('docs/rules/active/alpha.md', RULE({ name: 'alpha', origin: `commit ${sha}`, enforcement: 'machine:some-gate' }))
    commit()
    const ctx = await gather(root)
    const review = buildReviewPrompt({ root, detected: {}, answers: null, rules: ctx.rules, gatesConfig: ctx.gatesConfig })
    assert.match(review, /- alpha — Trigger: any change to `src\/index\.js` — Enforcement: machine:some-gate/)
    assert.doesNotMatch(review, /undefined/)
    const agent = agentPrompt(runChecks(ctx), ctx)
    assert.match(agent, /- alpha: any change to `src\/index\.js`/)
    assert.doesNotMatch(agent, /undefined/)
  })
})
