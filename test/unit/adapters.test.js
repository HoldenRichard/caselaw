/**
 * Adapter tests, and the rule that keeps the support list honest.
 *
 * A large competitor declared support for ten agent tools, shipped golden
 * fixtures for three, and collected open issues from the other seven saying
 * setup was broken. The lesson is mechanical, not moral: a tool counts as
 * supported when a test renders it, and the test suite is what defines the
 * list — not the README.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ADAPTERS, RESERVED_COMMANDS, selectAdapters, getAdapter, commandCollisions,
} from '../../src/adapters/index.js'
import { buildArtifacts, templateFiles, MODULES } from '../../src/generate/artifacts.js'
import { emptyAnswers } from '../../src/core/answers.js'
import { buildReviewPrompt } from '../../src/commands/review.js'

const detectedWith = (agentConfig) => ({ agentConfig, stack: { languages: [] }, commands: {}, deploySurface: [] })

describe('adapters — the support list is the test list', () => {
  test('POSITIVE CONTROL: every declared adapter has a golden render below', () => {
    // If this fails, either write the fixture or remove the adapter. Shipping
    // an untested adapter is how a README starts lying.
    for (const a of ADAPTERS) {
      assert.equal(a.tested, true, `adapter "${a.id}" is declared but not marked tested`)
      assert.ok(GOLDEN[a.id], `adapter "${a.id}" has no golden render — it does not count as supported`)
    }
  })

  test('every adapter produces at least one artifact with a path and a body', () => {
    for (const a of ADAPTERS) {
      const arts = a.artifacts({ detected: detectedWith({}) })
      assert.ok(arts.length > 0, `${a.id} produced nothing`)
      for (const art of arts) {
        assert.ok(art.path, `${a.id} produced an artifact with no path`)
        assert.ok(art.body && art.body.length > 40, `${a.id} produced a suspiciously empty body`)
      }
    }
  })

  test('POSITIVE CONTROL: no adapter inlines the doctrine — only a pointer to it', () => {
    // The whole design rests on doctrine living once. An adapter that copied
    // the authority split into a tool file would create the drift this exists
    // to prevent, and the copy would be the one the agent reads.
    for (const a of ADAPTERS) {
      for (const art of a.artifacts({ detected: detectedWith({}) })) {
        assert.match(art.body, /docs\/authority-split\.md/,
          `${a.id} must point at the doctrine`)
        assert.ok(art.body.length < 900,
          `${a.id} body is ${art.body.length} chars — a pointer, not a copy`)
        assert.doesNotMatch(art.body, /## The agent cannot/,
          `${a.id} has inlined authority-split content instead of pointing at it`)
      }
    }
  })
})

/** One frozen render per adapter. A change here is a change users will see. */
const GOLDEN = {
  'claude-code': { path: 'CLAUDE.md', kind: 'block', blockId: 'pointer' },
  'agents-md': { path: 'AGENTS.md', kind: 'block', blockId: 'pointer' },
  cursor: { path: '.cursor/rules/caselaw.mdc', kind: 'file' },
  copilot: { path: '.github/copilot-instructions.md', kind: 'block', blockId: 'pointer' },
}

describe('adapters — golden renders', () => {
  for (const [id, expected] of Object.entries(GOLDEN)) {
    test(`${id} renders to ${expected.path}`, () => {
      const arts = getAdapter(id).artifacts({ detected: detectedWith({}) })
      const art = arts.find((a) => a.path === expected.path)
      assert.ok(art, `${id} did not produce ${expected.path}`)
      assert.equal(art.kind, expected.kind)
      if (expected.blockId) assert.equal(art.blockId, expected.blockId)
      assert.match(art.body, /docs\/rules\/active\//)
      assert.match(art.body, /You draft; you never ratify/)
    })
  }

  test('cursor gets real .mdc frontmatter, not a bare markdown file', () => {
    const [art] = getAdapter('cursor').artifacts({ detected: detectedWith({}) })
    assert.match(art.body, /^---\n/)
    assert.match(art.body, /alwaysApply: true/)
    assert.match(art.body, /\n---\n/)
  })
})

describe('adapters — selection follows what the project already uses', () => {
  test('a Claude-only repo gets one pointer, not four', () => {
    const chosen = selectAdapters(detectedWith({ claudeMd: true }))
    assert.deepEqual(chosen.map((a) => a.id), ['claude-code'])
  })

  test('a repo using two tools gets both', () => {
    const chosen = selectAdapters(detectedWith({ claudeMd: true, cursorRules: true }))
    assert.deepEqual(chosen.map((a) => a.id).sort(), ['claude-code', 'cursor'])
  })

  test('POSITIVE CONTROL: a repo using nothing does not get four files of clutter', () => {
    const chosen = selectAdapters(detectedWith({}))
    assert.deepEqual(chosen.map((a) => a.id), ['claude-code'],
      'writing config for tools a project has never used is how a harness gets deleted')
  })

  test('an explicit adapter selection (adapterIds) overrides detection', () => {
    const chosen = selectAdapters(detectedWith({ claudeMd: true }), { only: ['cursor'] })
    assert.deepEqual(chosen.map((a) => a.id), ['cursor'])
  })
})

describe('adapters — command collisions', () => {
  test('POSITIVE CONTROL: a command named after a host built-in is caught', () => {
    assert.deepEqual(commandCollisions('claude-code', ['review.md']), ['review'])
    assert.deepEqual(commandCollisions('claude-code', ['init.md', 'doctor.md']), ['init', 'doctor'])
  })

  test('the command we actually ship does not collide', () => {
    assert.deepEqual(commandCollisions('claude-code', ['close-out.md']), [])
  })

  test('POSITIVE CONTROL: every shipped command file is collision-checked for real', async () => {
    const files = await templateFiles('adapters/claude/commands')
    assert.ok(files.length > 0, 'there should be at least one shipped command')
    assert.deepEqual(commandCollisions('claude-code', files), [],
      'a generated command that shadows a built-in changes behaviour nobody asked to change')
  })

  test('the reserved list covers the built-ins most likely to be reinvented', () => {
    for (const name of ['init', 'review', 'doctor', 'memory', 'compact']) {
      assert.ok(RESERVED_COMMANDS['claude-code'].includes(name), `${name} should be reserved`)
    }
  })
})

describe('adapters — end to end through buildArtifacts', () => {
  let root
  const setup = async () => {
    root = await mkdtemp(join(tmpdir(), 'caselaw-adapters-'))
    return root
  }

  test('a Cursor+Codex project gets those pointers and no Claude files', async () => {
    await setup()
    const doc = emptyAnswers({ project: { name: 'P' } })
    doc.generatedAt = '2026-08-13T00:00:00.000Z'
    const arts = await buildArtifacts({
      doc, detected: detectedWith({ cursorRules: true, agentsMd: true }),
    })
    const paths = arts.map((a) => a.path)
    assert.ok(paths.includes('.cursor/rules/caselaw.mdc'))
    assert.ok(paths.includes('AGENTS.md'))
    assert.ok(!paths.includes('CLAUDE.md'))
    assert.ok(!paths.some((p) => p.startsWith('.claude/')),
      'Claude hooks and commands must not be written into a repo that has never used Claude Code')
    await rm(root, { recursive: true, force: true })
  })

  test('a Claude project still gets hooks and the close-out command', async () => {
    await setup()
    const doc = emptyAnswers({ project: { name: 'P' } })
    doc.generatedAt = '2026-08-13T00:00:00.000Z'
    const arts = await buildArtifacts({ doc, detected: detectedWith({ claudeMd: true }) })
    const paths = arts.map((a) => a.path)
    assert.ok(paths.includes('.claude/settings.json'))
    assert.ok(paths.includes('.claude/commands/close-out.md'))
    await rm(root, { recursive: true, force: true })
  })

  test('the doctrine files are identical regardless of which adapter is used', async () => {
    await setup()
    const doc = emptyAnswers({ project: { name: 'P' } })
    doc.generatedAt = '2026-08-13T00:00:00.000Z'
    const forClaude = await buildArtifacts({ doc, detected: detectedWith({ claudeMd: true }) })
    const forCursor = await buildArtifacts({ doc, detected: detectedWith({ cursorRules: true }) })
    const doctrine = (arts) => arts.filter((a) => a.path.startsWith('docs/')).map((a) => `${a.path}\n${a.body}`)
    assert.deepEqual(doctrine(forClaude), doctrine(forCursor),
      'one doctrine, many pointers — if these differ, the design has already failed')
    await rm(root, { recursive: true, force: true })
  })
})

describe('review', () => {
  const ctx = {
    root: '/x',
    detected: { stack: { languages: [{ name: 'TypeScript', pct: 90 }] }, commands: { test: { cmd: 'npm test' } }, deploySurface: [{ kind: 'fly' }] },
    answers: { answers: { 'authority.cannot': ['deploy'], 'authority.triage': { deploy: 'chosen' } } },
    rules: { active: [{ name: 'r', trigger: 'editing schema', enforcement: { mode: 'machine', gateId: 'g' } }] },
    gatesConfig: { gates: [{ id: 'g', kind: 'banned-content', severity: 'warn', origin: 'docs/rules/active/r.md' }] },
  }

  test('includes the project facts a reviewer needs', () => {
    const p = buildReviewPrompt(ctx)
    assert.match(p, /TypeScript 90%/)
    assert.match(p, /npm test/)
    assert.match(p, /deploy \(chosen\)/)
    assert.match(p, /r — Trigger: editing schema — Enforcement: machine:g/)
  })

  test('POSITIVE CONTROL: it asks for citations and warns against invention', () => {
    // Collapse whitespace: these assert what the prompt SAYS, and where a
    // sentence happens to wrap must never break a content test.
    const p = buildReviewPrompt(ctx).replace(/\s+/g, ' ')
    assert.match(p, /a finding without a citation is not a finding/i)
    assert.match(p, /fabricated finding costs more than a missed one/)
  })

  test('it tells the reviewer why a different model was asked', () => {
    assert.match(buildReviewPrompt(ctx).replace(/\s+/g, ' '), /shares its own blind spots/)
  })

  test('an empty project still produces a usable prompt rather than throwing', () => {
    const p = buildReviewPrompt({ root: '/x', detected: {}, answers: null, rules: { active: [] }, gatesConfig: { gates: [] } })
    assert.match(p, /\(none yet\)/)
    assert.match(p, /no authority split recorded/)
  })
})

describe('optional modules', () => {
  const doc = () => {
    const d = emptyAnswers({ project: { name: 'P' } })
    d.generatedAt = '2026-08-13T00:00:00.000Z'
    return d
  }

  test('POSITIVE CONTROL: nothing optional is installed by default', async () => {
    const arts = await buildArtifacts({ doc: doc(), detected: detectedWith({ claudeMd: true }) })
    const optional = arts.filter((a) => /docs\/(decisions|glossary|known-issues)/.test(a.path))
    assert.deepEqual(optional, [],
      'installing four files nobody asked for is the curated-corpus mistake: volume standing in for fit')
  })

  test('each module installs only its own files', async () => {
    const arts = await buildArtifacts({ doc: doc(), detected: detectedWith({ claudeMd: true }), modules: ['glossary'] })
    const paths = arts.map((a) => a.path)
    assert.ok(paths.includes('docs/glossary.md'))
    assert.ok(!paths.some((p) => p.startsWith('docs/decisions/')))
  })

  test('every declared module actually resolves to real template files', async () => {
    for (const id of Object.keys(MODULES)) {
      const arts = await buildArtifacts({ doc: doc(), detected: detectedWith({ claudeMd: true }), modules: [id] })
      const mine = arts.filter((a) => MODULES[id].files.some((f) => f.to === a.path))
      assert.equal(mine.length, MODULES[id].files.length, `module "${id}" did not produce all its files`)
      for (const a of mine) assert.ok(a.body.length > 100, `${a.path} is suspiciously empty`)
    }
  })

  test('POSITIVE CONTROL: an unknown module is an error, not silently ignored', async () => {
    await assert.rejects(
      () => buildArtifacts({ doc: doc(), detected: detectedWith({ claudeMd: true }), modules: ['telepathy'] }),
      /Unknown module "telepathy"/,
    )
  })

  test('POSITIVE CONTROL: the seed ADR renders a real date, never a placeholder', async () => {
    const arts = await buildArtifacts({ doc: doc(), detected: detectedWith({ claudeMd: true }), modules: ['decisions'] })
    const adr = arts.find((a) => a.path.endsWith('0001-adopt-caselaw.md'))
    assert.match(adr.body, /\*\*Date:\*\* 2026-08-13/)
    assert.doesNotMatch(adr.body, /\{\{/, 'an unrendered template token would ship to the user')
  })

  test('the ADR records the costs it accepts, not only the benefits', async () => {
    const arts = await buildArtifacts({ doc: doc(), detected: detectedWith({ claudeMd: true }), modules: ['decisions'] })
    const adr = arts.find((a) => a.path.endsWith('0001-adopt-caselaw.md'))
    assert.match(adr.body.replace(/\s+/g, ' '), /Costs accepted knowingly/,
      'a decision record listing only benefits is marketing')
  })
})
