import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { suggestKinds, buildGate, baselineDisposition, enforcementLine, MECHANISABLE } from '../../src/core/promote.js'

const RULE = {
  name: 'no-em-dash-in-copy',
  file: 'docs/rules/active/no-em-dash-in-copy.md',
  trigger: 'authoring user-facing copy',
  rule: 'An em dash must never appear in shipped copy. Restructure the sentence; never swap it for a comma.',
}

describe('promote — suggesting a gate kind from what the rule says', () => {
  test('a "must never" rule suggests banned-content first', () => {
    assert.equal(suggestKinds(RULE)[0].kind, 'banned-content')
  })

  test('a sync rule suggests cross-file first', () => {
    const r = { trigger: 'editing the manifest', rule: 'The manifest and the content it indexes must stay in sync.' }
    assert.equal(suggestKinds(r)[0].kind, 'cross-file')
  })

  test('a generated-directory rule suggests path-scope first', () => {
    const r = { trigger: 'editing build output', rule: 'Never edit generated files; they are vendored and read-only.' }
    assert.equal(suggestKinds(r)[0].kind, 'path-scope')
  })

  test('every kind is always offered — the hint orders the menu, it does not filter it', () => {
    assert.equal(suggestKinds(RULE).length, MECHANISABLE.length,
      'the human picks; a heuristic must never hide an option')
  })
})

describe('promote — building the gate', () => {
  test('POSITIVE CONTROL: a promoted gate is ALWAYS born on warn, never blocking', () => {
    for (const kind of MECHANISABLE.map((m) => m.kind)) {
      const { gate } = buildGate({
        rule: RULE, kind,
        answers: { paths: ['content/**'], patterns: [{ literal: '—', label: 'em dash' }], command: ['true'], pairedWith: ['x'] },
      })
      assert.equal(gate.severity, 'warn',
        `${kind} was born blocking; a gate that blocks pre-existing work gets disabled on day one`)
    }
  })

  test('the gate carries the rule as its origin, so the graph stays traceable', () => {
    const { gate } = buildGate({ rule: RULE, kind: 'banned-content', answers: { paths: ['content/**'], patterns: [{ literal: '—' }] } })
    assert.equal(gate.origin, RULE.file)
  })

  test('the message defaults to the rule’s first sentence rather than being blank', () => {
    const { gate } = buildGate({ rule: RULE, kind: 'banned-content', answers: { paths: ['x/**'], patterns: [{ literal: '—' }] } })
    assert.match(gate.message, /An em dash must never appear in shipped copy\./)
  })

  test('POSITIVE CONTROL: a gate with no paths fails validation before it can be written', () => {
    const { ok, problems } = buildGate({ rule: RULE, kind: 'banned-content', answers: { paths: [], patterns: [] } })
    assert.equal(ok, false)
    assert.ok(problems.some((p) => p.code === 'no-paths'))
  })

  test('an unknown kind throws rather than producing a silently empty gate', () => {
    assert.throws(() => buildGate({ rule: RULE, kind: 'telepathy' }), /No such gate kind/)
  })
})

describe('promote — the baseline pass', () => {
  test('a clean baseline says so, and explains that block is still unearned', () => {
    const d = baselineDisposition([])
    assert.equal(d.clean, true)
    assert.match(d.note, /earn block/)
  })

  test('POSITIVE CONTROL: existing violations force a choice; none of them is "ignore"', () => {
    const d = baselineDisposition([{ path: 'a.md', line: 3 }, { path: 'b.md', line: 9 }])
    assert.equal(d.count, 2)
    assert.deepEqual(d.choices, ['fix', 'grandfather', 'drop'])
    assert.ok(!d.choices.includes('ignore'))
    assert.match(d.note, /disabled on day one/)
  })

  test('a suggested expiry is always offered, so no exception is open-ended', () => {
    const d = baselineDisposition([{ path: 'a.md' }], { now: new Date('2026-08-13'), graceDays: 90 })
    assert.equal(d.suggestedExpiry, '2026-11-11')
  })
})

describe('promote — the rule keeps its prose', () => {
  test('the enforcement line points at the gate', () => {
    assert.equal(enforcementLine('no-em-dash'), 'machine:no-em-dash')
  })
})

describe('promote — what it generates must be what the runner reads', () => {
  // The failure this closes: promote.js emitted `required`, `pairedWith` and an
  // array `command`, none of which the runner reads. Every generated gate
  // would have loaded, validated, and silently checked nothing — a guardrail
  // that exists in the config and nowhere else. Authoring and enforcement have
  // to be tested together or they drift apart in exactly this way.
  test('POSITIVE CONTROL: every generated gate actually fires in the real runner', async () => {
    const { evaluate } = await import('../../runtime/gate.mjs')
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const root = await mkdtemp(join(tmpdir(), 'caselaw-promote-e2e-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/a.js'), 'const s = "BANNED"\n', 'utf8')

    const { gate, ok } = buildGate({
      rule: RULE, kind: 'banned-content',
      answers: { paths: ['src/**'], patterns: [{ literal: 'BANNED', label: 'banned token' }] },
    })
    assert.equal(ok, true)

    const r = await evaluate({
      root, mode: 'all', telemetry: false,
      config: { version: 1, gates: [{ ...gate, severity: 'block' }] },
    })
    assert.equal(r.ok, false, 'a gate built by promote must actually fire in the runner')
    assert.equal(r.config.problems.filter((p) => p.severity === 'error').length, 0,
      'and it must load without validation errors')
  })

  test('POSITIVE CONTROL: required-content uses the field name the runner reads', () => {
    const { gate } = buildGate({
      rule: RULE, kind: 'required-content',
      answers: { paths: ['src/**'], patterns: [{ literal: '@licence', label: 'licence' }] },
    })
    assert.ok(gate.requires, 'the runner reads `requires`; `required` would be silently ignored')
    assert.ok(!('required' in gate))
  })

  test('POSITIVE CONTROL: paired-edit uses when/require, not paths/pairedWith', () => {
    const { gate } = buildGate({
      rule: RULE, kind: 'paired-edit',
      answers: { paths: ['db/schema.sql'], pairedWith: ['db/migrations/**'] },
    })
    assert.deepEqual(gate.when, ['db/schema.sql'])
    assert.deepEqual(gate.require, ['db/migrations/**'])
  })
})
