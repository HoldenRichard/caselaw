/**
 * Promotion evidence.
 *
 * A warn gate earns `block` by catching real violations. The runner recorded a
 * fire for every match in every mode, and promotion counted them all — so one
 * whole-tree `--mode all` scan (CI, or `doctor`) over three pre-existing
 * violations made a brand-new gate promotable on the spot. Fires still get
 * recorded in every mode, with the mode on each line; only pre, post and
 * staged count as evidence.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate } from '../../runtime/gate.mjs'
import { promotionStatus } from '../../src/core/gates.js'

test('POSITIVE CONTROL: fires from one whole-tree --mode all scan do not earn a warn gate its promotion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caselaw-c4-'))
  try {
    await mkdir(join(root, 'src'), { recursive: true })
    for (const n of ['a.js', 'b.js', 'c.js']) {
      await writeFile(join(root, 'src', n), 'export const x = 1 // TODOMARKER\n', 'utf8')
    }

    const config = {
      version: 1,
      gates: [{
        id: 'no-todomarker',
        kind: 'banned-content',
        severity: 'warn',
        paths: ['src/**/*.js'],
        origin: 'docs/rules/active/no-todomarker.md',
        message: 'Remove the TODOMARKER before landing.',
        patterns: [{ literal: 'TODOMARKER', label: 'todo marker' }],
      }],
    }

    // One CI-style whole-tree scan over three PRE-EXISTING violations.
    const res = await evaluate({
      root, mode: 'all', config, telemetry: true,
      targets: ['src/a.js', 'src/b.js', 'src/c.js'],
    })

    assert.equal(res.fires.length, 3,
      'precondition: one all-mode scan sees all three pre-existing violations')

    const log = (await readFile(join(root, '.caselaw/gate-fires.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(log.length, 3, 'precondition: the scan recorded one line per violating file')
    assert.ok(log.every((l) => l.mode === 'all'),
      'precondition: every recorded fire came from the whole-tree scan')

    const status = await promotionStatus(root, 'no-todomarker')
    assert.equal(status.eligible, false,
      'one whole-tree CI scan of pre-existing violations is a single observation, ' +
      'not three separately earned catches; it must not make a brand-new warn gate promotable to block')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('the audit counts only evidence-mode fires toward promotion, but any fire keeps a gate alive', async () => {
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const { gather } = await import('../../src/audit/gather.js')
  const { runChecks } = await import('../../src/audit/checks.js')
  const root = await mkdtemp(join(tmpdir(), 'caselaw-evidence-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root }) // no background gc racing the temp-dir cleanup
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await writeFile(join(root, '.caselaw/gates.json'), JSON.stringify({
      version: 1,
      gates: [{ id: 'g', kind: 'banned-content', severity: 'warn', paths: ['src/**'], patterns: [{ literal: 'x' }], origin: 'docs/rules/active/g.md', message: 'm' }],
    }))
    await writeFile(join(root, '.caselaw/answers.json'), JSON.stringify({ schemaVersion: 1, templateVersion: '1.0', project: {}, answers: {}, unanswered: [], generatedAt: '2026-01-01T00:00:00.000Z' }))
    const line = (mode) => JSON.stringify({ ts: '2026-09-01T00:00:00.000Z', gate: 'g', mode, path: 'src/a.js', severity: 'warn' }) + '\n'
    await writeFile(join(root, '.caselaw/gate-fires.jsonl'), line('all') + line('all') + line('all'))

    let r = runChecks(await gather(root, { now: new Date('2026-09-06T00:00:00Z') }))
    assert.ok(!r.findings.some((f) => f.code === 'gates-earned'), 'three all-mode fires are not evidence')
    assert.ok(!r.findings.some((f) => f.code === 'dead-gates'), 'but the gate has matched something, so it is not dead')

    await writeFile(join(root, '.caselaw/gate-fires.jsonl'), line('pre') + line('post') + line('staged'))
    r = runChecks(await gather(root, { now: new Date('2026-09-06T00:00:00Z') }))
    assert.ok(r.findings.some((f) => f.code === 'gates-earned'), 'three hook-mode catches are')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
