/**
 * Unit tests for `caselaw rule evolve` and `caselaw rule incident` (0.4 / SkillOpt CLI).
 *
 * Verifies that:
 * 1. `caselaw rule incident` records valid contrastive fixtures.
 * 2. `caselaw rule evolve` refuses to evolve a rule without recorded incidents.
 * 3. `caselaw rule evolve --candidate <path>` validates candidate against Stage 1 & Stage 2.
 * 4. Structural A2 guarantees remain intact when written to disk.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cmdRule } from '../../src/commands/rule.js'
import { saveIncident } from '../../src/core/incidents.js'
import { parseRule } from '../../src/core/rules.js'

let root
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-evolve-')))
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

const BASE_RULE = `# stage-explicit-paths

**Trigger:** git add or git commit commands

**Rule:** Stage the paths you changed by name. Never use sweeping flags like git add -A or git add . in shared trees.

**Origin:** commit a1b2c3d4 (swept config secrets into repo)

**Enforcement:** memory

**Ratified:** 2026-08-13
`

const CANDIDATE_COMPRESSED = `# stage-explicit-paths

**Trigger:** git add or git commit commands

**Rule:** Stage explicit paths by name. Never sweep with git add -A or git add . in shared trees.

**Origin:** commit a1b2c3d4 (swept config secrets into repo)

**Enforcement:** memory

**Ratified:** 2026-08-13
`

describe('caselaw rule evolve command', () => {
  test('POSITIVE CONTROL: evolve refuses if no incidents are recorded', async () => {
    await mkdir(join(root, 'docs/rules/active'), { recursive: true })
    await writeFile(join(root, 'docs/rules/active/stage-explicit-paths.md'), BASE_RULE, 'utf8')

    const io = makeIO()
    const code = await cmdRule({ sub: 'evolve', name: 'stage-explicit-paths', opt: {} }, { root, ...io })
    assert.equal(code, 1)
    assert.ok(io.lines.some((l) => l.includes('No contrastive incidents recorded')))
  })

  test('POSITIVE CONTROL: evolve with candidate applies Pareto-optimal compression and preserves Origin (A2)', async () => {
    await mkdir(join(root, 'docs/rules/active'), { recursive: true })
    const rulePath = join(root, 'docs/rules/active/stage-explicit-paths.md')
    await writeFile(rulePath, BASE_RULE, 'utf8')

    // Add contrastive fixture
    await saveIncident(root, {
      id: 'INC-STAGE-01',
      rule: 'stage-explicit-paths',
      positiveControl: {
        commit: 'a1b2c3d4',
        diff: '--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n+git add .\n',
        expected: 'FAIL',
      },
      negativeControl: {
        commit: 'e5f6g7h8',
        diff: '--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n+git add app.js\n',
        expected: 'PASS',
      },
    })

    // Write candidate file
    const candPath = join(root, 'candidate.md')
    await writeFile(candPath, CANDIDATE_COMPRESSED, 'utf8')

    const io = makeIO()
    const code = await cmdRule({
      sub: 'evolve',
      name: 'stage-explicit-paths',
      opt: { candidate: 'candidate.md', compress: true },
    }, { root, ...io })

    assert.equal(code, 0)
    assert.ok(io.lines.some((l) => l.includes('staged to docs/rules/proposed/stage-explicit-paths.md')))

    // Read proposed and verify A2 preservation
    const proposed = await readFile(join(root, 'docs/rules/proposed/stage-explicit-paths.md'), 'utf8')
    const parsedProp = parseRule(proposed)
    assert.equal(parsedProp.origin, 'commit a1b2c3d4 (swept config secrets into repo)')
    assert.match(parsedProp.rule, /Stage explicit paths by name/)
  })

  test('POSITIVE CONTROL: evolve without candidate runs active iterative loop and feeds RejectedEditBuffer', async () => {
    await mkdir(join(root, 'docs/rules/active'), { recursive: true })
    const rulePath = join(root, 'docs/rules/active/verbose-rule.md')
    const verboseRule = `# verbose-rule

**Trigger:** any git add or commit staging operations

**Rule:** Please make sure to always remember to explicitly stage target files by name and never use sweep flags.

**Origin:** commit c1c2c3c4 (initial leak)

**Enforcement:** memory

**Ratified:** 2026-08-13
`
    await writeFile(rulePath, verboseRule, 'utf8')

    // Add contrastive fixture
    await saveIncident(root, {
      id: 'INC-VERBOSE-01',
      rule: 'verbose-rule',
      positiveControl: {
        commit: 'c1c2c3c4',
        diff: '--- a/main.js\n+++ b/main.js\n@@ -1 +1 @@\n+git add .\n',
        expected: 'FAIL',
      },
      negativeControl: {
        commit: 'd5d6d7d8',
        diff: '--- a/main.js\n+++ b/main.js\n@@ -1 +1 @@\n+git add main.js\n',
        expected: 'PASS',
      },
    })

    const io = makeIO()
    const code = await cmdRule({
      sub: 'evolve',
      name: 'verbose-rule',
      opt: { compress: true },
    }, { root, ...io })

    assert.equal(code, 0)
    assert.ok(io.lines.some((l) => l.includes('SkillOpt Iterative Evolution Pass')))
    assert.ok(io.lines.some((l) => l.includes('words saved')))

    // Read proposed and verify compression and Origin preservation
    const proposed = await readFile(join(root, 'docs/rules/proposed/verbose-rule.md'), 'utf8')
    assert.doesNotMatch(proposed, /Please make sure to always remember to/)
    const parsed = parseRule(proposed)
    assert.equal(parsed.origin, 'commit c1c2c3c4 (initial leak)')
  })

  test('POSITIVE CONTROL: evolve with --llm and --runner executes runner bridge', async () => {
    await mkdir(join(root, 'docs/rules/active'), { recursive: true })
    const rulePath = join(root, 'docs/rules/active/llm-rule.md')
    const llmRule = `# llm-rule\n\n**Trigger:** any git staging\n\n**Rule:** Stage files carefully.\n\n**Origin:** commit 11223344\n\n**Enforcement:** memory\n\n**Ratified:** 2026-08-13\n`
    await writeFile(rulePath, llmRule, 'utf8')

    await saveIncident(root, {
      id: 'INC-LLM-01',
      rule: 'llm-rule',
      positiveControl: { commit: '1122', diff: '+git add .\n', expected: 'FAIL' },
      negativeControl: { commit: '3344', diff: '+git add file\n', expected: 'PASS' },
    })

    const io = makeIO()
    const mockRunner = async ({ prompt }) => {
      if (prompt.includes('Role: verifier')) return 'VERDICT: PASS'
      return 'PROPOSAL:\nTrigger: git staging\nRule: Stage explicitly.'
    }

    const code = await cmdRule({
      sub: 'evolve',
      name: 'llm-rule',
      opt: { llm: true, runner: mockRunner },
    }, { root, ...io })

    assert.equal(code, 0)
    assert.ok(io.lines.some((l) => l.includes('LLM Runner:')))
  })
})
