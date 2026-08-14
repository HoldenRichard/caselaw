import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildModel, generate, settleCommandFor, BOUNDARY_LABELS } from '../../src/generate/authority-split.js'
import { boundaryCandidates } from '../../src/interview/questions.js'

const NOW = new Date('2026-08-12T00:00:00Z')

const MOBILE_APP = {
  answers: {
    'authority.cannot': ['device', 'prod-data', 'prod-logs'],
    'authority.triage': { device: 'physical', 'prod-data': 'chosen', 'prod-logs': 'untested' },
    'authority.notes': { 'prod-logs': 'never tried' },
    'authority.human_proof': 'Build to a real iPhone and tap through onboarding.',
    'authority.agent_reach': 'Boot the simulator and screenshot both colour schemes.',
    'authority.retest_days': 30,
  },
  detected: {
    deploySurface: [{ kind: 'firebase' }],
    commands: { test: { cmd: 'xcodebuild test', exitCode: 0, verifiedAt: '2026-08-12', durationMs: 41000 } },
  },
  projectName: 'Northwind',
  now: NOW,
}

describe('authority split — model', () => {
  test('sorts boundaries into physical / chosen / unverified', () => {
    const m = buildModel(MOBILE_APP)
    assert.deepEqual(m.physical.map((x) => x.value), ['device'])
    assert.deepEqual(m.chosen.map((x) => x.value), ['prod-data'])
    assert.deepEqual(m.unverified.map((x) => x.value), ['prod-logs'])
  })

  test('a re-test date is set only when something is untested', () => {
    assert.equal(buildModel(MOBILE_APP).retestDue, '2026-09-11')

    const allKnown = {
      ...MOBILE_APP,
      answers: { ...MOBILE_APP.answers, 'authority.triage': { device: 'physical', 'prod-data': 'chosen', 'prod-logs': 'chosen' } },
    }
    assert.equal(buildModel(allKnown).retestDue, '', 'no untested boundaries means no deadline to invent')
  })

  test('measured commands carry their proof into the can-list', () => {
    const m = buildModel(MOBILE_APP)
    assert.match(m.can[0], /xcodebuild test/)
    assert.match(m.can[0], /verified 2026-08-12, 41s/)
  })

  test('POSITIVE CONTROL: an unverified command is labelled unverified, never as proof', () => {
    const m = buildModel({
      ...MOBILE_APP,
      detected: { commands: { test: { cmd: 'npm test', exitCode: null, verifiedAt: null } } },
    })
    assert.match(m.can[0], /unverified/)
    assert.doesNotMatch(m.can[0], /verified 20/)
  })

  test('with no answers at all it still produces a valid model rather than throwing', () => {
    const m = buildModel({ answers: {}, detected: {}, now: NOW })
    assert.deepEqual(m.physical, [])
    assert.deepEqual(m.unverified, [])
    assert.ok(m.can.length > 0, 'must never render an empty can-list section')
  })
})

describe('authority split — settle commands', () => {
  test('suggests a real log command for the detected platform', () => {
    assert.equal(settleCommandFor('prod-logs', { deploySurface: [{ kind: 'fly' }] }), 'fly logs --no-tail')
    assert.match(settleCommandFor('prod-logs', { deploySurface: [{ kind: 'k8s' }] }), /kubectl logs/)
  })

  test('POSITIVE CONTROL: never suggests a command whose failure mode is a deploy', () => {
    assert.equal(settleCommandFor('deploy', { deploySurface: [{ kind: 'fly' }] }), null)
  })

  test('returns null rather than guessing when the platform is unknown', () => {
    assert.equal(settleCommandFor('prod-logs', { deploySurface: [] }), null)
    assert.equal(settleCommandFor('rendered-ui', {}), null)
  })

  test('reuses the project’s own detected test command', () => {
    assert.equal(settleCommandFor('full-suite', { commands: { test: { cmd: 'pytest -q' } } }), 'pytest -q')
  })
})

describe('authority split — rendered output', () => {
  test('renders every section with real content', async () => {
    const { content } = await generate(MOBILE_APP)
    assert.match(content, /# Authority split — Northwind/)
    assert.match(content, /## The agent cannot — physical/)
    assert.match(content, /## The agent cannot — chosen/)
    assert.match(content, /## Unverified boundaries — settle these by 2026-09-11/)
    assert.match(content, /\| read production logs \| never tried \|/)
    assert.match(content, /Build to a real iPhone/)
    assert.match(content, /Boot the simulator/)
  })

  test('omits sections that have no content instead of leaving empty headings', async () => {
    const { content } = await generate({
      answers: { 'authority.cannot': ['device'], 'authority.triage': { device: 'physical' } },
      detected: {}, projectName: 'P', now: NOW,
    })
    assert.match(content, /## The agent cannot — physical/)
    assert.doesNotMatch(content, /## The agent cannot — chosen/)
    assert.doesNotMatch(content, /## Unverified boundaries/)
  })

  test('POSITIVE CONTROL: a missing human-proof answer says so rather than rendering blank', async () => {
    const { content } = await generate({ answers: {}, detected: {}, projectName: 'P', now: NOW })
    assert.match(content, /_Not recorded\._/, 'a visible hole beats a confident blank')
  })

  test('POSITIVE CONTROL: the output contains no absolute machine paths', async () => {
    const { content } = await generate(MOBILE_APP)
    assert.doesNotMatch(content, /\/Users\/[a-z]/i)
    assert.doesNotMatch(content, /\/home\/[a-z]/i)
  })

  test('every boundary the interview can offer has a human label', () => {
    const offered = boundaryCandidates({
      stack: { languages: [{ name: 'Swift' }] },
      deploySurface: [{ kind: 'fly' }],
      secretSurface: [{ path: '.env' }],
    })
    for (const o of offered) {
      assert.ok(BOUNDARY_LABELS[o.value], `boundary "${o.value}" can be selected but has no label to render`)
    }
  })
})

describe('authority split — markdown shape is publishable', () => {
  const cases = {
    'all sections': MOBILE_APP,
    'only physical': { answers: { 'authority.cannot': ['device'], 'authority.triage': { device: 'physical' } }, detected: {}, projectName: 'P', now: NOW },
    'nothing at all': { answers: {}, detected: {}, projectName: 'P', now: NOW },
  }
  for (const [name, input] of Object.entries(cases)) {
    test(`POSITIVE CONTROL: ${name} — every heading has exactly one blank line before it`, async () => {
      const { content } = await generate(input)
      const lines = content.split('\n')
      lines.forEach((line, i) => {
        if (!/^## /.test(line) || i === 0) return
        assert.equal(lines[i - 1], '', `"${line}" needs a blank line before it (got ${JSON.stringify(lines[i - 1])})`)
        assert.notEqual(lines[i - 2], '', `"${line}" has a double blank line before it`)
      })
      assert.doesNotMatch(content, /\n{3,}/, 'no blank-line pileup')
      assert.match(content, /\n$/, 'file ends with exactly one newline')
      assert.doesNotMatch(content, /\n\n$/, 'file must not end with a blank line')
    })
  }
})
