/**
 * The handover list used to drop untested boundaries — the one kind the rest
 * of the tool works hardest to flag — so the human never saw them at the end
 * of a session. They are handed over as their own group: settle them, or
 * verify by hand until you have.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildModel, generate } from '../../src/generate/close-out.js'

describe('close-out — untested boundaries', () => {
  test('POSITIVE CONTROL: an untested boundary is on the handover list, as untested', async () => {
    const answers = { 'authority.cannot': ['device', 'prod-logs'], 'authority.triage': { device: 'physical', 'prod-logs': 'untested' } }
    const m = buildModel({ answers, detected: {}, projectName: 'p' })
    assert.deepEqual(m.untested.map((u) => u.value), ['prod-logs'])
    assert.ok(!m.humanOnly.some((h) => h.value === 'prod-logs'), 'not passed off as a known limit')
    const { content } = await generate({ answers, detected: {}, projectName: 'p' })
    assert.match(content, /- \[ \] read production logs _\(untested\)_/)
    assert.match(content, /still marked untested/)
  })

  test('the untested group is absent when there is nothing untested', async () => {
    const { content } = await generate({ answers: { 'authority.cannot': ['device'], 'authority.triage': { device: 'physical' } }, detected: {}, projectName: 'p' })
    assert.doesNotMatch(content, /still marked untested/)
  })
})
