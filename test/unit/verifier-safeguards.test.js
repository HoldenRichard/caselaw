/**
 * Dedicated positive controls for adversarial audit findings F1 - F13.
 *
 * Each test block is an isolated POSITIVE CONTROL reproducing and verifying
 * the structural fixes for findings from repro.mjs and cli-repro.mjs:
 *
 * Case 1 (repro:13-14): Empty LLM verifier response is marked UNVERIFIED and fails Stage 2
 * Case 2 (repro:15-17): 100 replaced words measured by ordered LCS edit distance exceeds budget
 * Case 3 (repro:18-20): Reconstituting mutable Rule with section headers throws ConstitutionError A2
 * Case 4 (repro:21-22): optimizeRuleIterative refuses candidate when zero incident fixtures exist
 * Case 5 (repro:23-24): isScopeTrackedPath recognizes .caselaw files and verifyCloseout catches omitted .caselaw changes
 * Case 6 (repro:25): verifyCloseout catches exit 127, non-zero exits, and [x] on human authority items
 * Case 7 (repro:26): verifyCloseout rejects duplicate basenames representing multiple paths
 * Case 8 (repro:28-29): saveIncident refuses to overwrite existing fixture with conflicting diff (A2)
 * Case 9 (repro:30-31): listIncidents throws diagnostic error on malformed incident JSON
 * Case 10 (repro:32-33): selectTriggeredRules compacts object-shaped machine enforcement
 * Case 11 (repro:34-35): consolidateRules preserves secondary catches metadata, Merged-Into pointer, and chronological origins
 * Case 12 (repro:36-41): synthesizeMachineGate extracts exact case-sensitive pattern matching runtime/gate.mjs
 * Case 13 (cli-repro:10-18): Subprocess CLI rule evolve rejects loosened candidate and preserves active rule in non-interactive mode
 * Case 14 (cli-repro:19-24): Subprocess CLI gate synthesize refuses to overwrite or downgrade existing blocking gate
 * Case 15 (cli-repro:25-27): Subprocess context routing compacts object-shaped machine enforcement
 * Case 16 (rules:1280): selectTriggeredRules enforces strict word budget cap without admitting oversize first rule
 * Case 17 (rule:690): Non-interactive rule evolve stages valid candidate to docs/rules/proposed/ (Axiom A1)
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
import { saveIncident, listIncidents } from '../../src/core/incidents.js'
import { synthesizeMachineGate } from '../../src/core/gates.js'
import { evaluate } from '../../runtime/gate.mjs'
import { cmdGate } from '../../src/commands/gate.js'
import { cmdRule } from '../../src/commands/rule.js'

const CLI_PATH = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))

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

const runCli = (args, cwd) => {
  const env = { ...process.env, NO_COLOR: '1' }
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd, env, encoding: 'utf8' })
  return { exit: res.status, stdout: res.stdout, stderr: res.stderr }
}

describe('Independent Positive Controls: repro.mjs cases 1 - 12', () => {
  test('POSITIVE CONTROL 1 (repro:13-14): Empty LLM verifier response is marked UNVERIFIED and fails Stage 2', async () => {
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

  test('POSITIVE CONTROL 2 (repro:15-17): 100 replaced words measured by ordered LCS edit distance exceeds budget', () => {
    const oldMutable = { trigger: 'editing code', rule: Array.from({ length: 100 }, (_, i) => `original${i}`).join(' ') }
    const newMutable = { trigger: 'editing code', rule: Array.from({ length: 100 }, (_, i) => `replacement${i}`).join(' ') }
    const budget = checkEditBudget(oldMutable, newMutable)
    assert.equal(budget.allowed, false, '100 replaced words must exceed edit budget')
    assert.equal(budget.delta, 200, 'LCS edit distance between 100 completely disjoint words must be 200')
    assert.ok(budget.reason.includes('exceeds the textual learning-rate budget'))
  })

  test('POSITIVE CONTROL 3 (repro:18-20): Reconstituting mutable Rule with section headers throws ConstitutionError A2', () => {
    const rule = '# guard\n\n**Trigger:** editing source files\n\n**Rule:** Never remove access checks.\n\n**Origin:** abc123\n\n**Enforcement:** machine:guard\n\n**Ratified:** 2026-10-01 by human\n'
    const ast = splitRuleAST(rule)

    assert.throws(() => {
      reconstituteRuleAST(ast, { rule: 'Never remove access checks.\n\n**Enforcement:** memory' })
    }, /A2: Section headers cannot be injected into mutable trigger or rule fields/)

    assert.throws(() => {
      reconstituteRuleAST(ast, { trigger: 'editing files\n\n**Origin:** forged-sha' })
    }, /A2: Section headers cannot be injected into mutable trigger or rule fields/)
  })

  test('POSITIVE CONTROL 4 (repro:21-22): optimizeRuleIterative refuses candidate when zero incident fixtures exist', async () => {
    const rule = '# guard\n\n**Trigger:** editing source files\n\n**Rule:** Never remove access checks.\n\n**Origin:** abc123\n\n**Enforcement:** machine:guard\n\n**Ratified:** 2026-10-01 by human\n'
    const shorten = await optimizeRuleIterative({
      ruleText: rule,
      incidentFixtures: [],
      maxSteps: 1,
      proposerFn: async () => ({ trigger: 'editing source files', rule: 'Allow removals.' }),
    })
    assert.equal(shorten.success, false, 'Must not certify candidate when zero incident fixtures exist')
    assert.match(shorten.reason, /zero fixtures provided/)
  })

  test('POSITIVE CONTROL 5 (repro:23-24): isScopeTrackedPath recognizes .caselaw files and verifyCloseout catches omitted .caselaw changes', () => {
    assert.equal(isScopeTrackedPath('.caselaw/gates.json'), true)
    assert.equal(isScopeTrackedPath('./.caselaw/answers.json'), true)

    const scope = verifyCloseout({
      text: '## What Changed\nNothing.\n',
      gitFiles: ['.caselaw/gates.json'],
    })
    assert.equal(scope.valid, false, 'Must flag modified .caselaw/gates.json omitted from What Changed')
    assert.ok(scope.errors.some((e) => e.includes('.caselaw/gates.json')))
  })

  test('POSITIVE CONTROL 6 (repro:25): verifyCloseout catches exit 127, non-zero exits, and [x] on human authority items', () => {
    const exit = verifyCloseout({
      text: '## Verified\n- npm run typecheck — exit 127\n- lint — exit code 1\n- render UI [x]\n',
      gitFiles: [],
    })
    assert.equal(exit.valid, false, 'Must reject exit 127, exit 1, and [x] on human authority items under Verified')
    assert.ok(exit.errors.some((e) => e.includes('Failing command placed inside ## Verified')))
    assert.ok(exit.errors.some((e) => e.includes('Human-only authority boundary marked as verified with [x]')))
  })

  test('POSITIVE CONTROL 7 (repro:26): verifyCloseout rejects duplicate basenames representing multiple paths', () => {
    const same = verifyCloseout({
      text: '## What Changed\nUpdated index.js.\n',
      gitFiles: ['src/a/index.js', 'src/b/index.js'],
    })
    assert.equal(same.valid, false, 'One basename must not account for multiple distinct paths')
    assert.ok(same.errors.some((e) => e.includes('Modified file "src/a/index.js" is omitted')))
  })

  test('POSITIVE CONTROL 8 (repro:28-29): saveIncident refuses to overwrite existing fixture with conflicting diff (A2)', async () => {
    const fixture = {
      id: 'example-1',
      rule: 'guard',
      positiveControl: { diff: '+bad', expected: 'FAIL' },
      negativeControl: { diff: '+good', expected: 'PASS' },
    }
    await saveIncident(root, fixture)

    await assert.rejects(async () => {
      await saveIncident(root, { ...fixture, positiveControl: { diff: '+different' } })
    }, /already exists\. Incidents are append-only evidence \(A2\)/)
  })

  test('POSITIVE CONTROL 9 (repro:30-31): listIncidents throws diagnostic error on malformed incident JSON', async () => {
    await mkdir(join(root, '.caselaw/incidents'), { recursive: true })
    await writeFile(join(root, '.caselaw/incidents/broken.json'), '{ malformed')

    await assert.rejects(async () => {
      await listIncidents(root)
    }, /Corrupted incident fixture "broken\.json"/)
  })

  test('POSITIVE CONTROL 10 (repro:32-33): selectTriggeredRules compacts object-shaped machine enforcement', () => {
    const rule = '# guard\n\n**Trigger:** editing source files\n\n**Rule:** Never remove access checks.\n\n**Origin:** abc123\n\n**Enforcement:** machine:guard\n\n**Ratified:** 2026-10-01 by human\n'
    const routed = selectTriggeredRules([
      {
        name: 'guard',
        trigger: 'editing src/*.js',
        rule: 'Very long rule body',
        raw: rule,
        enforcement: { mode: 'machine', gateId: 'guard', raw: 'machine:guard' },
      },
    ], ['src/index.js'])

    assert.equal(routed.length, 1)
    assert.equal(routed[0].compacted, true)
    assert.equal(routed[0].rule, '[Enforced by machine gate: guard]')
  })

  test('POSITIVE CONTROL 11 (repro:34-35): consolidateRules preserves secondary catches metadata, Merged-Into pointer, and chronological origins', () => {
    const rule = '# guard\n\n**Trigger:** editing source files\n\n**Rule:** Never remove access checks.\n\n**Origin:** abc123\n\n**Enforcement:** machine:guard\n\n**Ratified:** 2026-10-01 by human\n'
    const cr = consolidateRules(
      rule,
      rule.replace('# guard', '# guard-b').replace('abc123', 'def456') + '\n**Catches:** B unique evidence\n',
      { trigger: 'editing source files', rule: 'Never remove access checks.' }
    )

    assert.equal(cr.mergedRuleText.includes('B unique evidence'), true, 'Merged rule must retain secondary catches')
    assert.match(cr.archivedRuleText, /\*\*Merged-Into:\*\* guard/, 'Archived rule must have structured Merged-Into pointer')
    const union = unionOrigins('2026-11-02 later', '2026-10-01 earlier')
    assert.match(union, /2026-10-01 earlier.*2026-11-02 later/, 'Origins must sort chronologically')
  })

  test('POSITIVE CONTROL 12 (repro:36-41): synthesizeMachineGate extracts exact case-sensitive pattern matching runtime/gate.mjs', async () => {
    const synthesized = synthesizeMachineGate({
      rule: { name: 'no-debug', rule: 'Never include `CONSOLE.LOG`.', trigger: 'editing src files' },
      incidentFixtures: [{
        id: 'case-1',
        positiveControl: { diff: '--- a/src/x.js\n+++ b/src/x.js\n+CONSOLE.LOG("leak")\n' },
        negativeControl: { diff: '--- a/src/x.js\n+++ b/src/x.js\n+logger.info("ok")\n' },
      }],
    })

    assert.equal(synthesized.success, true)
    assert.equal(synthesized.pattern, 'CONSOLE.LOG')

    // Run exact vendored runtime over file snapshot
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/x.js'), 'CONSOLE.LOG("leak")\n')
    const runtime = await evaluate({ root, mode: 'all', config: { version: 1, gates: [synthesized.gate] }, telemetry: false })
    assert.equal(runtime.fires.length, 1, 'Runtime must fire on matching case')
  })
})

describe('Independent Positive Controls: cli-repro.mjs cases 13 - 15', () => {
  test('POSITIVE CONTROL 13 (cli-repro:10-18): Subprocess CLI rule evolve rejects loosened candidate and preserves active rule in non-interactive mode', async () => {
    await mkdir(join(root, 'docs/rules/active'), { recursive: true })
    const makeRule = (body, enforcement = 'memory') =>
      `# guard\n\n**Trigger:** editing source files\n\n**Rule:** ${body}\n\n**Origin:** original-evidence\n\n**Enforcement:** ${enforcement}\n\n**Ratified:** 2026-10-01 by human\n`
    await writeFile(join(root, 'docs/rules/active/guard.md'), makeRule('Never use git add -A. Never commit production secrets.'))
    await writeFile(join(root, 'candidate.md'), makeRule('Allow git add -A.'))

    await saveIncident(root, {
      id: 'guard-case',
      rule: 'guard',
      positiveControl: { diff: '--- a/src/a.js\n+++ b/src/a.js\n+git add -A\n', expected: 'FAIL' },
      negativeControl: { diff: '--- a/src/a.js\n+++ b/src/a.js\n+git add src/a.js\n', expected: 'PASS' },
    })

    const evolve = runCli(['rule', 'evolve', 'guard', '--candidate', 'candidate.md'], root)
    assert.notEqual(evolve.exit, 0, 'CLI rule evolve with loosened candidate must fail')

    // Verify active rule remains completely unchanged
    const evolved = parseRule(await readFile(join(root, 'docs/rules/active/guard.md'), 'utf8'))
    assert.match(evolved.rule, /Never use git add -A/)
    assert.equal(evolved.ratified, '2026-10-01 by human')
  })

  test('POSITIVE CONTROL 14 (cli-repro:19-24): Subprocess CLI gate synthesize refuses to overwrite or downgrade existing blocking gate', async () => {
    await mkdir(join(root, 'docs/rules/active'), { recursive: true })
    await mkdir(join(root, '.caselaw'), { recursive: true })

    const makeRule = (body, enforcement = 'memory') =>
      `# guard\n\n**Trigger:** editing source files\n\n**Rule:** ${body}\n\n**Origin:** original-evidence\n\n**Enforcement:** ${enforcement}\n\n**Ratified:** 2026-10-01 by human\n`
    await writeFile(join(root, 'docs/rules/active/guard.md'), makeRule('Never use `git add -A`.', 'machine:guard'))
    await writeFile(
      join(root, '.caselaw/gates.json'),
      JSON.stringify({
        version: 1,
        gates: [{ id: 'guard', kind: 'command', severity: 'block', origin: 'docs/rules/active/guard.md', patterns: ['git add -A'] }],
      })
    )

    await saveIncident(root, {
      id: 'guard-case-2',
      rule: 'guard',
      positiveControl: { diff: '--- a/src/a.js\n+++ b/src/a.js\n+git add -A\n' },
      negativeControl: { diff: '--- a/src/a.js\n+++ b/src/a.js\n+git add src/a.js\n' },
    })

    const gate = runCli(['gate', 'synthesize', 'guard', '--yes'], root)
    assert.notEqual(gate.exit, 0, 'CLI gate synthesize must exit non-zero when overwriting an existing gate without --force')

    const after = JSON.parse(await readFile(join(root, '.caselaw/gates.json'), 'utf8')).gates[0]
    assert.equal(after.severity, 'block', 'Blocking severity must be preserved')
    assert.equal(after.kind, 'command', 'Original gate kind must be preserved')
  })

  test('POSITIVE CONTROL 15 (cli-repro:25-27): Subprocess context routing compacts object-shaped machine enforcement', () => {
    const routing = selectTriggeredRules(
      [
        {
          name: 'guard',
          trigger: 'editing `src/`',
          rule: 'Never break.',
          raw: 'Long original body.',
          enforcement: { mode: 'machine', gateId: 'guard', raw: 'machine:guard' },
        },
      ],
      ['src/a.js']
    )
    assert.equal(routing.length, 1)
    assert.equal(routing[0].compacted, true)
    assert.equal(routing[0].rule, '[Enforced by machine gate: guard]')
  })
})

describe('Independent Positive Controls: Structural Safeguards 16 & 17', () => {
  test('POSITIVE CONTROL 16: selectTriggeredRules enforces strict word budget cap without admitting oversize first rule', () => {
    const hugeRule = {
      name: 'huge-rule',
      trigger: 'editing `src/`',
      rule: Array.from({ length: 100 }, (_, i) => `word${i}`).join(' '),
      raw: Array.from({ length: 100 }, (_, i) => `word${i}`).join(' '),
      enforcement: 'memory',
    }
    const selected = selectTriggeredRules([hugeRule], ['src/file.js'], { budget: 5 })
    assert.equal(selected.length, 0, 'Rule exceeding budget of 5 words must NOT be admitted')
  })

  test('POSITIVE CONTROL 17: Non-interactive rule evolve stages valid candidate to docs/rules/proposed/ (Axiom A1)', async () => {
    await mkdir(join(root, 'docs/rules/active'), { recursive: true })
    const rulePath = join(root, 'docs/rules/active/stage-guard.md')
    const originalRule = `# stage-guard\n\n**Trigger:** git add or commit\n\n**Rule:** Please make sure to explicitly stage files by name. Never use git add -A or git add .\n\n**Origin:** commit 123456\n\n**Enforcement:** memory\n\n**Ratified:** 2026-08-13\n`
    await writeFile(rulePath, originalRule, 'utf8')

    // Contrastive fixture
    await saveIncident(root, {
      id: 'case-stage',
      rule: 'stage-guard',
      positiveControl: { diff: '--- a/x.js\n+++ b/x.js\n+git add -A\n', expected: 'FAIL' },
      negativeControl: { diff: '--- a/x.js\n+++ b/x.js\n+git add x.js\n', expected: 'PASS' },
    })

    const candPath = join(root, 'candidate-compressed.md')
    const candidateRule = `# stage-guard\n\n**Trigger:** git add or commit\n\n**Rule:** Explicitly stage files by name. Never sweep with git add -A or git add .\n\n**Origin:** commit 123456\n\n**Enforcement:** memory\n\n**Ratified:** 2026-08-13\n`
    await writeFile(candPath, candidateRule, 'utf8')

    const io = makeIO()
    const exitCode = await cmdRule({
      sub: 'evolve',
      name: 'stage-guard',
      opt: { candidate: 'candidate-compressed.md', compress: true },
    }, { root, ...io })

    assert.equal(exitCode, 0, 'Valid compressed candidate must succeed')
    assert.ok(io.lines.some((l) => l.includes('staged to docs/rules/proposed/stage-guard.md')))

    // Active rule must remain unchanged (Axiom A1)
    const activeCurrent = await readFile(rulePath, 'utf8')
    assert.match(activeCurrent, /Please make sure to explicitly stage/)

    // Proposed rule contains the evolved candidate
    const proposed = await readFile(join(root, 'docs/rules/proposed/stage-guard.md'), 'utf8')
    assert.match(proposed, /Explicitly stage files by name/)
  })

  test('POSITIVE CONTROL 18: matchesTriggerPath correctly handles recursive ** globs', () => {
    assert.equal(matchesTriggerPath('editing `src/**/*.js`', 'src/a/b/file.js'), true)
    assert.equal(matchesTriggerPath('editing `src/**/*.js`', 'test/a/b/file.js'), false)
  })

  test('POSITIVE CONTROL 19: RejectedEditBuffer normalizes whitespace variations and extra blank lines', () => {
    const buffer = new RejectedEditBuffer(5)
    const diff1 = 'TRIGGER: edit\n\nRULE: do not break'
    const diff2 = 'TRIGGER: edit\n\n\n\nRULE: do not break'

    buffer.record({ diff: diff1, stage: 1, failureReason: 'test' })
    assert.equal(buffer.isRejected(diff2), true, 'Blank line variations must match same hash')
  })

  test('POSITIVE CONTROL 20: reconstructFileFromDiff strips git header metadata', async () => {
    const { reconstructFileFromDiff } = await import('../../src/core/gates.js')
    const diff = `diff --git a/src/app.js b/src/app.js\nindex 1234567..89abcdef 100644\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,3 +1,3 @@\n const x = 1;\n-console.log("old");\n+console.log("new");\n`
    const content = reconstructFileFromDiff(diff)
    assert.equal(content.includes('diff --git'), false, 'git diff header must be stripped')
    assert.equal(content.includes('index 1234567'), false, 'index line must be stripped')
    assert.equal(content.includes('const x = 1;'), true, 'context line must be preserved')
    assert.equal(content.includes('console.log("new");'), true, 'added line must be preserved')
  })

  test('POSITIVE CONTROL 21: verifyCloseout catches zero-width spaces and homoglyph evasions of human authority items', () => {
    // Zero-width space evasion: "u\u200Bi"
    const zwspCloseout = '## What Changed\n-\n\n## Verified\n- checked u\u200Bi layout\n\n## Not Verified — over to you\n- [ ] see what the UI actually renders\n'
    const resZWSP = verifyCloseout({ text: zwspCloseout, gitFiles: [] })
    assert.equal(resZWSP.valid, false, 'Closeout with zero-width space in authority keyword must be rejected')

    // Cyrillic homoglyph evasion: "\u0440rod"
    const homoglyphCloseout = '## What Changed\n-\n\n## Verified\n- inspected \u0440rod state\n\n## Not Verified — over to you\n- [ ] see what the UI actually renders\n'
    const resHomoglyph = verifyCloseout({ text: homoglyphCloseout, gitFiles: [] })
    assert.equal(resHomoglyph.valid, false, 'Closeout with Cyrillic homoglyph in prod keyword must be rejected')
  })

  test('POSITIVE CONTROL 22: verifyCloseout catches "exit status 1" and command status phrasings', () => {
    const failCloseout = '## What Changed\n-\n\n## Verified\n- run test suite — exit status 1\n\n## Not Verified — over to you\n- [ ] see what the UI actually renders\n'
    const res = verifyCloseout({ text: failCloseout, gitFiles: [] })
    assert.equal(res.valid, false, 'Closeout with exit status 1 inside Verified must be rejected')
    assert.ok(res.errors.some((e) => e.includes('Failing command placed inside ## Verified')))
  })

  test('POSITIVE CONTROL 23: reconstituteRuleAST rejects section header injection with homoglyphs', () => {
    const rule = '# guard\n\n**Trigger:** editing source files\n\n**Rule:** Never remove access checks.\n\n**Origin:** abc123\n\n**Enforcement:** machine:guard\n\n**Ratified:** 2026-10-01 by human\n'
    const ast = splitRuleAST(rule)

    // Cyrillic capital E in Enforcement: "\u0415nforcement"
    assert.throws(
      () => reconstituteRuleAST(ast, { rule: 'Never remove access checks.\n\n**\u0415nforcement:** memory' }),
      /A2: Section headers cannot be injected/
    )
  })
})
