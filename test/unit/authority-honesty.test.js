/**
 * The generated authority split must not contradict itself, and must not hand
 * the reader a command nobody has seen work. On ntfy the detected test command
 * did not compile on a fresh clone, and the same document listed it as
 * something the agent can run AND as the one-liner that settles an untested
 * boundary AND, four sections above, under "The agent can".
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildModel, generate } from '../../src/generate/authority-split.js'

const detected = (exitCode) => ({ commands: { test: { cmd: 'go test ./...', source: 'go.mod', exitCode, verifiedAt: exitCode === 0 ? '2026-09-06' : null } } })

describe('settle commands', () => {
  test('POSITIVE CONTROL: an unverified test command is offered to run by hand, not as a one-liner', () => {
    const m = buildModel({ answers: { 'authority.cannot': ['full-suite'], 'authority.triage': { 'full-suite': 'untested' } }, detected: detected(null), projectName: 'p' })
    assert.equal(m.unverified[0].settleCommand, null)
    assert.equal(m.unverified[0].settleHint, 'go test ./...')
  })

  test('a verified test command is a one-liner', () => {
    const m = buildModel({ answers: { 'authority.cannot': ['full-suite'], 'authority.triage': { 'full-suite': 'untested' } }, detected: detected(0), projectName: 'p' })
    assert.equal(m.unverified[0].settleCommand, 'go test ./...')
    assert.equal(m.unverified[0].settleHint, null)
  })

  test('the rendered row says what to do with an unverified command', async () => {
    const { content } = await generate({ answers: { 'authority.cannot': ['full-suite'], 'authority.triage': { 'full-suite': 'untested' }, 'authority.retest_days': 30 }, detected: detected(null), projectName: 'p', now: new Date('2026-09-06T00:00:00Z') })
    assert.match(content, /\| run the full test suite \| not recorded \| _run `go test \.\/\.\.\.` once by hand and record what happened_ \|/)
  })
})

describe('the can-list', () => {
  test('POSITIVE CONTROL: a command the human named as a boundary is not also listed as a capability', () => {
    const m = buildModel({ answers: { 'authority.cannot': ['full-suite'], 'authority.triage': { 'full-suite': 'physical' } }, detected: detected(null), projectName: 'p' })
    assert.ok(!m.can.some((line) => /test \(/.test(line)), `"The agent can" must not list the suite the human just said it cannot run: ${m.can.join(' | ')}`)
  })

  test('and is still listed when the suite is not a boundary', () => {
    const m = buildModel({ answers: { 'authority.cannot': ['deploy'], 'authority.triage': { deploy: 'chosen' } }, detected: detected(null), projectName: 'p' })
    assert.ok(m.can.some((line) => /test \(/.test(line)))
  })
})
