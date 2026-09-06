/**
 * Grandfather expiry is a calendar date, and the runner and the audit must
 * read it the same way. They did not: the runner compared instants (an ISO
 * date parses to 00:00Z, so the exception died at midnight UTC on its last
 * day) while the audit compared UTC days. For twenty-four hours a block gate
 * fired on a violation the audit said was still excused.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate } from '../../runtime/gate.mjs'
import { runChecks } from '../../src/audit/checks.js'

test('POSITIVE CONTROL: the runner and the audit agree about a grandfather on its expiry day', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caselaw-c5-'))
  try {
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/thing.js'),
      'export const KEY = "sk-live-DEADBEEF"\n// nearby marker CTX_MARKER here\n', 'utf8')

    const EXPIRES = '2026-09-06'
    const gate = {
      id: 'no-live-keys',
      kind: 'banned-content',
      severity: 'block',
      origin: 'docs/rules/active/no-live-keys.md',
      paths: ['src/**/*.js'],
      patterns: [{ literal: 'sk-live-', label: 'live key prefix' }],
      grandfather: [{ context: 'CTX_MARKER', reason: 'rotation scheduled', expires: EXPIRES }],
    }
    const config = { version: 1, gates: [gate] }

    const runnerSaysExpired = async (now) => {
      const r = await evaluate({ root, mode: 'all', now, telemetry: false, config })
      return r.blocking.length > 0
    }
    const auditSaysExpired = (now) =>
      runChecks({ gatesConfig: config, now, rules: { active: [], proposed: [] }, answers: null, fireCounts: {} },
        { only: ['grandfather-expiry'] }).findings.length > 0

    // Midday UTC ON the expiry day. `expires` is a calendar date: the schema says
    // the entry stops suppressing AFTER the date passes, so on the day itself the
    // exception is still live and neither side should report an expiry.
    const onTheDay = new Date(`${EXPIRES}T12:00:00.000Z`)
    assert.equal(auditSaysExpired(onTheDay), false, 'audit: not expired on the expiry day')
    assert.equal(await runnerSaysExpired(onTheDay), false,
      'runner: a grandfather expiring today must still suppress for the whole UTC day')

    // The day after, both must flip together.
    const nextDay = new Date('2026-09-07T00:00:00.000Z')
    assert.equal(auditSaysExpired(nextDay), true, 'audit: expired the next day')
    assert.equal(await runnerSaysExpired(nextDay), true, 'runner: expired the next day')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})