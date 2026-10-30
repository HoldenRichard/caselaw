/**
 * 0.3's environment triggers: a fact about the repository proposes a rule,
 * with the fact shown; accepted at install, or applied or proposed once when
 * it fires on a later upgrade.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TRIGGERS, TRIGGERED_ROOT, firedTriggers, markOffered, applyTriggers, writerGuardOn } from '../../src/core/triggers.js'
import { detectSignals, datedRecords } from '../../src/detect/signals.js'
import { buildArtifacts } from '../../src/generate/artifacts.js'
import { emptyAnswers } from '../../src/core/answers.js'
import { parseRule, validateRule } from '../../src/core/rules.js'
import { cmdRule } from '../../src/commands/rule.js'
import { gather } from '../../src/audit/gather.js'
import { runChecks } from '../../src/audit/checks.js'
import { execFileSync } from 'node:child_process'

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'caselaw-triggers-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel, content) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const exists = async (rel) => { try { await access(join(root, rel)); return true } catch { return false } }
const ids = (fired) => fired.map((t) => t.id)
const docWith = (answers = {}, harness) => {
  const doc = emptyAnswers({ templateVersion: '1.2', project: { name: 'P' } })
  doc.generatedAt = '2026-10-31T00:00:00.000Z'
  Object.assign(doc.answers, answers)
  if (harness) doc.harness = harness
  return doc
}
const DETECTED = { agentConfig: { claudeMd: true }, commands: {}, deploySurface: [] }

describe('each trigger fires on its fact, and only on it', () => {
  test('POSITIVE CONTROL: T1 to T7, each from the interview or from detection; an empty repository fires none', () => {
    assert.deepEqual(ids(firedTriggers({ detected: {}, answers: {} })), [])
    const cases = [
      ['T1', {}, { 'outside.authority': ['app-review'] }, /names an outside authority \(an app store's review/],
      ['T2', {}, { 'outside.claims': ['readme'] }, /where it makes public claims \(readme\)/],
      ['T3', { agentConfig: { claudeMd: true, agentsMd: true } }, {}, /instructs 2 agent tools \(Claude Code, AGENTS\.md\)/],
      ['T4', { signals: { metered: [{ signal: 'openai', source: 'package.json dependencies' }] } }, {}, /paid or metered API \(openai\)/],
      ['T4', {}, { 'authority.cannot': ['paid-apis'] }, /names paid or rate-limited APIs/],
      ['T5', { signals: { dated: [{ signal: 'CHANGELOG.md', source: 'CHANGELOG.md' }] } }, {}, /dated records \(CHANGELOG\.md\)/],
      ['T6', { secretSurface: [{ path: '.env', gitignored: true }] }, {}, /handles secrets \(\.env\)/],
      ['T6', { ciGates: { contexts: [{ secrets: ['NTFY_TEST_S3_URL'] }] } }, {}, /CI's NTFY_TEST_S3_URL/],
      ['T7', { signals: { identities: [{ signal: 'GoogleService-Info.plist' }, { signal: 'GoogleService-Info-Dev.plist' }] } }, {}, /more than one config identity/],
    ]
    for (const [id, detected, answers, fact] of cases) {
      const fired = firedTriggers({ detected, answers })
      assert.deepEqual(ids(fired), [id], `${id}: ${JSON.stringify({ detected, answers })}`)
      assert.match(fired[0].factNow, fact)
    }
    assert.deepEqual(ids(firedTriggers({ detected: { agentConfig: { claudeMd: true, claudeDir: true } } })), [], 'CLAUDE.md and .claude/ are one tool')
  })
})

describe('the detection behind T4, T5 and T7', () => {
  test('POSITIVE CONTROL: a metered SDK, a key in an env example, a changelog, dated logs, and two Firebase configs are found', async () => {
    await put('package.json', JSON.stringify({ name: 'p', dependencies: { openai: '4', express: '4' } }))
    await put('.env.example', 'PORT=3000\nGROQ_API_KEY=\n')
    await put('CHANGELOG.md', '# 1.0\n')
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) await put(`logs/${d}-session.md`, 'x\n')
    await put('ios/GoogleService-Info.plist', '<plist/>')
    await put('ios/GoogleService-Info-Dev.plist', '<plist/>')
    await put('.firebaserc', JSON.stringify({ projects: { default: 'p-prod', dev: 'p-dev' } }))
    const files = ['package.json', '.env.example', 'CHANGELOG.md', 'logs/2026-01-01-session.md', 'logs/2026-01-02-session.md', 'logs/2026-01-03-session.md', 'ios/GoogleService-Info.plist', 'ios/GoogleService-Info-Dev.plist', '.firebaserc']
    const { signals } = await detectSignals(root, { files })
    assert.deepEqual(signals.metered.map((s) => s.signal), ['openai', 'GROQ_API_KEY'])
    assert.deepEqual(signals.dated.map((s) => s.source), ['CHANGELOG.md', 'logs/'])
    assert.deepEqual(signals.identities.map((s) => s.signal), ['GoogleService-Info.plist', 'GoogleService-Info-Dev.plist', '2 Firebase projects (default, dev)'])
  })

  test('POSITIVE CONTROL: a paid API called over HTTPS with no SDK, and dates at the end of a name, are found (the field test)', async () => {
    await put('Sources/Client/GroqClient.swift', 'let url = URL(string: "https://api.groq.com/openai/v1/chat/completions")!\n')
    await put('node_modules/x/index.js', 'fetch("https://api.openai.com/v1")\n')
    const names = ['docs/pre-submission-audit-2026-08-10.md', 'docs/release-notes-2026-08-12.md', 'docs/review-2026-09-01.md']
    for (const n of names) await put(n, 'x\n')
    const { signals } = await detectSignals(root, { files: ['Sources/Client/GroqClient.swift', 'node_modules/x/index.js', ...names] })
    assert.deepEqual(signals.metered.map((s) => [s.signal, s.source]), [['api.groq.com', 'Sources/Client/GroqClient.swift']], 'a dependency\'s own code is not the project calling it')
    assert.deepEqual(signals.dated.map((s) => s.source), ['docs/'])
    assert.deepEqual(datedRecords(['a/build-12345-67-89.log', 'a/build-12346-67-89.log', 'a/build-12347-67-89.log']), [], 'a build number is not a date')
  })

  test('two dated files, one Firebase config, and a .env.local are not enough', async () => {
    assert.deepEqual(datedRecords(['a/2026-01-01.md', 'a/2026-01-02.md']), [])
    await put('.env.local', 'X=1\n')
    await put('.env.production', 'X=1\n')
    const { signals } = await detectSignals(root, { files: ['ios/GoogleService-Info.plist', '.env.local', '.env.production'] })
    assert.deepEqual(signals.identities, [])
  })
})

describe('triggers accepted at install', () => {
  test('POSITIVE CONTROL: the rule lands in active/ with the fact that fired it, stamped once; T3 brings its gate and its Bash hook', async () => {
    const detected = { ...DETECTED, agentConfig: { claudeMd: true, agentsMd: true }, signals: { metered: [{ signal: 'openai' }] } }
    const doc = docWith({ 'harness.triggers': ['T3', 'T4'] })
    const first = await buildArtifacts({ doc, detected })
    const body = (p) => first.find((a) => a.path === p)?.body
    assert.match(body('docs/rules/active/spend-protocol.md'), /\*\*Triggered:\*\* T4, because it uses a paid or metered API \(openai\); active since \d{4}-\d{2}-\d{2} \(caselaw 0\.3\)/)
    const gates = JSON.parse(body('.caselaw/gates.json'))
    assert.deepEqual(gates.gates.map((g) => [g.id, g.kind, g.severity, g.origin]), [['stage-explicit-paths', 'command', 'warn', 'docs/rules/active/stage-explicit-paths.md']])
    assert.match(body('.claude/settings.json'), /"matcher": "Bash"/)
    assert.match(body('docs/authority-split.md'), /Rules this repository's own facts triggered, each in `docs\/rules\/active\/` with the fact that fired\nit: T3 `stage-explicit-paths`, T4 `spend-protocol`\./)

    // The detection that fired it changes later; the rule's text does not.
    const later = await buildArtifacts({ doc, detected: { ...detected, signals: { metered: [{ signal: 'replicate' }] } } })
    assert.equal(later.find((a) => a.path === 'docs/rules/active/spend-protocol.md').body, body('docs/rules/active/spend-protocol.md'))
  })

  test('without T3, no gate and no Bash hook', async () => {
    const artifacts = await buildArtifacts({ doc: docWith({ 'harness.triggers': ['T4'] }), detected: DETECTED })
    assert.deepEqual(JSON.parse(artifacts.find((a) => a.path === '.caselaw/gates.json').body).gates, [])
    assert.doesNotMatch(artifacts.find((a) => a.path === '.claude/settings.json').body, /Bash/)
  })

  test('POSITIVE CONTROL: every triggered rule renders as a valid rule, under its own name, with no Origin of its own', async () => {
    const files = (await readdir(TRIGGERED_ROOT)).filter((f) => f.endsWith('.md')).sort()
    assert.deepEqual(files, [...new Set(TRIGGERS.map((t) => `${t.rule}.md`))].sort())
    for (const t of TRIGGERS) {
      const artifacts = await buildArtifacts({ doc: docWith({ 'harness.triggers': [t.id] }, { facts: { [t.id]: 'a fact' }, triggerSince: { [t.id]: '2026-10-31' } }), detected: DETECTED })
      const text = artifacts.find((a) => a.path === `docs/rules/active/${t.rule}.md`).body
      const parsed = parseRule(text, { path: `${t.rule}.md` })
      assert.equal(parsed.name, t.rule)
      assert.equal(parsed.origin, null)
      assert.deepEqual(validateRule(parsed, { filename: `${t.rule}.md`, resolveRef: false }).problems, [], t.rule)
      assert.doesNotMatch(text, /\{\{|\}\}/)
    }
  })
})

describe('triggers that fire on a later upgrade', () => {
  const detected = { signals: { metered: [{ signal: 'openai' }] } }

  test('POSITIVE CONTROL: "Ask me first" proposes once, with the fact; a proposal the human rejected is not written again', async () => {
    const doc = docWith({ 'harness.autonomy': 'ask-first' }, { triggersOffered: [] })
    const r = await applyTriggers({ root, doc, detected, now: new Date('2026-11-02') })
    assert.deepEqual(r.proposed.map((p) => [p.id, p.path]), [['T4', 'docs/rules/proposed/spend-protocol.md']])
    const text = await readFile(join(root, 'docs/rules/proposed/spend-protocol.md'), 'utf8')
    assert.match(text, /\*\*Triggered:\*\* T4, because it uses a paid or metered API \(openai\); proposed 2026-11-02/)
    assert.deepEqual(doc.harness.triggersOffered, ['T4'])
    assert.equal(doc.answers['harness.triggers'], undefined, 'nothing is in force until a human ratifies it')

    await rm(join(root, 'docs/rules/proposed/spend-protocol.md'))
    const again = await applyTriggers({ root, doc, detected })
    assert.deepEqual(again.proposed, [], 'rejected stays rejected')
    assert.equal(await exists('docs/rules/proposed/spend-protocol.md'), false)
  })

  test('POSITIVE CONTROL: "Tune itself" applies a trigger on its own; Custom applies only the ones picked; a dry run writes nothing', async () => {
    const tune = docWith({ 'harness.autonomy': 'tune-itself' }, { triggersOffered: [] })
    const r = await applyTriggers({ root, doc: tune, detected })
    assert.deepEqual(r.applied.map((a) => a.id), ['T4'])
    assert.deepEqual(tune.answers['harness.triggers'], ['T4'])
    assert.equal(await exists('docs/rules/proposed/spend-protocol.md'), false)

    const both = { signals: { metered: [{ signal: 'openai' }], dated: [{ signal: 'CHANGELOG.md', source: 'CHANGELOG.md' }] } }
    const custom = docWith({ 'harness.autonomy': 'custom', 'harness.auto_triggers': ['T5'] }, { triggersOffered: [] })
    const c = await applyTriggers({ root, doc: custom, detected: both })
    assert.deepEqual([c.applied.map((a) => a.id), c.proposed.map((p) => p.id)], [['T5'], ['T4']])

    const dry = docWith({}, { triggersOffered: [] })
    await rm(join(root, 'docs'), { recursive: true, force: true })
    const d = await applyTriggers({ root, doc: dry, detected, dryRun: true })
    assert.deepEqual(d.proposed.map((p) => p.id), ['T4'])
    assert.equal(await exists('docs/rules/proposed/spend-protocol.md'), false)
    assert.deepEqual(dry.harness.triggersOffered, [], 'a dry run remembers nothing')
  })

  test('POSITIVE CONTROL: what the install screen showed is not proposed again', async () => {
    const doc = docWith({ 'harness.triggers': [] })
    markOffered(doc, detected)
    assert.deepEqual(doc.harness.triggersOffered, ['T4'])
    assert.deepEqual((await applyTriggers({ root, doc, detected })).proposed, [])
  })

  test('POSITIVE CONTROL: a ratified writer-guard proposal turns the guard on, and a gates.json the human filled gets it directly', async () => {
    const doc = docWith({}, { triggersOffered: ['T3'] })
    await put('docs/rules/active/stage-explicit-paths.md', '# stage-explicit-paths\n')
    await put('.caselaw/gates.json', JSON.stringify({ version: 1, gates: [{ id: 'mine', kind: 'banned-content', origin: 'docs/rules/active/x.md', patterns: ['x'] }] }))
    const r = await applyTriggers({ root, doc, detected: {} })
    assert.equal(r.guard, true)
    assert.equal(writerGuardOn(doc), true)
    const gates = JSON.parse(await readFile(join(root, '.caselaw/gates.json'), 'utf8')).gates
    assert.deepEqual(gates.map((g) => g.id), ['mine', 'stage-explicit-paths'])
  })
})

describe('demoting a generated rule', () => {
  test('POSITIVE CONTROL: it is taken out of the answers too, so an upgrade does not reinstall it', async () => {
    const doc = docWith({ 'harness.defaults': ['D1', 'D2'], 'harness.triggers': ['T4'] })
    await put('.caselaw/answers.json', JSON.stringify(doc))
    await put('docs/rules/active/re-derive-claims.md', '# re-derive-claims\n\n**Trigger:** x.\n\n**Rule:** y.\n\n**Precedent:** DEF-1.\n\n**Enforcement:** memory\n\n**Default:** D1, active since 2026-10-31\n')
    await put('docs/rules/active/spend-protocol.md', '# spend-protocol\n\n**Trigger:** x.\n\n**Rule:** y.\n\n**Precedent:** DEF-1.\n\n**Enforcement:** memory\n\n**Triggered:** T4, because z; active since 2026-10-31\n')
    const io = { root, say: () => {}, interactive: true, prompt: () => ({}) }
    assert.equal(await cmdRule({ sub: 'demote', name: 're-derive-claims', opt: {}, yes: true }, io), 0)
    assert.equal(await cmdRule({ sub: 'demote', name: 'spend-protocol', opt: {}, yes: true }, io), 0)
    const answers = JSON.parse(await readFile(join(root, '.caselaw/answers.json'), 'utf8')).answers
    assert.deepEqual([answers['harness.defaults'], answers['harness.triggers']], [['D2'], []])
    const artifacts = await buildArtifacts({ doc: { ...doc, answers }, detected: DETECTED })
    assert.ok(!artifacts.some((a) => a.path === 'docs/rules/active/re-derive-claims.md' || a.path === 'docs/rules/active/spend-protocol.md'))
  })
})

describe('the audit on a triggered rule', () => {
  test('POSITIVE CONTROL: it stands on its precedent, and its window counts from "active since", not from the file', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const commit = (date) => {
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'x'], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
    }
    await put('docs/rules/active/spend-protocol.md', '# spend-protocol\n\n**Trigger:** a paid call.\n\n**Rule:** project the cost first.\n\n**Precedent:** DEF-194 (2026-08-12).\n\n**Enforcement:** memory\n\n**Triggered:** T4, because it uses openai; active since 2026-01-01 (caselaw 0.3)\n')
    commit('2026-01-05T00:00:00')
    const r = runChecks(await gather(root, { now: new Date('2026-03-15') }), { only: ['borrowed-rules-earn', 'origin-resolves'] })
    const codes = (c) => r.findings.filter((f) => f.code === c).map((f) => f.message)
    assert.deepEqual(codes('origin-resolves'), [], 'a triggered rule is not an origin error')
    assert.match(codes('borrowed-rules-earn')[0] || '', /caught nothing here in 73 days and 1 commit\(s\) since 2026-01-01/)
  })
})
