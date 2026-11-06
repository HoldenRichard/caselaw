/**
 * Unit tests for SkillOpt Engine (0.4 / CaseLaw).
 *
 * Verifies:
 * 1. Structural A2/A3 invariance across AST splitting and reconstitution.
 * 2. Lexicographic Pareto Gate (capability vs. lossless compression).
 * 3. Short-rule edit budget floor and diff cap exemptions.
 * 4. Diagnostic RejectedEditBuffer with normalized hashing and prompt formatting.
 * 5. Two-stage hybrid evaluation funnel (deterministic Stage 1 + contrastive Stage 2).
 * 6. Multi-rule consolidation with chronological Origin union.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  splitRuleAST,
  reconstituteRuleAST,
  calculateEditBudget,
  checkEditBudget,
  RejectedEditBuffer,
  evaluatePareto,
  evaluateStage1,
  evaluateStage2,
  consolidateRules,
  createLLMProposer,
  createLLMVerifier,
  optimizeRuleIterative,
  ConstitutionError,
  words,
} from '../../src/core/skillopt.js'

const RULE_SAMPLE = `# stage-explicit-paths

**Trigger:** git add or git commit commands

**Rule:** Stage the paths you changed by name. Never use sweeping flags like git add -A or git add . in shared trees.

**Origin:** commit a1b2c3d4 (swept config secrets into repo)

**Precedent:** incident in project X; incident in project Y

**Enforcement:** memory

**Ratified:** 2026-08-13
`

describe('structural AST and Constitution A2 invariance', () => {
  test('POSITIVE CONTROL: splitRuleAST isolates mutable trigger and rule', () => {
    const ast = splitRuleAST(RULE_SAMPLE)
    assert.equal(ast.name, 'stage-explicit-paths')
    assert.equal(ast.mutable.trigger, 'git add or git commit commands')
    assert.match(ast.mutable.rule, /Stage the paths you changed/)
    assert.equal(ast.immutable.origin, 'commit a1b2c3d4 (swept config secrets into repo)')
    assert.equal(ast.immutable.ratified, '2026-08-13')
  })

  test('POSITIVE CONTROL: reconstituteRuleAST guarantees Origin and Ratified remain byte-identical', () => {
    const ast = splitRuleAST(RULE_SAMPLE)
    const newMutable = {
      trigger: 'any git staging or commit command',
      rule: 'Explicitly specify paths when staging. Never sweep.',
    }
    const reconstituted = reconstituteRuleAST(ast, newMutable)
    assert.match(reconstituted, /^\*\*Trigger:\*\* any git staging or commit command/m)
    assert.match(reconstituted, /^\*\*Rule:\*\* Explicitly specify paths when staging\. Never sweep\./m)
    assert.match(reconstituted, /^\*\*Origin:\*\* commit a1b2c3d4 \(swept config secrets into repo\)/m)
    assert.match(reconstituted, /^\*\*Ratified:\*\* 2026-08-13/m)
  })

  test('POSITIVE CONTROL: modifying immutable Origin throws ConstitutionError A2', () => {
    const ast = splitRuleAST(RULE_SAMPLE)
    ast.immutable.origin = 'invented origin'
    assert.throws(() => reconstituteRuleAST(ast, { rule: 'Never sweep.' }), /A2: Immutable AST/)

  })
})

describe('short-rule edit budget floor', () => {
  test('POSITIVE CONTROL: short rule gets the 15-word budget floor', () => {
    // 20 mutable words: 20 * 0.25 = 5 -> floor is 15
    const budget = calculateEditBudget(20)
    assert.equal(budget, 15)
  })

  test('POSITIVE CONTROL: larger rule gets 25% ratio', () => {
    // 100 mutable words: 100 * 0.25 = 25 -> budget is 25
    const budget = calculateEditBudget(100)
    assert.equal(budget, 25)
  })

  test('POSITIVE CONTROL: lossless compression is exempt from diff cap', () => {
    const oldMutable = { trigger: 'git staging', rule: 'A very long verbose instruction with many words here' }
    const newMutable = { trigger: 'git staging', rule: 'Short rule' }
    const res = checkEditBudget(oldMutable, newMutable)
    assert.equal(res.allowed, true)
  })

  test('POSITIVE CONTROL: excessive capability expansion is refused', () => {
    const oldMutable = { trigger: 'git staging', rule: 'Short' }
    const newMutable = {
      trigger: 'git staging and committing and branching and pushing and rebasing',
      rule: 'This is an excessively long and bloated rewrite of the rule that goes way past the fifteen word budget floor allowed per step',
    }
    const res = checkEditBudget(oldMutable, newMutable)
    assert.equal(res.allowed, false)
    assert.match(res.reason, /exceeds the textual learning-rate budget/)
  })
})

describe('diagnostic RejectedEditBuffer', () => {
  test('POSITIVE CONTROL: duplicate edits are recognized despite whitespace variations', () => {
    const buf = new RejectedEditBuffer(3)
    buf.record({ diff: '+  git add explicit\n- git add .', stage: 1, failureReason: 'Ambient trigger' })

    // Slightly different spacing
    assert.equal(buf.isRejected('+\tgit add explicit\n-\tgit add .'), true)
    assert.equal(buf.isRejected('+ completely different diff'), false)
  })

  test('POSITIVE CONTROL: buffer stores failure reasons and formats prompt context', () => {
    const buf = new RejectedEditBuffer(3)
    buf.record({ diff: 'diff 1', stage: 1, failureReason: 'Trigger "any change" is ambient' })
    buf.record({ diff: 'diff 2', stage: 2, failureReason: 'False positive on negativeControl commit e5f6g7h8' })

    const promptText = buf.formatPromptContext()
    assert.match(promptText, /\[Stage 1 Rejection\]: Trigger "any change" is ambient/)
    assert.match(promptText, /\[Stage 2 Rejection\]: False positive on negativeControl commit e5f6g7h8/)
  })

  test('POSITIVE CONTROL: buffer evicts oldest entry when exceeding maxSize', () => {
    const buf = new RejectedEditBuffer(2)
    buf.record({ diff: 'diff 1', stage: 1, failureReason: 'err 1' })
    buf.record({ diff: 'diff 2', stage: 1, failureReason: 'err 2' })
    buf.record({ diff: 'diff 3', stage: 1, failureReason: 'err 3' })

    assert.equal(buf.entries.length, 2)
    assert.equal(buf.isRejected('diff 1'), false)
    assert.equal(buf.isRejected('diff 3'), true)
  })
})

describe('lexicographic Pareto Gate', () => {
  const baseline = { catchRate: 0.5, falsePositives: 0, wordCount: 50 }

  test('POSITIVE CONTROL: capability improvement is accepted', () => {
    const candidate = { catchRate: 0.8, falsePositives: 0, wordCount: 52 }
    const res = evaluatePareto(candidate, baseline)
    assert.equal(res.accepted, true)
    assert.equal(res.mode, 'capability')
  })

  test('POSITIVE CONTROL: false positives reject candidate immediately', () => {
    const candidate = { catchRate: 1.0, falsePositives: 1, wordCount: 45 }
    const res = evaluatePareto(candidate, baseline)
    assert.equal(res.accepted, false)
    assert.match(res.reason, /false positive/)
  })

  test('POSITIVE CONTROL: lossless compression accepted when catch rate is 100%', () => {
    const baseline100 = { catchRate: 1.0, falsePositives: 0, wordCount: 60 }
    const candidateCompressed = { catchRate: 1.0, falsePositives: 0, wordCount: 42 }
    const res = evaluatePareto(candidateCompressed, baseline100)
    assert.equal(res.accepted, true)
    assert.equal(res.mode, 'compression')
    assert.match(res.reason, /Recorded-fixture compression/)
  })

  test('POSITIVE CONTROL: candidate with no improvement or compression is rejected', () => {
    const candidateSame = { catchRate: 0.5, falsePositives: 0, wordCount: 50 }
    const res = evaluatePareto(candidateSame, baseline)
    assert.equal(res.accepted, false)
    assert.equal(res.mode, 'rejected')
  })

  test('POSITIVE CONTROL: candidate exceeding load budget is rejected', () => {
    const candidateHuge = { catchRate: 1.0, falsePositives: 0, wordCount: 3500 }
    const res = evaluatePareto(candidateHuge, baseline, { budget: 3000 })
    assert.equal(res.accepted, false)
    assert.match(res.reason, /exceeds load budget/)
  })
})

describe('two-stage evaluation funnel', () => {
  const FIXTURES = [
    {
      id: 'INC-01',
      positiveControl: { diff: '--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1 @@\n+git add .\n' },
      negativeControl: { diff: '--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1 @@\n+git add src/index.js\n' },
    },
  ]

  test('POSITIVE CONTROL: Stage 1 rejects ambient trigger with 0 token cost', () => {
    const candidate = { trigger: 'any work', rule: 'Be careful.' }
    const res = evaluateStage1(candidate, FIXTURES)
    assert.equal(res.pass, false)
    assert.match(res.reason, /ambient or empty/)
  })

  test('POSITIVE CONTROL: Stage 1 passes valid trigger and within budget', () => {
    const candidate = { trigger: 'staging git changes in src/', rule: 'Specify exact files.' }
    const res = evaluateStage1(candidate, FIXTURES)
    assert.equal(res.pass, true)
  })

  test('POSITIVE CONTROL: Stage 2 verifies contrastive pair correctly', async () => {
    const candidate = { trigger: 'git add', rule: 'Never sweep with git add .' }
    const mockVerifier = async ({ control, diff }) => {
      // Simulate verifier: flags "git add ." as FAIL, passes explicit files as PASS
      if (diff.includes('git add .')) return { verdict: 'FAIL', reason: 'Caught sweeping flag' }
      return { verdict: 'PASS', reason: 'Explicit file staging allowed' }
    }

    const res = await evaluateStage2(candidate, FIXTURES, mockVerifier)
    assert.equal(res.pass, true)
    assert.equal(res.catchRate, 1.0)
    assert.equal(res.falsePositives, 0)
    assert.deepEqual(res.caught, ['INC-01'])
  })

  test('POSITIVE CONTROL: Stage 2 detects false positive on negative control', async () => {
    const candidate = { trigger: 'git add', rule: 'Reject everything' }
    const overlyAggressiveVerifier = async () => ({ verdict: 'FAIL', reason: 'Flagged everything' })

    const res = await evaluateStage2(candidate, FIXTURES, overlyAggressiveVerifier)
    assert.equal(res.pass, false)
    assert.equal(res.falsePositives, 1)
    assert.deepEqual(res.falsePositivesList, ['INC-01'])
  })
})

describe('multi-rule consolidation (A2/A3 union)', () => {
  const RULE_A = `# rule-a\n\n**Trigger:** trigger A\n\n**Rule:** rule A prose\n\n**Origin:** commit 1111 (incident 1)\n\n**Enforcement:** memory\n`
  const RULE_B = `# rule-b\n\n**Trigger:** trigger B\n\n**Rule:** rule B prose\n\n**Origin:** commit 2222 (incident 2)\n\n**Precedent:** precedent from B\n\n**Enforcement:** checklist\n`

  test('POSITIVE CONTROL: consolidateRules unions Origins chronologically and archives rule B with pointer', () => {
    const merged = consolidateRules(RULE_A, RULE_B, {
      trigger: 'trigger A and B combined',
      rule: 'consolidated rule prose',
    })

    assert.match(merged.mergedRuleText, /^\*\*Origin:\*\* commit 1111 \(incident 1\); commit 2222 \(incident 2\)/m)
    assert.match(merged.mergedRuleText, /^\*\*Precedent:\*\* precedent from B/m)
    assert.match(merged.archivedRuleText, /_Merged into `rule-a` on \d{4}-\d{2}-\d{2}\._/)
  })
})

describe('pluggable LLM runner bridge', () => {
  const FIXTURES = [
    {
      id: 'INC-LLM-01',
      positiveControl: { diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n+git add .\n', description: 'Swept add .' },
      negativeControl: { diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n+git add f\n', description: 'Explicit staging' },
    },
  ]

  test('POSITIVE CONTROL: LLM proposer prompt injects RejectedEditBuffer diagnostics on subsequent steps', async () => {
    const buffer = new RejectedEditBuffer(3)
    buffer.record({ diff: 'TRIGGER: any work\nRULE: bad', stage: 1, failureReason: 'Ambient trigger' })

    let capturedPrompt = null
    const mockRunner = async ({ prompt }) => {
      capturedPrompt = prompt
      return 'TRIGGER: staging git paths\nRULE: Never sweep with git add .'
    }

    const proposer = createLLMProposer(mockRunner)
    const currentAST = splitRuleAST(RULE_SAMPLE)
    const proposed = await proposer({ currentAST, step: 2, rejectedBuffer: buffer, incidentFixtures: FIXTURES, isCompression: false })

    assert.ok(capturedPrompt)
    assert.match(capturedPrompt, /Rejected Proposals in Recent Steps/)
    assert.match(capturedPrompt, /\[Stage 1 Rejection\]: Ambient trigger/)
    assert.equal(proposed.trigger, 'staging git paths')
    assert.equal(proposed.rule, 'Never sweep with git add .')
  })

  test('POSITIVE CONTROL: LLM verifier correctly parses verdict from role prompt response', async () => {
    const mockRunner = async ({ diff, control, fixture }) => {
      assert.equal(control, undefined)
      assert.equal(fixture, undefined)
      if (/\+git add \./.test(diff)) return 'VERDICT: FAIL\n\nSweeping flag detected in positive control'
      return 'VERDICT: PASS\n\nExplicit staging is clean'
    }

    const verifier = createLLMVerifier(mockRunner)
    const posRes = await verifier({ rule: { rule: 'Never sweep' }, fixture: FIXTURES[0], control: 'positive', diff: FIXTURES[0].positiveControl.diff })
    assert.equal(posRes.verdict, 'FAIL')
    assert.match(posRes.reason, /Sweeping flag detected/)

    const negRes = await verifier({ rule: { rule: 'Never sweep' }, fixture: FIXTURES[0], control: 'negative', diff: FIXTURES[0].negativeControl.diff })
    assert.equal(negRes.verdict, 'PASS')
  })

  test('POSITIVE CONTROL: optimizeRuleIterative runs multi-step loop with mock LLM runner', async () => {
    let callCount = 0
    const mockRunner = async ({ role, diff }) => {
      if (role === 'proposer') {
        callCount++
        return 'TRIGGER: staging git paths\nRULE: Never use git add . or git add -A in shared trees.'
      }
      // verifier
      return /\+git add \./.test(diff) ? 'VERDICT: FAIL\n\nCaught' : 'VERDICT: PASS\n\nClean'
    }

    const res = await optimizeRuleIterative({
      ruleText: RULE_SAMPLE,
      incidentFixtures: FIXTURES,
      llmRunner: mockRunner,
      maxSteps: 2,
    })

    assert.ok(res.success)
    assert.ok(callCount >= 1)
    assert.ok(res.bestRuleText.includes('Never use git add .'))
  })
})
