/**
 * Unit tests for Contrastive Incident Fixtures (0.4 / SkillOpt).
 *
 * Verifies that incident fixtures store Contrastive Pairs (Positive + Negative
 * Controls), reject malformed definitions, enforce distinct diffs, and save/load
 * cleanly without external dependencies.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { cmdRule } from '../../src/commands/rule.js'

import {
  saveIncident,
  readIncident,
  listIncidents,
  validateIncident,
  IncidentError,
} from '../../src/core/incidents.js'

let root
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-incidents-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const FIXTURE_VALID = {
  id: 'INC-2026-0813-01',
  rule: 'stage-explicit-paths',
  positiveControl: {
    commit: 'a1b2c3d4',
    diff: '--- a/deploy.sh\n+++ b/deploy.sh\n@@ -1 +1 @@\n-git add src/index.js\n+git add -A\n',
    description: 'Swept untracked secrets into git stage',
    expected: 'FAIL',
  },
  negativeControl: {
    commit: 'e5f6g7h8',
    diff: '--- a/deploy.sh\n+++ b/deploy.sh\n@@ -1 +1 @@\n-git add -A\n+git add src/index.js\n',
    description: 'Explicitly staged only the intended deployment script',
    expected: 'PASS',
  },
}

describe('incident fixture validation', () => {
  test('POSITIVE CONTROL: valid contrastive pair is accepted and normalized', () => {
    const validated = validateIncident(FIXTURE_VALID)
    assert.equal(validated.id, 'INC-2026-0813-01')
    assert.equal(validated.rule, 'stage-explicit-paths')
    assert.equal(validated.positiveControl.expected, 'FAIL')
    assert.equal(validated.negativeControl.expected, 'PASS')
  })

  test('POSITIVE CONTROL: identical diffs between positive and negative control are refused', () => {
    const identical = {
      ...FIXTURE_VALID,
      negativeControl: {
        ...FIXTURE_VALID.negativeControl,
        diff: FIXTURE_VALID.positiveControl.diff,
      },
    }
    assert.throws(() => validateIncident(identical), {
      name: 'IncidentError',
      code: 'IDENTICAL_CONTROLS',
    })
  })

  test('POSITIVE CONTROL: missing positiveControl is refused', () => {
    const missing = { ...FIXTURE_VALID }
    delete missing.positiveControl
    assert.throws(() => validateIncident(missing), {
      name: 'IncidentError',
      code: 'MISSING_POSITIVE',
    })
  })

  test('POSITIVE CONTROL: missing negativeControl is refused', () => {
    const missing = { ...FIXTURE_VALID }
    delete missing.negativeControl
    assert.throws(() => validateIncident(missing), {
      name: 'IncidentError',
      code: 'MISSING_NEGATIVE',
    })
  })

  test('POSITIVE CONTROL: invalid id format is refused', () => {
    const badId = { ...FIXTURE_VALID, id: 'bad id with spaces!' }
    assert.throws(() => validateIncident(badId), {
      name: 'IncidentError',
      code: 'INVALID_ID',
    })
  })

  test('POSITIVE CONTROL: empty target rule name is refused', () => {
    const noRule = { ...FIXTURE_VALID, rule: '   ' }
    assert.throws(() => validateIncident(noRule), {
      name: 'IncidentError',
      code: 'MISSING_RULE',
    })
  })
})

describe('incident persistence and listing', () => {
  test('POSITIVE CONTROL: saved incident can be read back identically', async () => {
    const path = await saveIncident(root, FIXTURE_VALID)
    assert.match(path, /\.caselaw\/incidents\/INC-2026-0813-01\.json$/)

    const read = await readIncident(root, 'INC-2026-0813-01')
    assert.equal(read.id, FIXTURE_VALID.id)
    assert.equal(read.rule, FIXTURE_VALID.rule)
    assert.equal(read.positiveControl.commit, 'a1b2c3d4')
    assert.equal(read.negativeControl.commit, 'e5f6g7h8')
  })

  test('POSITIVE CONTROL: listIncidents filters by target rule name', async () => {
    await saveIncident(root, FIXTURE_VALID)
    await saveIncident(root, {
      ...FIXTURE_VALID,
      id: 'INC-2026-0813-02',
      rule: 'no-untested-boundaries',
      positiveControl: {
        ...FIXTURE_VALID.positiveControl,
        diff: '--- a/schema.sql\n+++ b/schema.sql\n@@ -1 +1 @@\n-col1\n+col2\n',
      },
    })

    const all = await listIncidents(root)
    assert.equal(all.length, 2)

    const filtered = await listIncidents(root, { rule: 'stage-explicit-paths' })
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].id, 'INC-2026-0813-01')

    const empty = await listIncidents(root, { rule: 'nonexistent-rule' })
    assert.equal(empty.length, 0)
  })

  test('POSITIVE CONTROL: readIncident throws NOT_FOUND for nonexistent id', async () => {
    await assert.rejects(
      async () => readIncident(root, 'INC-MISSING'),
      { name: 'IncidentError', code: 'NOT_FOUND' }
    )
  })

  test('POSITIVE CONTROL: caselaw rule catch --commit --fix automatically creates contrastive incident fixture', async () => {
    const exec = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' })
    exec('git', ['init'])
    exec('git', ['config', 'user.name', 'Tester'])
    exec('git', ['config', 'user.email', 'test@test.local'])

    await writeFile(join(root, 'app.js'), 'console.log(1)\n')
    exec('git', ['add', 'app.js'])
    exec('git', ['commit', '-m', 'init'])

    // Bad commit
    await writeFile(join(root, 'secret.env'), 'SECRET=1\n')
    exec('git', ['add', '-A'])
    exec('git', ['commit', '-m', 'leak'])
    const badSha = exec('git', ['rev-parse', 'HEAD']).trim()

    // Clean fix commit
    exec('git', ['rm', 'secret.env'])
    await writeFile(join(root, 'app.js'), 'console.log(2)\n')
    exec('git', ['add', 'app.js'])
    exec('git', ['commit', '-m', 'fix'])
    const cleanSha = exec('git', ['rev-parse', 'HEAD']).trim()

    // Add active rule
    await mkdir(join(root, 'docs/rules/active'), { recursive: true })
    const ruleContent = `# stage-explicit\n\n**Trigger:** git add operations\n\n**Rule:** Explicitly stage files.\n\n**Origin:** unverified\n\n**Enforcement:** memory\n`
    await writeFile(join(root, 'docs/rules/active/stage-explicit.md'), ruleContent)

    const lines = []
    const io = { say: (s) => lines.push(s), interactive: false, prompt: () => ({}) }
    const code = await cmdRule({
      sub: 'catch',
      name: 'stage-explicit',
      opt: { what: `commit ${badSha}: swept untracked secret`, commit: badSha, fix: cleanSha },
    }, { root, ...io })

    assert.equal(code, 0)
    assert.ok(lines.some((l) => l.includes('Captured contrastive incident fixture')))

    const incidents = await listIncidents(root, { rule: 'stage-explicit' })
    assert.equal(incidents.length, 1)
    assert.equal(incidents[0].positiveControl.commit, badSha)
    assert.equal(incidents[0].negativeControl.commit, cleanSha)
  })
})
