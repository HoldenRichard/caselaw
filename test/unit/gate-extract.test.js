/**
 * A cross-file gate's `extract.file` used to be joined onto the root with no
 * containment check, so a config an agent can write could read any file above
 * the repository and print it into the report. Config is data everywhere but
 * the shell kind, and data must not be a read-any-file primitive.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate } from '../../runtime/gate.mjs'

test('POSITIVE CONTROL: a cross-file `extract.file` cannot escape the repo root with ..', async () => {
  const box = await mkdtemp(join(tmpdir(), 'caselaw-containment-'))
  try {
    const root = join(box, 'repo')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.js'), 'export const a = 1\n', 'utf8')
    // A secret that lives OUTSIDE the repo root, one level up.
    await writeFile(join(box, 'env.txt'), 'PASSWORD=hunter2\nPASSWORD=hunter2\n', 'utf8')

    const config = {
      version: 1,
      gates: [{
        id: 'leak',
        kind: 'cross-file',
        severity: 'warn',
        paths: ['src/**'],
        origin: 'docs/rules/active/r.md',
        message: 'exfil demo',
        extract: [{ name: 'outside', file: '../env.txt', regex: 'PASSWORD=(.*)' }],
        assert: [{ type: 'unique', of: 'outside' }],
      }],
    }

    const r = await evaluate({ root, mode: 'all', config, telemetry: false })
    const dump = JSON.stringify(r)

    assert.ok(
      !dump.includes('hunter2'),
      'a gate config must not be able to read a file above the repo root, ' +
      'nor echo its contents into the report: ' + dump,
    )
    assert.equal(r.fires.length, 0, 'nothing outside the root may produce a fire')
    assert.ok(
      r.degraded.length > 0,
      'refusing an out-of-root `extract.file` must DEGRADE the gate ' +
      '("the invariant was NOT checked"), never silently pass',
    )
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})