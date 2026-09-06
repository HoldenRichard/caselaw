import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyConfig, load, save, validateGate, validateConfig, readFires, recordFire,
  promotionStatus, promote, crossCheck, GateError, PROMOTION_THRESHOLD,
} from '../../src/core/gates.js'

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'caselaw-gates-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const goodGate = (over = {}) => ({
  id: 'no-home-paths',
  kind: 'banned-content',
  severity: 'warn',
  paths: ['docs/**/*.md'],
  origin: 'docs/rules/active/no-machine-paths.md',
  message: 'Absolute home paths leak your machine into the repo.',
  patterns: [{ regex: '/Users/[a-z]', label: 'home path' }],
  ...over,
})

describe('gate config — validation', () => {
  test('a well-formed gate passes clean', () => {
    assert.deepEqual(validateGate(goodGate()), [])
  })

  test('POSITIVE CONTROL: a gate with no origin is rejected', () => {
    const p = validateGate(goodGate({ origin: undefined }))
    const found = p.find((x) => x.code === 'missing-origin')
    assert.ok(found && found.severity === 'error')
    assert.match(found.hint, /orphaned gate/,
      'the message must explain why the backlink matters, not just demand it')
  })

  test('POSITIVE CONTROL: an unscoped gate is rejected', () => {
    const p = validateGate(goodGate({ paths: [] }))
    // The schema says omitted paths mean every candidate file, and the runtime
    // agrees; that is a warning here. It is an error only where scope IS the gate.
    assert.ok(p.some((x) => x.code === 'no-paths' && x.severity === 'warn'))
    assert.ok(validateGate(goodGate({ kind: 'shell', command: 'eslint', paths: [] })).some((x) => x.code === 'no-paths' && x.severity === 'error'))
  })

  test('POSITIVE CONTROL: an unknown kind is rejected rather than ignored', () => {
    const p = validateGate(goodGate({ kind: 'vibes' }))
    assert.ok(p.some((x) => x.code === 'unknown-kind' && x.severity === 'error'))
  })

  test('POSITIVE CONTROL: a grandfather entry without an expiry is rejected', () => {
    const p = validateGate(goodGate({ grandfather: [{ context: 'legacy', reason: 'predates' }] }))
    const found = p.find((x) => x.code === 'grandfather-no-expiry')
    assert.ok(found && found.severity === 'error')
    assert.match(found.hint, /outlives the reason/,
      'an exception with no date is the failure mode being prevented')
  })

  test('POSITIVE CONTROL: a grandfather entry without a reason is rejected', () => {
    const p = validateGate(goodGate({ grandfather: [{ context: 'legacy', expires: '2027-01-01' }] }))
    assert.ok(p.some((x) => x.code === 'grandfather-no-reason'))
  })

  test('a bad severity is rejected; only warn and block exist', () => {
    assert.ok(validateGate(goodGate({ severity: 'maybe' })).some((x) => x.code === 'bad-severity'))
  })

  test('duplicate ids across the config are caught', () => {
    const { ok, problems } = validateConfig({ version: 1, gates: [goodGate(), goodGate()] })
    assert.equal(ok, false)
    assert.ok(problems.some((p) => p.code === 'duplicate-id'))
  })

  test('a missing message is a warning, not a blocker', () => {
    const p = validateGate(goodGate({ message: undefined }))
    assert.ok(p.every((x) => x.severity !== 'error'))
  })
})

describe('gate config — persistence', () => {
  test('round-trips, and load returns null when absent', async () => {
    assert.equal(await load(root), null)
    await save(root, { version: 1, gates: [goodGate()] })
    const back = await load(root)
    assert.equal(back.gates[0].id, 'no-home-paths')
  })

  test('POSITIVE CONTROL: a future schema version is refused, not guessed at', async () => {
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await writeFile(join(root, '.caselaw/gates.json'), JSON.stringify({ version: 99, gates: [] }))
    await assert.rejects(() => load(root), (e) => e instanceof GateError && e.code === 'SCHEMA_MISMATCH')
  })
})

describe('promotion is earned, not chosen', () => {
  const fire = (n) => Array.from({ length: n }, () => recordFire(root, { gate: 'no-home-paths', mode: 'staged', path: 'docs/a.md', severity: 'warn' }))

  test('a gate that has never fired is not eligible', async () => {
    const s = await promotionStatus(root, 'no-home-paths')
    assert.equal(s.fires, 0)
    assert.equal(s.eligible, false)
  })

  test('POSITIVE CONTROL: promoting an unearned gate is refused, with the count', async () => {
    await save(root, { version: 1, gates: [goodGate()] })
    await Promise.all(fire(PROMOTION_THRESHOLD - 1))

    await assert.rejects(
      () => promote(root, 'no-home-paths'),
      (e) => {
        assert.equal(e.code, 'NOT_EARNED')
        assert.equal(e.status.fires, PROMOTION_THRESHOLD - 1)
        assert.match(e.hint, /never caught anything real/)
        return true
      },
    )
    const after = await load(root)
    assert.equal(after.gates[0].severity, 'warn', 'the config must be untouched by a refused promotion')
  })

  test('a gate that has earned it is promoted, and records why', async () => {
    await save(root, { version: 1, gates: [goodGate()] })
    await Promise.all(fire(PROMOTION_THRESHOLD))

    const res = await promote(root, 'no-home-paths')
    assert.equal(res.status.eligible, true)
    const after = await load(root)
    assert.equal(after.gates[0].severity, 'block')
    assert.match(after.gates[0].promotedOn, /recorded fires/,
      'the config should say what justified blocking, not just that it does')
  })

  test('--force overrides, and is recorded as forced rather than as evidence', async () => {
    await save(root, { version: 1, gates: [goodGate()] })
    const res = await promote(root, 'no-home-paths', { force: true })
    assert.equal(res.forced, true)
    const after = await load(root)
    assert.equal(after.gates[0].severity, 'block')
    assert.equal(after.gates[0].promotedOn, 'forced', 'a forced promotion must not look like an earned one')
  })

  test('promoting an unknown gate is an error, not a silent no-op', async () => {
    await save(root, { version: 1, gates: [goodGate()] })
    await assert.rejects(() => promote(root, 'nope'), (e) => e.code === 'NO_SUCH_GATE')
  })

  test('telemetry never throws, even with no writable .caselaw', async () => {
    await recordFire('/nonexistent-path-xyz', { gate: 'x' })
    assert.ok(true, 'a failed telemetry write must not fail the run')
  })

  test('a corrupt fire log degrades to what is readable rather than crashing', async () => {
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await writeFile(join(root, '.caselaw/gate-fires.jsonl'), '{"gate":"a"}\nNOT JSON\n{"gate":"a"}\n')
    assert.equal((await readFires(root)).length, 2)
  })
})

describe('the rules⇄gates graph', () => {
  test('POSITIVE CONTROL: a rule claiming machine:x with no gate x is an error', () => {
    const problems = crossCheck({
      rules: [{ name: 'r', file: 'docs/rules/active/r.md', enforcement: { mode: 'machine', gateId: 'ghost' } }],
      config: emptyConfig(),
    })
    const found = problems.find((p) => p.code === 'enforcement-unbacked')
    assert.ok(found && found.severity === 'error')
    assert.match(found.hint, /worse than one claiming none/)
  })

  test('POSITIVE CONTROL: a gate whose origin rule was deleted is reported orphaned', () => {
    const problems = crossCheck({
      rules: [],
      config: { version: 1, gates: [goodGate()] },
    })
    assert.ok(problems.some((p) => p.code === 'gate-orphaned'))
  })

  test('a matched rule and gate produce no findings', () => {
    const problems = crossCheck({
      rules: [{ name: 'no-machine-paths', file: 'docs/rules/active/no-machine-paths.md', enforcement: { mode: 'machine', gateId: 'no-home-paths' } }],
      config: { version: 1, gates: [goodGate()] },
    })
    assert.deepEqual(problems, [])
  })

  test('a memory-enforced rule needs no gate and is not flagged', () => {
    const problems = crossCheck({
      rules: [{ name: 'r', file: 'docs/rules/active/r.md', enforcement: { mode: 'memory' } }],
      config: emptyConfig(),
    })
    assert.deepEqual(problems, [])
  })
})
