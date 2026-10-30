/**
 * 0.3's review roles: a refuter, a verifier and a judge, each given the change
 * and its claim and never the builder's reasoning, each returning an explicit
 * verdict.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { buildRolePrompt, parseVerdict, MAX_CLAIM } from '../../src/commands/review.js'

const DIFF = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-export const limit = 10\n+export const limit = 20\n'
const CLAIM = 'Raises the page limit to 20 without changing the default sort.'
const ANSWERS = { answers: { 'authority.cannot': ['device'], 'authority.triage': { device: 'physical' } } }

describe('the three prompts', () => {
  test('POSITIVE CONTROL: each carries the claim, the change, the project\'s boundaries and its own verdict contract', () => {
    for (const [role, verdicts] of [['refuter', ['PASS', 'FAIL']], ['verifier', ['PASS', 'FAIL']]]) {
      const p = buildRolePrompt({ role, claim: CLAIM, diff: DIFF, answers: ANSWERS, builder: 'Claude Opus 5.5' })
      assert.match(p, new RegExp(`You are the ${role.toUpperCase()}`))
      assert.ok(p.includes(CLAIM) && p.includes('+export const limit = 20'))
      assert.match(p, /- device \(physical\)/)
      assert.match(p, /the change was built by Claude Opus 5\.5/)
      assert.match(p, /You are not given why its author believed it works, on purpose/)
      for (const v of verdicts) assert.match(p, new RegExp(`VERDICT: ${v}`))
      assert.doesNotMatch(p, /ESCALATE/, 'only the judge may escalate')
    }
    assert.match(buildRolePrompt({ role: 'verifier', claim: CLAIM, diff: DIFF }), /say what you did not cover/)
    assert.match(buildRolePrompt({ role: 'refuter', claim: CLAIM, diff: DIFF }), /a concrete failing case/)
  })

  test('POSITIVE CONTROL: no claim, an argument for a claim, or no change: refused', () => {
    assert.throws(() => buildRolePrompt({ role: 'refuter', claim: '', diff: DIFF }), /--claim/)
    assert.throws(() => buildRolePrompt({ role: 'refuter', claim: 'x'.repeat(MAX_CLAIM + 1), diff: DIFF }), /why the builder believes it is exactly what a reviewer must not be given/)
    assert.throws(() => buildRolePrompt({ role: 'refuter', claim: CLAIM, diff: '' }), /the diff is empty/)
    assert.throws(() => buildRolePrompt({ role: 'cheerleader', claim: CLAIM, diff: DIFF }), /--role is one of/)
  })

  test('a long change is cut, and the prompt says so', () => {
    const p = buildRolePrompt({ role: 'refuter', claim: CLAIM, diff: DIFF + 'x'.repeat(70_000), truncated: true })
    assert.match(p, /cut at 60000 characters: say that you did not see the rest/)
  })
})

describe('verdicts', () => {
  test('POSITIVE CONTROL: the verdict is the first line or there is none', () => {
    assert.deepEqual(parseVerdict('\n  VERDICT: fail\n- src/a.js:1 breaks the sort'), { verdict: 'FAIL', body: '- src/a.js:1 breaks the sort' })
    assert.equal(parseVerdict('VERDICT: ESCALATE\nlook at the device').verdict, 'ESCALATE')
    assert.equal(parseVerdict('Looks good to me.\nVERDICT: PASS').verdict, null, 'a verdict after an opinion is not a verdict line')
    assert.equal(parseVerdict('').verdict, null)
    assert.equal(parseVerdict('On balance my VERDICT: PASS').verdict, null, 'the line is the verdict, not a sentence that mentions one')
  })

  test('POSITIVE CONTROL: a judge is built on two explicit verdicts, and refused without one', () => {
    const judge = buildRolePrompt({ role: 'judge', claim: CLAIM, diff: DIFF, reviews: { refuter: 'VERDICT: FAIL\n- src/a.js:1 the sort changes', verifier: 'VERDICT: PASS\n- npm test: 41 passed' } })
    assert.match(judge, /## The refuter's review \(VERDICT: FAIL\)\n\n- src\/a\.js:1 the sort changes/)
    assert.match(judge, /## The verifier's review \(VERDICT: PASS\)/)
    assert.match(judge, /VERDICT: ESCALATE/)
    assert.throws(() => buildRolePrompt({ role: 'judge', claim: CLAIM, diff: DIFF, reviews: { refuter: 'It seems fine.', verifier: 'VERDICT: PASS' } }), /The refuter's review has no VERDICT line first/)
  })
})

describe('at the command line', () => {
  let root
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'caselaw-review-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    await writeFile(join(root, 'a.js'), 'export const limit = 10\n')
    execFileSync('git', ['add', 'a.js'], { cwd: root })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'the builder explains at length why this is right'], { cwd: root })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: root, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
    child.stdin.end('')
  })

  test('POSITIVE CONTROL: the working change goes in, the commit message never does; no change is refused', async () => {
    const none = await run(['review', '--role', 'refuter', '--claim', CLAIM])
    assert.equal(none.code, 2)
    assert.match(none.out, /the diff is empty/)
    await writeFile(join(root, 'a.js'), 'export const limit = 20\n')
    const r = await run(['review', '--role', 'refuter', '--claim', CLAIM])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /\+export const limit = 20/)
    assert.doesNotMatch(r.out, /explains at length/)
  })
})
