import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runChecks, CHECKS, SEVERITY } from '../../src/audit/checks.js'
import { gather, parseAuthority } from '../../src/audit/gather.js'
import { formatReport, toJson, agentPrompt } from '../../src/audit/report.js'

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-audit-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel, content) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const commit = () => {
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: root })
}

/** A minimal context; individual tests override the slice they care about. */
const ctx = (over = {}) => ({
  root, now: new Date('2026-08-13T00:00:00Z'),
  rules: { active: [], proposed: [], candidates: [] },
  gatesConfig: { version: 1, gates: [] },
  docRefs: [], untracked: [], docTexts: {}, staleCommands: [],
  fireCounts: {}, drifted: [], authority: null, answers: null,
  adrs: null, gitignoreClaims: [], installAgeDays: 100, installed: true,
  ...over,
})

describe('audit — the checks fire on what they claim to', () => {
  test('POSITIVE CONTROL: a pointer to a missing file is an error', () => {
    const r = runChecks(ctx({ docRefs: [{ from: 'CLAUDE.md', target: 'docs/gone.md', exists: false }] }))
    assert.equal(r.ok, false)
    assert.equal(r.findings[0].code, 'refs-resolve')
  })

  test('POSITIVE CONTROL: an untracked doctrine file is an error', () => {
    const r = runChecks(ctx({ untracked: ['docs/authority-split.md'] }))
    assert.equal(r.ok, false)
    assert.match(r.findings[0].hint, /survives exactly as long as this machine/)
  })

  test('POSITIVE CONTROL: a rule with no Origin is an error', () => {
    const r = runChecks(ctx({ rules: { active: [{ name: 'r', file: 'f', origin: '' }], proposed: [], candidates: [] } }))
    assert.ok(r.findings.some((f) => f.code === 'origin-resolves'))
  })

  test('POSITIVE CONTROL: an overdue boundary re-check is an error', () => {
    const r = runChecks(ctx({ authority: { file: 'a.md', retestDue: '2026-01-01', untested: [] } }))
    assert.ok(r.findings.some((f) => f.code === 'authority-retest' && f.severity === SEVERITY.ERROR))
  })

  test('POSITIVE CONTROL: an expired grandfather entry is reported', () => {
    const r = runChecks(ctx({
      gatesConfig: { version: 1, gates: [{ id: 'g', grandfather: [{ expires: '2020-01-01', reason: 'legacy' }] }] },
    }))
    assert.ok(r.findings.some((f) => f.code === 'grandfather-expiry'))
  })

  test('POSITIVE CONTROL: a warn gate past the threshold is flagged for promotion', () => {
    const r = runChecks(ctx({
      gatesConfig: { version: 1, gates: [{ id: 'g', severity: 'warn' }] },
      fireCounts: { g: 5 },
    }))
    assert.ok(r.findings.some((f) => f.code === 'gates-earned'))
  })

  test('POSITIVE CONTROL: a machine path in doctrine is an error', () => {
    const r = runChecks(ctx({ docTexts: { 'CLAUDE.md': 'see /Users/someone/repo/x' } }))
    assert.ok(r.findings.some((f) => f.code === 'no-machine-paths' && f.severity === SEVERITY.ERROR))
  })

  test('POSITIVE CONTROL: a duplicate decision number is an error', () => {
    const r = runChecks(ctx({
      adrs: { dir: 'docs/adrs', hasIndex: true, records: [
        { file: 'docs/adrs/0010-a.md', number: '0010', inIndex: true },
        { file: 'docs/adrs/0010-b.md', number: '0010', inIndex: false },
      ] },
    }))
    assert.ok(r.findings.some((f) => f.code === 'adr-numbering' && f.severity === SEVERITY.ERROR))
    assert.ok(r.findings.some((f) => f.code === 'adr-numbering' && f.severity === SEVERITY.WARN))
  })

  test('POSITIVE CONTROL: a false gitignored claim is an error', () => {
    const r = runChecks(ctx({
      gitignoreClaims: [{ from: 'CLAUDE.md', path: '.claude/settings.json', actuallyIgnored: false }],
    }))
    assert.ok(r.findings.some((f) => f.code === 'claims-verifiable'))
  })

  test('a TRUE gitignored claim is not flagged', () => {
    const r = runChecks(ctx({
      gitignoreClaims: [{ from: 'CLAUDE.md', path: '.env', actuallyIgnored: true }],
    }))
    assert.ok(!r.findings.some((f) => f.code === 'claims-verifiable'))
  })
})

describe('audit — what it must NOT do', () => {
  test('POSITIVE CONTROL: a quiet rule is never reported as dead', () => {
    // A working rule erases its own evidence. Pruning on silence deletes
    // exactly the rules that are doing their job.
    const r = runChecks(ctx({
      rules: { active: [{ name: 'quiet', file: 'f', origin: 'abc1234', missingSubjects: [] }], proposed: [], candidates: [] },
      fireCounts: {},
    }))
    assert.ok(!r.findings.some((f) => f.code === 'dead-rules'))
  })

  test('a rule IS reported when the thing it guards is gone', () => {
    const r = runChecks(ctx({
      rules: { active: [{ name: 'r', file: 'f', origin: 'abc1234', missingSubjects: ['legacy/thing.ts'] }], proposed: [], candidates: [] },
    }))
    assert.ok(r.findings.some((f) => f.code === 'dead-rules' && f.severity === SEVERITY.WARN))
  })

  test('dead-gates stays silent on a young install', () => {
    const young = runChecks(ctx({
      gatesConfig: { version: 1, gates: [{ id: 'g', severity: 'warn' }] },
      fireCounts: {}, installAgeDays: 3,
    }))
    assert.ok(!young.findings.some((f) => f.code === 'dead-gates'), 'a gate needs time to see real work')
  })

  test('POSITIVE CONTROL: a broken check is reported, never counted as passing', () => {
    const exploding = { id: 'boom', describe: 'x', run() { throw new Error('kaboom') } }
    CHECKS.push(exploding)
    try {
      const r = runChecks(ctx())
      assert.equal(r.failed.length, 1)
      assert.match(r.failed[0].reason, /kaboom/)
      assert.match(formatReport(r, ctx()), /BROKEN/)
      assert.match(formatReport(r, ctx()), /not a check that passed/)
    } finally {
      CHECKS.pop()
    }
  })

  test('warnings and notes never fail the run; only errors do', () => {
    const warnOnly = runChecks(ctx({ authority: { file: 'a.md', retestDue: null, untested: [{ label: 'x' }] } }))
    assert.equal(warnOnly.ok, true, 'an audit that fails a build for a warning gets removed from the build')
  })
})

describe('audit — reading a real repo', () => {
  test('parses the re-test date and untested rows out of the generated doc', () => {
    const a = parseAuthority(`# Authority split — P

Generated 2026-08-13. Boundary re-check due **2026-09-12**.

## Unverified boundaries — settle these by 2026-09-12

| Boundary | Assumed because | Settle it |
|---|---|---|
| read production logs | never tried | \`fly logs --no-tail\` |
| deploy | never tried | _no one-liner — try it by hand once_ |

> quote
`, 'docs/authority-split.md')
    assert.equal(a.retestDue, '2026-09-12')
    assert.equal(a.untested.length, 2)
    assert.equal(a.untested[0].settleCommand, 'fly logs --no-tail')
    assert.equal(a.untested[1].settleCommand, null,
      'the italic placeholder is not a command; echoing it back is worse than saying nothing')
  })

  test('POSITIVE CONTROL: a repo with no harness still gets the checks that apply', async () => {
    await put('docs/adrs/0001-a.md', '# one')
    await put('docs/adrs/0001-b.md', '# also one')
    await put('docs/adrs/README.md', '- [0001](0001-a.md)')
    commit()

    const g = await gather(root)
    assert.equal(g.installed, false)
    const r = runChecks(g)
    assert.ok(r.findings.some((f) => f.code === 'adr-numbering'),
      'doc drift is worth finding whether or not the harness is installed')
  })

  test('a root-relative backticked path is not reported as broken', async () => {
    await put('.harness/answers.json', '{}')
    await put('docs/authority-split.md', 'edit `.harness/answers.json`, not this file')
    commit()
    const g = await gather(root)
    const r = runChecks(g)
    assert.ok(!r.findings.some((f) => f.code === 'refs-resolve'),
      'both link conventions must resolve, or the check trains people to ignore it')
  })

  test('a home-relative path is not treated as a repo path', async () => {
    await put('CLAUDE.md', 'see `~/.claude/settings.json`')
    commit()
    const g = await gather(root)
    assert.ok(!runChecks(g).findings.some((f) => f.code === 'refs-resolve'))
  })

  test('gather never throws on an empty or hostile repo', async () => {
    const g = await gather(root)
    assert.ok(g)
    assert.equal(runChecks(g).failed.length, 0)
  })
})

describe('audit — output', () => {
  test('the headline is the mechanisation ratio, and memory is called out', () => {
    const c = ctx({
      rules: {
        active: [
          { name: 'a', file: 'f', origin: 'x', enforcement: { mode: 'machine', gateId: 'g' } },
          { name: 'b', file: 'f', origin: 'x', enforcement: { mode: 'memory' } },
        ],
        proposed: [], candidates: [],
      },
      gatesConfig: { version: 1, gates: [{ id: 'g', origin: 'docs/rules/active/a.md' }] },
    })
    const out = formatReport(runChecks(c), { ...c, projectName: 'P' })
    assert.match(out, /ENFORCEMENT/)
    assert.match(out, /machine\s+1/)
    assert.match(out, /degrades silently/)
  })

  test('the totals agree with the list above them', () => {
    const c = ctx({ docRefs: [{ from: 'a', target: 'b', exists: false }] })
    const out = formatReport(runChecks(c), c)
    assert.match(out, /1 finding · 1 error/,
      'the hidden ratio note must not be counted among the visible findings')
  })

  test('json output is machine-readable and carries the exit decision', () => {
    const c = ctx({ untracked: ['x.md'] })
    const j = toJson(runChecks(c), c)
    assert.equal(j.ok, false)
    assert.ok(j.findings.length > 0)
    assert.ok(j.checksRun.length > 0)
  })

  test('the agent prompt asks for what a program cannot see, and warns against invention', () => {
    const c = ctx()
    const p = agentPrompt(runChecks(c), c)
    assert.match(p, /CONTRADICTION/)
    assert.match(p, /fabricated finding costs more/)
  })
})
