/**
 * Gate config validation must reject what the runtime would drop.
 *
 * src/core/gates.js validated id, kind, severity, origin, paths, message and
 * grandfather — and nothing a kind actually needs. A shell gate whose command
 * was an argv array, or "npm run lint", passed validation, was written by
 * `rule promote`, and was dropped by runtime/gate.mjs at load with a message
 * nobody read. A gate that validates, is saved, and checks nothing is the
 * decorative guardrail this tool exists to prevent, and it shipped one.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { KINDS, MODES, validateGate } from '../../src/core/gates.js'
import { KINDS as RUNTIME_KINDS, MODES as RUNTIME_MODES } from '../../runtime/gate.mjs'

const base = { id: 'g', origin: 'docs/rules/active/g.md', message: 'm', paths: ['src/**'] }
const errors = (g) => validateGate(g).filter((p) => p.severity === 'error').map((p) => p.code)

describe('gate validation — what the runtime reads, and only that', () => {
  test('the config layer, the runtime and the schema agree on kinds and modes', async () => {
    assert.deepEqual(KINDS, RUNTIME_KINDS)
    assert.deepEqual(MODES, RUNTIME_MODES)
    const schema = JSON.parse(await readFile(new URL('../../runtime/schema/gates.schema.json', import.meta.url), 'utf8'))
    assert.deepEqual(schema.$defs.gate.properties.kind.enum, KINDS)
    assert.deepEqual(schema.$defs.gate.properties.modes.items.enum, MODES)
  })

  test('POSITIVE CONTROL: each kind is rejected without the field the runtime requires', () => {
    assert.ok(errors({ ...base, kind: 'banned-content' }).includes('no-patterns'))
    assert.ok(errors({ ...base, kind: 'banned-content', patterns: [] }).includes('no-patterns'))
    assert.ok(errors({ ...base, kind: 'banned-content', patterns: 'not-an-array' }).includes('no-patterns'))
    assert.ok(errors({ ...base, kind: 'required-content' }).includes('no-requires'))
    assert.ok(errors({ ...base, kind: 'cross-file', assert: [{ type: 'unique', of: 'a' }] }).includes('no-extract'))
    assert.ok(errors({ ...base, kind: 'cross-file', extract: [{ name: 'a', file: 'x.json' }] }).includes('no-assert'))
    assert.ok(errors({ ...base, kind: 'file-invariant' }).includes('no-assertion'))
    assert.ok(errors({ ...base, kind: 'paired-edit', require: ['b/**'] }).includes('no-when'))
    assert.ok(errors({ ...base, kind: 'paired-edit', when: ['a/**'] }).includes('no-require'))
    assert.ok(errors({ ...base, kind: 'shell' }).includes('bad-command'))
    assert.ok(errors({ ...base, kind: 'shell', command: ['npm', 'run', 'lint'] }).includes('bad-command'))
    assert.ok(errors({ ...base, kind: 'shell', command: 'npm run lint' }).includes('bad-command'))
    assert.ok(errors({ ...base, kind: 'shell', command: 'eslint', cwd: '../..' }).includes('bad-cwd'))
    assert.ok(errors({ ...base, kind: 'shell', command: 'eslint', cwd: '/tmp' }).includes('bad-cwd'))
    assert.ok(errors({ ...base, kind: 'path-scope', paths: [] }).includes('no-paths'))
    assert.ok(errors({ ...base, modes: ['bogus'] }).includes('bad-modes'))
    assert.ok(errors({ ...base, kind: 'banned-content', patterns: [{ literal: 'x' }], grandfather: [{ reason: 'r', expires: '2099-01-01' }] }).includes('grandfather-no-context'))
    assert.ok(errors({ ...base, kind: 'banned-content', patterns: [{ literal: 'x' }], grandfather: [{ context: 'c', reason: 'r', expires: 'soon' }] }).includes('grandfather-bad-expiry'))
  })

  test('true negatives: the shapes the runtime runs are accepted', () => {
    assert.deepEqual(errors({ ...base, kind: 'banned-content', patterns: [{ literal: 'x' }] }), [])
    assert.deepEqual(errors({ ...base, kind: 'required-content', requires: [{ regex: '^# ' }] }), [])
    assert.deepEqual(errors({ ...base, kind: 'cross-file', extract: [{ name: 'a', file: 'a.json', pointer: '/x' }], assert: [{ type: 'unique', of: 'a' }] }), [])
    assert.deepEqual(errors({ ...base, kind: 'file-invariant', parses: 'json' }), [])
    assert.deepEqual(errors({ ...base, kind: 'paired-edit', when: ['db/schema.sql'], require: ['db/migrations/**'] }), [])
    assert.deepEqual(errors({ ...base, kind: 'shell', command: 'eslint', args: ['--max-warnings', '0'], cwd: 'packages/web' }), [])
    assert.deepEqual(errors({ ...base, kind: 'path-scope', paths: ['generated/**'] }), [])
  })

  test('policy matches the schema: missing severity defaults, missing paths warns except where scope is the gate', () => {
    const p = validateGate({ ...base, kind: 'banned-content', patterns: [{ literal: 'x' }], severity: undefined })
    assert.ok(!p.some((x) => x.code === 'bad-severity'), 'a missing severity is the schema default, warn')
    const unscoped = validateGate({ id: 'g', origin: 'o', message: 'm', kind: 'banned-content', patterns: [{ literal: 'x' }] })
    assert.ok(unscoped.some((x) => x.code === 'no-paths' && x.severity === 'warn'))
    assert.ok(errors({ id: 'g', origin: 'o', message: 'm', kind: 'shell', command: 'eslint' }).includes('no-paths'))
    const gf = validateGate({ ...base, kind: 'path-scope', grandfather: [{ context: 'c', reason: 'r', expires: '2099-01-01' }] })
    assert.ok(gf.some((x) => x.code === 'grandfather-ignored' && x.severity === 'warn'), 'only banned-content honours grandfather')
  })
})

import { test as _c6test } from 'node:test'

import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGate } from '../../src/core/promote.js'
import { loadConfig } from '../../runtime/gate.mjs'

_c6test('POSITIVE CONTROL: buildGate must reject a shell gate the runtime will drop at load', async () => {
  const RULE = {
    name: 'lint-clean',
    file: 'docs/rules/active/lint-clean.md',
    rule: 'The linter must pass before anything ships.',
  }

  // Every shape here validates today, is written to gates.json, and is then
  // dropped by the runtime — a gate that validated, was saved, and checks
  // nothing. The two validators must not disagree.
  const cases = [
    { label: 'command as an argv array', answers: { paths: ['src/**'], command: ['npm', 'run', 'lint'] } },
    { label: 'command as a shell string', answers: { paths: ['src/**'], command: 'npm run lint' } },
    { label: 'command empty', answers: { paths: ['src/**'], command: '' } },
    { label: 'command missing', answers: { paths: ['src/**'] } },
  ]

  const root = await fs.mkdtemp(join(tmpdir(), 'caselaw-c6-'))
  await fs.mkdir(join(root, '.caselaw'), { recursive: true })

  for (const c of cases) {
    const { gate, ok, problems } = buildGate({ rule: RULE, kind: 'shell', answers: c.answers })
    await fs.writeFile(
      join(root, '.caselaw/gates.json'),
      JSON.stringify({ version: 1, gates: [gate] }, null, 2) + '\n',
      'utf8',
    )
    const loaded = await loadConfig(root)
    const dropped = loaded.problems.filter((p) => p.level === 'dropped')
    if (dropped.length === 0) continue // the runtime accepted it; nothing to prove here

    assert.equal(
      ok,
      false,
      `${c.label}: buildGate returned ok=${ok} with problems ${JSON.stringify(problems)}, ` +
        `but the runtime drops the saved gate: ${dropped.map((p) => p.message).join('; ')}`,
    )
    assert.ok(
      problems.some((p) => p.severity === 'error'),
      `${c.label}: buildGate reported no error-severity problem for a gate the runtime refuses to run`,
    )
    assert.equal(
      loaded.gates.length,
      0,
      `${c.label}: sanity — the runtime should have loaded no gates`,
    )
  }
})