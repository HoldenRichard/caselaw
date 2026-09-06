import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  QUESTIONS, SESSIONS, questionsFor, rank, optionsFor, boundaryCandidates, sessionMeta,
} from '../../src/interview/questions.js'

describe('question set — structural invariants', () => {
  test('every question declares what it generates', () => {
    for (const q of QUESTIONS) {
      assert.ok(
        Array.isArray(q.generates) && q.generates.length > 0,
        `"${q.id}" generates nothing. A question that cannot point at an artifact section wastes the user's budget and must be cut.`,
      )
    }
  })

  test('every question carries a since version, for upgrade paths', () => {
    for (const q of QUESTIONS) {
      assert.match(q.since || '', /^\d+\.\d+$/, `"${q.id}" is missing a valid since`)
    }
  })

  test('question ids are unique and namespaced by session key', () => {
    const seen = new Set()
    for (const q of QUESTIONS) {
      assert.ok(!seen.has(q.id), `duplicate id ${q.id}`)
      seen.add(q.id)
      const meta = sessionMeta(q.session)
      assert.ok(meta, `"${q.id}" belongs to unknown session ${q.session}`)
      assert.ok(q.id.startsWith(meta.key + '.'), `"${q.id}" should start with "${meta.key}."`)
    }
  })

  test('POSITIVE CONTROL: no session exceeds its question budget', () => {
    for (const s of SESSIONS) {
      const n = QUESTIONS.filter((q) => q.session === s.n).length
      assert.ok(
        n <= s.budget,
        `session ${s.n} (${s.title}) has ${n} questions but a budget of ${s.budget}. ` +
          `The budget is the defense against an abandoned interview — cut a question, do not raise the cap.`,
      )
    }
  })

  test('choice questions offer between 2 and 5 options, so they stay one-keystroke', () => {
    for (const q of QUESTIONS) {
      if (q.type !== 'select' && q.type !== 'triage') continue
      const opts = optionsFor(q, { detected: {} })
      assert.ok(opts.length >= 2 && opts.length <= 5, `"${q.id}" has ${opts.length} options; want 2-5`)
    }
  })

  test('every question has a prompt that is actually a question', () => {
    for (const q of QUESTIONS) {
      assert.ok(q.prompt && q.prompt.length > 10, `"${q.id}" has no usable prompt`)
    }
  })
})

describe('question set — the authority session is intact', () => {
  test('the seed question and its triage both exist', () => {
    const ids = QUESTIONS.map((q) => q.id)
    assert.ok(ids.includes('authority.cannot'), 'the seed question is the reason this tool exists')
    assert.ok(
      ids.includes('authority.triage'),
      'physical/chosen/untested triage is the one idea nothing else in this category has',
    )
  })

  test('the triage question is skipped when nothing was selected', () => {
    const asked = questionsFor(1, { 'authority.cannot': [] }, {})
    assert.ok(!asked.some((q) => q.id === 'authority.triage'))
  })

  test('the retest question only appears when something was marked untested', () => {
    const without = questionsFor(1, { 'authority.cannot': ['deploy'], 'authority.triage': { deploy: 'physical' } }, {})
    assert.ok(!without.some((q) => q.id === 'authority.retest_days'))

    const with_ = questionsFor(1, { 'authority.cannot': ['deploy'], 'authority.triage': { deploy: 'untested' } }, {})
    assert.ok(with_.some((q) => q.id === 'authority.retest_days'))
  })
})

describe('boundary candidates adapt to what detection found', () => {
  test('a Swift project is offered device and release-console', () => {
    const opts = boundaryCandidates({ stack: { languages: [{ name: 'Swift' }] }, deploySurface: [] })
    const values = opts.map((o) => o.value)
    assert.ok(values.includes('device'))
    assert.ok(values.includes('release-console'))
  })

  test('a plain library with no deploy surface is not asked about deploys or prod logs', () => {
    const opts = boundaryCandidates({ stack: { languages: [{ name: 'Python' }] }, deploySurface: [] })
    const values = opts.map((o) => o.value)
    assert.ok(!values.includes('deploy'), 'do not ask a library about deploying')
    assert.ok(!values.includes('prod-logs'))
    assert.ok(!values.includes('device'), 'do not ask a Python lib about physical hardware')
  })

  test('a deployed service IS asked about deploys and logs', () => {
    const opts = boundaryCandidates({
      stack: { languages: [{ name: 'TypeScript' }] },
      deploySurface: [{ kind: 'fly' }],
    })
    const values = opts.map((o) => o.value)
    assert.ok(values.includes('deploy'))
    assert.ok(values.includes('prod-logs'))
  })

  test('secrets only offered when a secret surface was actually found', () => {
    const none = boundaryCandidates({ secretSurface: [] }).map((o) => o.value)
    assert.ok(!none.includes('secrets'))
    const some = boundaryCandidates({ secretSurface: [{ path: '.env' }] }).map((o) => o.value)
    assert.ok(some.includes('secrets'))
  })

  test('the candidate list stays short enough to read', () => {
    const opts = boundaryCandidates({
      stack: { languages: [{ name: 'Swift' }] },
      deploySurface: [{ kind: 'firebase' }],
      secretSurface: [{ path: '.env' }],
    })
    assert.ok(opts.length <= 13, `${opts.length} checkboxes is past what anyone reads`)
  })
})

describe('ranking spends the budget where it buys most', () => {
  test('unanswered high-impact questions sort first', () => {
    const qs = [
      { id: 'a', impact: 1 },
      { id: 'b', impact: 5 },
      { id: 'c', impact: 3 },
    ]
    assert.deepEqual(rank(qs, {}).map((q) => q.id), ['b', 'c', 'a'])
  })

  test('already-answered questions sink regardless of impact', () => {
    const qs = [
      { id: 'a', impact: 1 },
      { id: 'b', impact: 5 },
    ]
    assert.deepEqual(rank(qs, { b: 'answered' }).map((q) => q.id), ['a', 'b'])
  })
})

describe('question set — what it says it generates', () => {
  test('POSITIVE CONTROL: every `generates` anchor names a heading a real artifact renders', async () => {
    const { buildArtifacts } = await import('../../src/generate/artifacts.js')
    const { emptyAnswers } = await import('../../src/core/answers.js')
    // Three questions used to claim sections of docs/verification-tiers.md,
    // a file nothing ever wrote. The README listed it too. The answers behind
    // it were rendered — into docs/authority-split.md — so only the claim
    // was false, which is the kind of false that nothing notices.
    const doc = emptyAnswers({ templateVersion: '1.0', project: { name: 'P' } })
    doc.generatedAt = '2026-08-13T00:00:00.000Z'
    Object.assign(doc.answers, {
      'authority.cannot': ['device', 'deploy', 'prod-data'],
      'authority.triage': { device: 'physical', deploy: 'chosen', 'prod-data': 'untested' },
      'authority.human_proof': 'Tap through onboarding on a phone.',
      'authority.agent_reach': 'It can boot the simulator and screenshot both colour schemes.',
      'authority.retest_days': 30,
    })
    const artifacts = await buildArtifacts({ doc, detected: { agentConfig: { claudeMd: true }, commands: {}, deploySurface: [] } })
    const byPath = new Map(artifacts.map((a) => [a.path, a.body]))
    const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-')

    for (const q of QUESTIONS) {
      for (const g of q.generates) {
        const [path, anchor] = g.split('#')
        assert.ok(byPath.has(path), `"${q.id}" claims to generate ${path}, which no artifact produces`)
        const headings = [...byPath.get(path).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]))
        assert.ok(
          anchor && headings.some((h) => h === anchor || h.startsWith(`${anchor}-`)),
          `"${q.id}" claims ${g}, but the rendered ${path} has no such heading (it has: ${headings.join(', ')})`,
        )
      }
    }
  })
})
