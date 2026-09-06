/**
 * Commands that must not write.
 *
 * `init --dry-run` printed "nothing written" after persisting the interview
 * answers — the per-answer write-back ran before the dry-run check. `doctor`
 * ran the vendored runner with telemetry on, so a diagnostic manufactured the
 * fire-log rows that promote a warn gate to block. Both are the same failure:
 * a read-only command with a side effect nothing reported.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import * as answersStore from '../../src/core/answers.js'
import { doctor } from '../../src/commands/lifecycle.js'

test('POSITIVE CONTROL: `init --dry-run` writes nothing, and `doctor` does not append gate telemetry', async () => {
  const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
  const RUNTIME = fileURLToPath(new URL('../../runtime/gate.mjs', import.meta.url))
  const exists = async (p) => { try { await fs.stat(p); return true } catch { return false } }

  const mkrepo = async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'caselaw-c3-'))
    const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' })
    git('init', '-q')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 'Tester')
    await fs.writeFile(join(root, 'README.md'), '# fixture\n\nFORBIDDEN_TOKEN lives here.\n', 'utf8')
    git('add', '-A')
    git('commit', '-qm', 'fixture')
    return root
  }

  // ---- A: `init --dry-run` must leave the tree exactly as it found it. -----
  const rootA = await mkrepo()
  try {
    execFileSync(process.execPath, [CLI, 'init', rootA, '--dry-run'], {
      input: '', stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, NO_COLOR: '1' },
    })
    assert.equal(
      await exists(join(rootA, '.caselaw')),
      false,
      '--dry-run said "nothing written" but created .caselaw/',
    )
    assert.equal(
      await exists(join(rootA, '.caselaw', 'answers.json')),
      false,
      '--dry-run persisted interview answers to .caselaw/answers.json',
    )
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], { cwd: rootA, encoding: 'utf8' }).trim(),
      '',
      '--dry-run dirtied the working tree',
    )
  } finally {
    await fs.rm(rootA, { recursive: true, force: true })
  }

  // ---- B: `doctor` is a diagnostic; it must not add rows to the fire log. --
  const rootB = await mkrepo()
  try {
    await answersStore.save(
      rootB,
      answersStore.emptyAnswers({ templateVersion: '1.0', project: { name: 'fixture' } }),
    )
    await fs.mkdir(join(rootB, '.caselaw', 'bin'), { recursive: true })
    await fs.copyFile(RUNTIME, join(rootB, '.caselaw', 'bin', 'gate.mjs'))
    await fs.writeFile(
      join(rootB, '.caselaw', 'gates.json'),
      JSON.stringify({
        version: 1,
        gates: [{
          id: 'no-forbidden-token',
          kind: 'banned-content',
          severity: 'warn',
          origin: 'docs/rules/active/no-forbidden-token.md',
          paths: ['**/*.md'],
          patterns: [{ literal: 'FORBIDDEN_TOKEN', label: 'forbidden token' }],
        }],
      }, null, 2) + '\n',
      'utf8',
    )

    const firelog = join(rootB, '.caselaw', 'gate-fires.jsonl')
    assert.equal(await exists(firelog), false, 'precondition: no fire log yet')

    const r1 = await doctor({ root: rootB })
    assert.ok(
      r1.findings.some((f) => f.name === 'gate runner' && f.status === 'ok'),
      'precondition: doctor actually executed the vendored runner',
    )
    assert.equal(
      await exists(firelog),
      false,
      'doctor appended to .caselaw/gate-fires.jsonl; a diagnostic must not manufacture the evidence that promotes warn -> block',
    )

    await doctor({ root: rootB })
    const lines = (await exists(firelog))
      ? (await fs.readFile(firelog, 'utf8')).split('\n').filter(Boolean).length
      : 0
    assert.equal(lines, 0, `two doctor runs wrote ${lines} fire-log row(s)`)
  } finally {
    await fs.rm(rootB, { recursive: true, force: true })
  }
})