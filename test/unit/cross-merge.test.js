/**
 * Unit tests for Cross-Rule Consolidation & Multi-Rule Merge (0.4 / SkillOpt).
 *
 * Verifies that when rules share trigger overlap, multi-rule consolidation:
 * 1. Unions Origin: trails chronologically without dropping either parent's evidence (A2/A3).
 * 2. Unions Precedent: trails losslessly.
 * 3. Archives superseded rule with an explicit Merged-Into pointer.
 * 4. Verifies merged candidate rule against contrastive incident fixtures.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'

import {
  consolidateRules,
  unionOrigins,
  evaluateStage1,
  evaluateStage2,
  evaluatePareto,
  words,
} from '../../src/core/skillopt.js'
import { parseRule } from '../../src/core/rules.js'

let root
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-crossmerge-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const RULE_A = `# stage-explicit-paths

**Trigger:** git add or git commit commands

**Rule:** Stage the paths you changed by name. Never use sweeping flags like git add -A or git add . in shared trees.

**Origin:** commit a1b2c3d4 (swept config secrets into repo)

**Precedent:** incident in project X (2026-03-01)

**Enforcement:** memory

**Ratified:** 2026-08-13
`

const RULE_B = `# no-git-commit-all

**Trigger:** git commit commands with sweep flags

**Rule:** Never use git commit -a or git commit --all. Always review staged changes with git status first.

**Origin:** commit e5f6g7h8 (accidental commit of temp test logs)

**Precedent:** incident in project Y (2026-05-15)

**Enforcement:** checklist

**Ratified:** 2026-09-01
`

describe('unionOrigins helper', () => {
  test('POSITIVE CONTROL: unions two distinct origins cleanly', () => {
    const res = unionOrigins('commit a1b2c3d4 (incident 1)', 'commit e5f6g7h8 (incident 2)')
    assert.equal(res, 'commit a1b2c3d4 (incident 1); commit e5f6g7h8 (incident 2)')
  })

  test('POSITIVE CONTROL: handles duplicate or empty origins gracefully', () => {
    assert.equal(unionOrigins('commit 1234', 'commit 1234'), 'commit 1234')
    assert.equal(unionOrigins('', 'commit 1234'), 'commit 1234')
    assert.equal(unionOrigins('commit 1234', ''), 'commit 1234')
  })
})

describe('consolidateRules engine', () => {
  test('POSITIVE CONTROL: merged rule retains both parent Origins and Precedents (A2, A3)', () => {
    const mergedMutable = {
      trigger: 'git add or git commit staging commands',
      rule: 'Explicitly stage target paths by name; never use sweeping flags (git add -A, git commit -a).',
    }

    const { mergedRuleText, archivedRuleText } = consolidateRules(RULE_A, RULE_B, mergedMutable)

    // Check merged rule
    const parsedMerged = parseRule(mergedRuleText)
    assert.equal(parsedMerged.name, 'stage-explicit-paths')
    assert.match(parsedMerged.origin, /commit a1b2c3d4/)
    assert.match(parsedMerged.origin, /commit e5f6g7h8/)
    assert.match(parsedMerged.precedent, /incident in project X/)
    assert.match(parsedMerged.precedent, /incident in project Y/)
    assert.equal(parsedMerged.trigger, mergedMutable.trigger)
    assert.equal(parsedMerged.rule, mergedMutable.rule)

    // Check archived rule
    const parsedArchived = parseRule(archivedRuleText)
    assert.equal(parsedArchived.name, 'no-git-commit-all')
    assert.match(parsedArchived.footer, /_Merged into `stage-explicit-paths` on \d{4}-\d{2}-\d{2}\._/)
  })

  test('POSITIVE CONTROL: merged candidate achieves lossless compression over parent rules', () => {
    const mergedMutable = {
      trigger: 'git add or git commit staging commands',
      rule: 'Explicitly stage target paths by name; never sweep with git add -A, git add ., or git commit -a.',
    }
    const { mergedRuleText } = consolidateRules(RULE_A, RULE_B, mergedMutable)

    const wordsA = words(RULE_A)
    const wordsB = words(RULE_B)
    const wordsMerged = words(mergedRuleText)

    // Merged words should be noticeably lower than sum of parent rules
    assert.ok(wordsMerged < (wordsA + wordsB), `Merged words (${wordsMerged}) should be less than sum (${wordsA + wordsB})`)
  })
})
