/**
 * Dedicated positive controls for adversarial audit findings F1 - F13.
 *
 * Verifies that all 13 attack vectors identified by independent verification
 * are permanently sealed and protected by positive controls:
 *
 * F1: Non-interactive evolution cannot loosen a constraint (Axiom A1)
 * F2: Empty LLM responses return UNVERIFIED and fail Stage 2
 * F3: Gate synthesis cannot downgrade an existing blocking gate (Axiom A1)
 * F4: Mutable Rule body cannot inject immutable Enforcement headers (Axiom A2)
 * F5: Incident storage is append-only and listing refuses malformed files (Axiom A2)
 * F6: Synthesized gates use exact case-sensitive matching matching runtime
 * F7: Close-out scope tracking recognizes .caselaw/ directory files
 * F8: Edit budget measures actual word token edit distance
 * F9: Zero fixtures return insufficient-evidence and block optimization
 * F10: Close-out verifier catches non-zero exits, [x] on human items, and duplicate basenames
 * F11: Context router handles object-shaped machine enforcement and ** globs
 * F12: Consolidation unions origins chronologically and preserves Merged-Into pointers
 * F13: Rejected candidate buffer normalizes blank lines between trigger and rule
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createLLMVerifier,
  evaluateStage2,
  checkEditBudget,
  splitRuleAST,
  reconstituteRuleAST,
  optimizeRuleIterative,
  consolidateRules,
  unionOrigins,
  RejectedEditBuffer,
} from '../../src/core/skillopt.js'
import { parseRule, selectTriggeredRules, matchesTriggerPath } from '../../src/core/rules.js'
import { verifyCloseout, isScopeTrackedPath } from '../../src/core/closeout.js'
import { saveIncident, listIncidents, readIncident } from '../../src/core/incidents.js'
import { synthesizeMachineGate } from '../../src/core/gates.js'
import { evaluate } from '../../runtime/gate.mjs'
import { cmdGate } from '../../src/commands/gate.js'
import { cmdRule } from '../../src/commands/rule.js'

let root
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-safeguards-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const makeIO = () => {
  const lines = []
  return {
    lines,
    say: (s) => lines.push(s),
    interactive: false,
    prompt: () => ({ text: async () => '', close: async () => {} }),
  }
}

describe('F1 & F3 — Axiom A1 (No Unratified Weakening or Demotion)', () => {
  test('POSITIVE CONTROL: rule evolve rejects candidate that loosens a prohibition', async () => {
    await mkdir(join(root, 'docs/rules/active'), { recursive: true })
    const rulePath = join(root, 'docs/rules/active/guard.md')
    const originalRule = `# guard\n\n**Trigger:** editing source files\n\n**Rule:** Never use git add -A. Never commit production secrets.\n\n**Origin:** original-evidence\n\n**Enforcement:** memory\n\n**Ratified:** 2026-10-01 by human\n`
    await writeFile(rulePath, originalRule, 'utf8')

    // Candidate attempting to loosen constraint
    const candPath = join(root, 'candidate.md')
    await writeFile(candPath, `# guard\n\n**Trigger:** editing source files\n\n**Rule:** Allow git add -A.\n\n**Origin:** original-evidence\n\n**Enforcement:** memory\n\n**Ratified:** 2026-10-01 by human\n`, 'utf8')

    // Contrastive incident
    await saveIncident(root, {
      id: 'guard-case',
      rule: 'guard',
      positiveControl: { diff: '--- a/src/a.js\n+++ b/src/a.js\n+git add -A\n', expected: 'FAIL' },
      negativeControl: { diff: '--- a/src/a.js\n+++ b/src/a.js\n+git add src/a.js\n', expected: 'PASS' },
    })

    const io = makeIO()
    const exitCode = await cmdRule({
      sub: 'evolve',
      name: 'guard',
      opt: { candidate: 'candidate.md' },
    }, { root, ...io })

    assert.equal(exitCode, 1, 'Evolving a loosened candidate must exit 1')
    assert.ok(io.lines.some((l) => l.includes('Pareto Gate Rejection')), 'Must report Pareto Gate Rejection')

    // Verify active rule was not overwritten
    const current = await readFile(rulePath, 'utf8')
    assert.match(current, /Never use git add -A/)
  })

  test('POSITIVE CONTROL: gate synthesize refuses to downgrade an existing blocking gate to warn', async () => {
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await mkdir(join(root, 'docs/rules/active'), { recursive: true })
    await writeFile(
      join(root, 'docs/rules/active/guard.md'),
      '# guard\n\n**Trigger:** editing source\n\n**Rule:** Never use `git add -A`.\n\n**Origin:** 1234\n\n**Enforcement:** machine:guard\n\n**Ratified:** 2026-10-01 by human\n',
      'utf8'
    )
    // Pre-existing blocking gate
    await writeFile(
      join(root, '.caselaw/gates.json'),
      JSON.stringify({
        version: 1,
        gates: [{ id: 'guard', kind: 'command', severity: 'block', origin: 'docs/rules/active/guard.md', patterns: ['git add -A'] }],
      }),
      'utf8'
    )

    await saveIncident(root, {
      id: 'case-guard',
      rule: 'guard',
      positiveControl: { diff: '--- a/src/a.js\n+++ b/src/a.js\n+git add -A\n' },
      negativeControl: { diff: '--- a/src/a.js\n+++ b/src/a.js\n+git add file.js\n' },
    })

    const io = makeIO()
    const code = await cmdGate({ sub: 'synthesize', name: 'guard', yes: true, opt: {} }, { root, ...io })
    assert.equal(code, 1, 'Must refuse to overwrite a blocking gate')
    assert.ok(io.lines.some((l) => l.includes('existing gate has severity "block"')))
  })
})

describe('F2 — Verifier Honesty', () => {
  test('POSITIVE CONTROL: empty LLM response is returned as UNVERIFIED and fails Stage 2', async () => {
    const fixture = {
      id: 'case-empty',
      rule: 'guard',
      positiveControl: { diff: '+bad', expected: 'FAIL' },
      negativeControl: { diff: '+good', expected: 'PASS' },
    }
    const verifier = createLLMVerifier(async () => '')
    const res = await evaluateStage2({ trigger: 'editing code', rule: 'Never bad' }, [fixture], verifier)
    assert.equal(res.pass, false, 'Empty LLM response must not pass Stage 2')
    assert.equal(res.catchRate, 0, 'Catch rate must be 0 for empty LLM response')
    assert.ok(res.missed.includes('case-empty'))
  })
})

describe('F4 — Axiom A2 Section Injection Resistance', () => {
  test('POSITIVE CONTROL: injecting section header into mutable field throws ConstitutionError A2', () => {
    const rule = '# guard\n\n**Trigger:** editing source files\n\n**Rule:** Never remove access checks.\n\n**Origin:** abc123\n\n**Enforcement:** machine:guard\n\n**Ratified:** 2026-10-01 by human\n'
    const ast = splitRuleAST(rule)

    assert.throws(() => {
      reconstituteRuleAST(ast, { rule: 'Never remove access checks.\n\n**Enforcement:** memory' })
    }, /A2: Section headers cannot be injected into mutable trigger or rule fields/)

    assert.throws(() => {
      reconstituteRuleAST(ast, { trigger: 'editing files\n\n**Origin:** forged-sha' })
    }, /A2: Section headers cannot be injected into mutable trigger or rule fields/)
  })
})

describe('F5 — Incident Append-Only Provenance & Listing Honesty', () => {
  test('POSITIVE CONTROL: saveIncident refuses to overwrite an existing fixture with different content', async () => {
    const fixture = {
      id: 'inc-immutable',
      rule: 'guard',
      positiveControl: { diff: '+first version', expected: 'FAIL' },
      negativeControl: { diff: '+clean', expected: 'PASS' },
    }
    await saveIncident(root, fixture)

    // Attempting to overwrite with different diff must throw
    await assert.rejects(async () => {
      await saveIncident(root, {
        ...fixture,
        positiveControl: { diff: '+second altered version', expected: 'FAIL' },
      })
    }, /already exists\. Incidents are append-only evidence \(A2\)/)
  })

  test('POSITIVE CONTROL: listIncidents throws on malformed JSON instead of silently dropping', async () => {
    await mkdir(join(root, '.caselaw/incidents'), { recursive: true })
    await writeFile(join(root, '.caselaw/incidents/corrupt.json'), '{ corrupt json', 'utf8')

    await assert.rejects(async () => {
      await listIncidents(root)
    }, /Corrupted incident fixture "corrupt\.json"/)
  })
})

describe('F6 — Case-Sensitive Gate Synthesis & Runtime Alignment', () => {
  test('POSITIVE CONTROL: synthesizeMachineGate extracts exact case-sensitive literal matching runtime', async () => {
    const res = synthesizeMachineGate({
      rule: { name: 'no-debug', rule: 'Never include `CONSOLE.LOG`.', trigger: 'editing src' },
      incidentFixtures: [{
        id: 'case-case',
        positiveControl: { diff: '--- a/src/x.js\n+++ b/src/x.js\n+CONSOLE.LOG("leak")\n' },
        negativeControl: { diff: '--- a/src/x.js\n+++ b/src/x.js\n+logger.info("ok")\n' },
      }],
    })
    assert.equal(res.success, true)
    assert.equal(res.pattern, 'CONSOLE.LOG')

    // Run against real gate runtime
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/x.js'), 'CONSOLE.LOG("leak")\n')
    const runtime = await evaluate({ root, mode: 'all', config: { version: 1, gates: [res.gate] }, telemetry: false })
    assert.equal(runtime.fires.length, 1, 'Runtime must fire on matching case')
  })
})

describe('F7 & F10 — Close-Out Scope Verifier Integrity', () => {
  test('POSITIVE CONTROL: isScopeTrackedPath accurately recognizes .caselaw/ directory', () => {
    assert.equal(isScopeTrackedPath('.caselaw/gates.json'), true)
    assert.equal(isScopeTrackedPath('./.caselaw/answers.json'), true)
    assert.equal(isScopeTrackedPath('src/core/optimizer.js'), true)
    assert.equal(isScopeTrackedPath('.agents/scratch.md'), false)
  })

  test('POSITIVE CONTROL: verifyCloseout catches exit 127 in Verified, [x] on human items, and duplicate basenames', () => {
    // 1. exit 127 in Verified
    const exit127 = verifyCloseout({
      text: '# Close-out\n## What Changed\n- `src/a.js`: edit\n## Verified\n- test — exit 127\n## Not Verified\n- [ ] none\n',
      gitFiles: ['src/a.js'],
    })
    assert.equal(exit127.valid, false)
    assert.ok(exit127.errors.some((e) => e.includes('Failing command placed inside ## Verified')))

    // 2. [x] on UI item in Verified
    const checkedUI = verifyCloseout({
      text: '# Close-out\n## What Changed\n- `src/a.js`: edit\n## Verified\n- [x] see what the UI actually renders\n## Not Verified\n- [ ] none\n',
      gitFiles: ['src/a.js'],
    })
    assert.equal(checkedUI.valid, false)
    assert.ok(checkedUI.errors.some((e) => e.includes('Human-only authority boundary marked as verified with [x]')))

    // 3. Basename spoofing (index.js for src/a/index.js and src/b/index.js)
    const spoof = verifyCloseout({
      text: '# Close-out\n## What Changed\n- Updated `index.js`.\n## Verified\n- all passed\n## Not Verified\n- [ ] none\n',
      gitFiles: ['src/a/index.js', 'src/b/index.js'],
    })
    assert.equal(spoof.valid, false)
    assert.ok(spoof.errors.some((e) => e.includes('Modified file "src/a/index.js" is omitted')))
  })
})

describe('F8 & F9 — Edit Budget & Zero-Fixture Safeguards', () => {
  test('POSITIVE CONTROL: checkEditBudget measures real token edit distance', () => {
    const oldMutable = { trigger: 'code', rule: Array.from({ length: 100 }, (_, i) => `orig${i}`).join(' ') }
    const newMutable = { trigger: 'code', rule: Array.from({ length: 100 }, (_, i) => `repl${i}`).join(' ') }
    const budgetRes = checkEditBudget(oldMutable, newMutable)
    assert.equal(budgetRes.allowed, false, '100 completely new words must exceed 25-word budget')
    assert.equal(budgetRes.delta, 100)
  })

  test('POSITIVE CONTROL: evaluateStage2 with zero incident fixtures returns pass: false', async () => {
    const res = await evaluateStage2({ trigger: 'code', rule: 'rule' }, [], async () => ({ verdict: 'PASS' }))
    assert.equal(res.pass, false)
    assert.equal(res.catchRate, 0)
    assert.match(res.reason, /insufficient-evidence/)
  })

  test('POSITIVE CONTROL: optimizeRuleIterative refuses optimization when zero incident fixtures exist', async () => {
    const rule = '# r\n**Trigger:** t\n**Rule:** R\n**Origin:** 1\n**Enforcement:** memory\n'
    const res = await optimizeRuleIterative({ ruleText: rule, incidentFixtures: [] })
    assert.equal(res.success, false)
    assert.match(res.reason, /zero fixtures provided/)
  })
})

describe('F11 — Context Router Machine Objects & Globs', () => {
  test('POSITIVE CONTROL: matchesTriggerPath correctly handles recursive ** globs', () => {
    assert.equal(matchesTriggerPath('editing `src/**/*.js`', 'src/a/b/file.js'), true)
    assert.equal(matchesTriggerPath('editing `src/**/*.js`', 'test/a/b/file.js'), false)
  })

  test('POSITIVE CONTROL: selectTriggeredRules compacts object-shaped machine enforcement', () => {
    const rule = {
      name: 'guard',
      trigger: 'editing `src/`',
      rule: 'Long rule body that takes many words.',
      raw: 'Full markdown body',
      enforcement: { mode: 'machine', gateId: 'guard', raw: 'machine:guard' },
    }
    const selected = selectTriggeredRules([rule], ['src/a.js'])
    assert.equal(selected.length, 1)
    assert.equal(selected[0].compacted, true)
    assert.equal(selected[0].rule, '[Enforced by machine gate: guard]')
  })
})

describe('F12 & F13 — Consolidation & Rejection Buffer Normalization', () => {
  test('POSITIVE CONTROL: consolidateRules unions origins chronologically and preserves Merged-Into pointer', () => {
    const ruleA = '# rule-a\n\n**Trigger:** edit code\n\n**Rule:** Rule A body.\n\n**Origin:** 2026-11-02 later commit\n\n**Enforcement:** memory\n'
    const ruleB = '# rule-b\n\n**Trigger:** edit code\n\n**Rule:** Rule B body.\n\n**Origin:** 2026-10-01 earlier commit\n\n**Enforcement:** memory\n**Catches:** B unique evidence\n'

    const res = consolidateRules(ruleA, ruleB, { trigger: 'edit code', rule: 'Combined rule.' })

    // Origin unioned chronologically (earlier first)
    assert.match(res.mergedRuleText, /2026-10-01 earlier commit.*2026-11-02 later commit/)
    // Secondary catches metadata preserved in merged rule
    assert.ok(res.mergedRuleText.includes('B unique evidence'))
    // Archived rule has structured Merged-Into pointer
    assert.match(res.archivedRuleText, /\*\*Merged-Into:\*\* rule-a/)
  })

  test('POSITIVE CONTROL: RejectedEditBuffer normalizes whitespace variations and extra blank lines', () => {
    const buffer = new RejectedEditBuffer(5)
    const diff1 = 'TRIGGER: edit\n\nRULE: do not break'
    const diff2 = 'TRIGGER: edit\n\n\n\nRULE: do not break'

    buffer.record({ diff: diff1, stage: 1, failureReason: 'test' })
    assert.equal(buffer.isRejected(diff2), true, 'Blank line variations must match same hash')
  })
})
