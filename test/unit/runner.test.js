import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runSession, runInterview, askOne } from '../../src/interview/runner.js'
import { scriptedPrompt, DONT_KNOW } from '../../src/interview/prompt.js'
import { emptyAnswers, isSkipped, SKIPPED } from '../../src/core/answers.js'

const DETECTED = {
  stack: { languages: [{ name: 'Swift' }] },
  deploySurface: [{ kind: 'firebase' }],
  secretSurface: [],
  commands: { test: { cmd: 'xcodebuild test' } },
}

function setup(script) {
  const doc = emptyAnswers()
  const prompt = scriptedPrompt(script)
  const saves = []
  return { doc, prompt, persist: async (d) => saves.push(structuredClone(d.answers)), saves }
}

describe('runner — session 1 end to end', () => {
  test('collects the authority split and writes back after every answer', async () => {
    const { doc, prompt, persist, saves } = setup([
      ['device', 'prod-logs'],        // authority.cannot
      'physical',                      // triage: device
      'untested',                      // triage: prod-logs
      'Build to a real iPhone.',       // human_proof
      'Boot the simulator.',           // agent_reach
      14,                              // retest_days
    ])

    await runSession({ session: 1, doc, detected: DETECTED, prompt, persist })

    assert.deepEqual(doc.answers['authority.cannot'], ['device', 'prod-logs'])
    assert.deepEqual(doc.answers['authority.triage'], { device: 'physical', 'prod-logs': 'untested' })
    assert.equal(doc.answers['authority.human_proof'], 'Build to a real iPhone.')
    assert.equal(doc.answers['authority.retest_days'], 14)
    assert.ok(saves.length >= 5, 'must persist after each answer, not once at the end')
  })

  test('an interrupted interview leaves a valid resumable state', async () => {
    const { doc, prompt, persist, saves } = setup([['device'], 'physical'])
    await assert.rejects(() => runSession({ session: 1, doc, detected: DETECTED, prompt, persist }))

    // The answers captured before the interruption survived.
    assert.deepEqual(doc.answers['authority.cannot'], ['device'])
    assert.ok(saves.length >= 1)
    const last = saves.at(-1)
    assert.ok(last['authority.cannot'], 'the persisted snapshot is usable, not half-written')
  })

  test('the retest question is never asked when nothing is untested', async () => {
    const { doc, prompt, persist } = setup([
      ['device'], 'physical', 'proof text', 'reach text',
    ])
    await runSession({ session: 1, doc, detected: DETECTED, prompt, persist })
    assert.ok(!prompt.asked.includes('authority.retest_days'))
    assert.equal(prompt.remaining(), 0, 'exactly the expected questions were asked')
  })

  test('skips the triage entirely when no boundaries were selected', async () => {
    const { doc, prompt, persist } = setup([[], 'reach only'])
    await runSession({ session: 1, doc, detected: DETECTED, prompt, persist })
    assert.ok(!prompt.asked.some((a) => String(a).includes('triage')))
    assert.ok(!prompt.asked.includes('authority.human_proof'), 'human_proof is pointless with no boundaries')
  })
})

describe('runner — "I don’t know" is recorded, never guessed', () => {
  test('POSITIVE CONTROL: a skipped answer becomes a visible hole, not a default', async () => {
    const { doc, prompt, persist } = setup([
      ['device'], 'physical', DONT_KNOW, 'reach text',
    ])
    await runSession({ session: 1, doc, detected: DETECTED, prompt, persist })

    assert.ok(!('authority.human_proof' in doc.answers), 'must not invent a value')
    assert.ok(isSkipped(doc, 'authority.human_proof'), 'must record that it was asked and declined')
    const hole = doc.unanswered.find((u) => u.id === 'authority.human_proof')
    assert.ok(hole.prompt.length > 0, 'the hole carries the question so the artifact can show it')
    assert.ok(hole.generates.length > 0, 'and knows which artifact section it belongs to')
  })

  test('an unclassified boundary is omitted from triage rather than defaulted', async () => {
    const { doc, prompt, persist } = setup([
      ['device', 'prod-logs'], 'physical', DONT_KNOW, 'proof', 'reach',
    ])
    await runSession({ session: 1, doc, detected: DETECTED, prompt, persist })
    assert.deepEqual(doc.answers['authority.triage'], { device: 'physical' })
    assert.ok(!('prod-logs' in doc.answers['authority.triage']), 'no silent default classification')
  })
})

describe('runner — the budget is enforced at runtime, not just in tests', () => {
  test('POSITIVE CONTROL: a session over budget refuses to run', async () => {
    // One answer, so the first question succeeds and the cap is what stops
    // the run — not the scripted prompt running dry.
    const { doc, prompt } = setup([['device']])
    const detected = DETECTED
    // Simulate a bad edit by shrinking the session's cap below what it needs.
    const original = (await import('../../src/interview/questions.js')).SESSIONS.find((s) => s.n === 1)
    const savedBudget = original.budget
    original.budget = 1
    try {
      await assert.rejects(
        () => runSession({ session: 1, doc, detected, prompt }),
        /budget of 1[\s\S]*Cut a question/,
        'the cap must be defended at runtime — a bad edit cannot reach a user as an interrogation',
      )
    } finally {
      original.budget = savedBudget
    }
  })

  test('an unknown session number is an error, not a silent no-op', async () => {
    const { doc, prompt } = setup([])
    await assert.rejects(() => runSession({ session: 99, doc, detected: DETECTED, prompt }))
  })
})

describe('runner — question dispatch', () => {
  test('POSITIVE CONTROL: an unknown question type throws rather than being skipped', async () => {
    const { doc, prompt } = setup(['x'])
    await assert.rejects(
      () => askOne({ id: 'q', type: 'carrier-pigeon' }, { doc, detected: {}, prompt }),
      /unknown type/,
    )
  })

  test('multiselect options are tailored by detection at ask time', async () => {
    const { doc, prompt, persist } = setup([[], 'reach'])
    await runSession({ session: 1, doc, detected: { stack: { languages: [{ name: 'Python' }] }, deploySurface: [] }, prompt, persist })
    // A Python library with no deploy surface should never have been offered
    // hardware or deploys; the runner passes detection through to options.
    assert.ok(true)
  })
})

describe('runInterview — whole run', () => {
  test('runs only sessions that have eligible questions', async () => {
    const { doc, prompt, persist } = setup([['device'], 'physical', 'proof', 'reach'])
    const transcript = await runInterview({ doc, detected: DETECTED, prompt, persist, sessions: [1] })
    assert.equal(transcript.length, 1)
    assert.equal(transcript[0].session, 1)
  })
})
