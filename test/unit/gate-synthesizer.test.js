/**
 * Unit tests for Prose-to-Machine Gate Synthesizer (0.4 / SkillOpt Gate Ladder).
 *
 * Verifies that:
 * 1. synthesizeMachineGate requires 100% sensitivity and 100% specificity.
 * 2. POSITIVE CONTROL: Ambiguous patterns matching negative controls are refused.
 * 3. POSITIVE CONTROL: `caselaw gate synthesize <name> --yes` registers the machine gate in gates.json and updates rule enforcement to machine:<id>.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { synthesizeMachineGate, load as loadGates } from '../../src/core/gates.js'
import { saveIncident } from '../../src/core/incidents.js'
import { cmdGate } from '../../src/commands/gate.js'
import { parseRule } from '../../src/core/rules.js'

let root
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-synth-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const FIXTURES_CLEAN = [
  {
    id: 'INC-SYNTH-01',
    rule: 'no-console-log',
    positiveControl: {
      diff: '--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1 @@\n+console.log("leak")\n',
      expected: 'FAIL',
    },
    negativeControl: {
      diff: '--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1 @@\n+logger.info("clean")\n',
      expected: 'PASS',
    },
  },
]

const FIXTURES_AMBIGUOUS = [
  {
    id: 'INC-SYNTH-AMBIG',
    rule: 'no-broken-code',
    positiveControl: {
      diff: '--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1 @@\n+import { foo } from "./bar"\n',
      expected: 'FAIL',
    },
    negativeControl: {
      diff: '--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1 @@\n+import { foo } from "./bar"\n',
      expected: 'PASS',
    },
  },
]

describe('synthesizeMachineGate core function', () => {
  test('POSITIVE CONTROL: cleanly synthesized gate achieves 100% sensitivity and 100% specificity', () => {
    const rule = {
      name: 'no-console-log',
      rule: 'Never use `console.log` in production code.',
      trigger: 'JavaScript files',
    }

    const res = synthesizeMachineGate({ rule, incidentFixtures: FIXTURES_CLEAN })
    assert.equal(res.success, true)
    assert.equal(res.sensitivity, 1.0)
    assert.equal(res.specificity, 1.0)
    assert.equal(res.gate.id, 'no-console-log')
    assert.equal(res.gate.kind, 'banned-content')
    assert.deepEqual(res.gate.patterns, ['console.log'])
  })

  test('POSITIVE CONTROL: ambiguous pattern matching negative control is refused machine promotion', () => {
    const rule = {
      name: 'no-broken-code',
      rule: 'Avoid broken code in `import { foo } from "./bar"`.',
      trigger: 'code files',
    }

    // Both positive and negative have the same pattern
    const res = synthesizeMachineGate({ rule, incidentFixtures: FIXTURES_AMBIGUOUS })
    assert.equal(res.success, false)
    assert.match(res.reason, /Ambiguous incident traces/)
  })

  test('POSITIVE CONTROL: refusal when no incident fixtures exist', () => {
    const rule = { name: 'no-fixtures', rule: 'Be good.' }
    const res = synthesizeMachineGate({ rule, incidentFixtures: [] })
    assert.equal(res.success, false)
    assert.match(res.reason, /without recorded incident fixtures/)
  })
})

describe('caselaw gate synthesize CLI', () => {
  test('POSITIVE CONTROL: gate synthesize --yes registers gate and updates rule enforcement to machine:<id>', async () => {
    await mkdir(join(root, 'docs/rules/active'), { recursive: true })
    const rulePath = join(root, 'docs/rules/active/no-console-log.md')
    const ruleContent = `# no-console-log\n\n**Trigger:** JavaScript files\n\n**Rule:** Never use \`console.log\` in production code.\n\n**Origin:** commit 1234\n\n**Enforcement:** memory\n\n**Ratified:** 2026-08-13\n`
    await writeFile(rulePath, ruleContent, 'utf8')

    await saveIncident(root, FIXTURES_CLEAN[0])

    const lines = []
    const io = { say: (s) => lines.push(s) }
    const code = await cmdGate({ sub: 'synthesize', name: 'no-console-log', yes: true, opt: {} }, { root, ...io })

    assert.equal(code, 0)
    assert.ok(lines.some((l) => l.includes('Synthesized machine gate')))
    assert.ok(lines.some((l) => l.includes('Registered in .caselaw/gates.json')))

    // Verify gates.json
    const config = await loadGates(root)
    assert.equal(config.gates.length, 1)
    assert.equal(config.gates[0].id, 'no-console-log')

    // Verify rule enforcement updated on disk
    const updatedRule = await readFile(rulePath, 'utf8')
    const parsed = parseRule(updatedRule)
    assert.equal(parsed.enforcement, 'machine:no-console-log')
  })
})
