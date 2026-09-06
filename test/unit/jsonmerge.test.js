/**
 * .claude/settings.json is merged into, never written whole.
 *
 * It was generated as a whole-file artifact. A project that already had one —
 * permissions, a model pin, hooks of its own, which is most projects that use
 * Claude Code — got SKIP, no hook was ever installed, and the harness sat
 * inert while doctor said "Wiring looks live". With --force the file was
 * REPLACED: a retrofitted repository lost its model pin, its effort setting and two
 * curriculum hooks to a plan line that said "regenerated". Our content is the
 * two hook entries. Everything else in the file is the project's.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { merge, strip, extractOurs, hashOurs, HOOK_MARK } from '../../src/core/jsonmerge.js'
import { claudeHookSettings, buildArtifacts } from '../../src/generate/artifacts.js'
import { buildPlan, SKIP, MERGE, NEW, UNCHANGED } from '../../src/core/plan.js'
import * as answersStore from '../../src/core/answers.js'
import * as manifestStore from '../../src/core/manifest.js'
import { locate } from '../../src/core/blocks.js'
import { planEject, applyEject } from '../../src/commands/lifecycle.js'
import { hash } from '../../src/core/text.js'

const OURS = claudeHookSettings().hooks
const THEIRS = {
  model: 'claude-opus-4-8[1m]',
  env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/curriculum_gate.py" pre', timeout: 30 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo their own hook' }] }],
  },
}
const theirsText = JSON.stringify(THEIRS, null, 2) + '\n'

describe('jsonmerge — the pure functions', () => {
  test('merging into nothing yields only our entries', () => {
    const r = merge(null, OURS)
    assert.equal(r.ok, true)
    assert.equal(r.action, 'merged')
    const parsed = JSON.parse(r.text)
    assert.deepEqual(Object.keys(parsed), ['hooks'])
    assert.ok(parsed.hooks.PreToolUse[0].hooks[0].command.includes(HOOK_MARK))
  })

  test('POSITIVE CONTROL: merging keeps every byte of the project\'s own config', () => {
    const r = merge(theirsText, OURS)
    assert.equal(r.action, 'merged')
    const merged = JSON.parse(r.text)
    assert.equal(merged.model, THEIRS.model)
    assert.deepEqual(merged.env, THEIRS.env)
    assert.deepEqual(merged.permissions, THEIRS.permissions)
    assert.deepEqual(merged.hooks.SessionStart, THEIRS.hooks.SessionStart, 'an event we do not touch is untouched')
    assert.equal(merged.hooks.PreToolUse.length, 2, 'their PreToolUse hook and ours coexist')
    assert.ok(merged.hooks.PreToolUse[0].hooks[0].command.includes('curriculum_gate.py'), 'theirs first, as it was')
    assert.ok(merged.hooks.PreToolUse[1].hooks[0].command.includes(HOOK_MARK))
    assert.ok(merged.hooks.PostToolUse[0].hooks[0].command.includes(HOOK_MARK))
  })

  test('a second merge is a no-op and leaves the project\'s formatting alone', () => {
    const once = merge(theirsText, OURS).text
    const weird = once.replace(/\n {2}/g, '\n    ') // re-indent the way a human editor might
    const again = merge(weird, OURS)
    assert.equal(again.action, 'unchanged')
    assert.equal(again.text, weird)
  })

  test('POSITIVE CONTROL: strip restores the project\'s file byte for byte', () => {
    const merged = merge(theirsText, OURS).text
    const back = strip(merged)
    assert.equal(back.action, 'stripped')
    assert.equal(back.text, theirsText)
  })

  test('strip empties a file that was only ours', () => {
    const ours = merge(null, OURS).text
    assert.equal(strip(ours).action, 'emptied')
    assert.equal(strip(theirsText).action, 'absent', 'nothing of ours to remove')
  })

  test('malformed JSON is refused, not guessed at', () => {
    assert.equal(merge('{ broken', OURS).ok, false)
    assert.match(merge('{ broken', OURS).reason, /JSON/)
    assert.equal(merge('[1,2]', OURS).ok, false)
  })

  test('extractOurs finds entries by the runner path, whatever else is in the file', () => {
    const merged = JSON.parse(merge(theirsText, OURS).text)
    const ours = extractOurs(merged)
    assert.equal(ours.PreToolUse.length, 1)
    assert.equal(ours.PostToolUse.length, 1)
    assert.equal(hashOurs(ours), hashOurs(OURS), 'what is present equals what we wanted')
  })
})

describe('jsonmerge — through the plan, the manifest and eject', () => {
  let root
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'caselaw-jm-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const DETECTED = { agentConfig: { claudeMd: true }, commands: {}, deploySurface: [] }
  const doc = () => {
    const d = answersStore.emptyAnswers({ templateVersion: '1.0', project: { name: 'P' } })
    d.generatedAt = '2026-08-13T00:00:00.000Z'
    Object.assign(d.answers, {
      'authority.cannot': ['deploy'], 'authority.triage': { deploy: 'chosen' },
      'authority.human_proof': 'Deploy by hand and watch the logs.', 'authority.agent_reach': 'It can run the suite.',
    })
    return d
  }
  async function install({ settings = null, force = false } = {}) {
    await writeFile(join(root, 'CLAUDE.md'), '# Project\n\nMy own notes.\n', 'utf8')
    if (settings !== null) {
      await mkdir(join(root, '.claude'), { recursive: true })
      await writeFile(join(root, '.claude/settings.json'), settings, 'utf8')
    }
    const artifacts = await buildArtifacts({ doc: doc(), detected: DETECTED })
    const manifest = (await manifestStore.load(root)) ?? manifestStore.emptyManifest()
    const plan = await buildPlan(root, artifacts, { manifest, force })
    for (const e of plan.entries) {
      if (e.action === UNCHANGED || e.action === SKIP) continue
      await mkdir(join(root, e.path, '..'), { recursive: true })
      await writeFile(join(root, e.path), e.nextText, 'utf8')
      manifestStore.record(manifest, { path: e.path, kind: e.kind, blockId: e.blockId, contentHash: e.kind === 'file' ? hash(e.nextText) : e.interiorHash })
    }
    await manifestStore.save(root, manifest)
    await answersStore.save(root, doc())
    return { plan, manifest }
  }
  const entry = (plan) => plan.entries.find((e) => e.path === '.claude/settings.json')

  test('POSITIVE CONTROL: a pre-existing .claude/settings.json still gets the gate hooks wired', async () => {
    const { plan } = await install({ settings: theirsText })
    const e = entry(plan)
    assert.notEqual(e.action, SKIP, 'a pre-existing settings.json must not make the gate hooks disappear entirely')
    assert.equal(e.action, MERGE)
    const written = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'))
    assert.ok(JSON.stringify(written.hooks).includes(HOOK_MARK), 'the planned settings.json must invoke .caselaw/bin/gate.mjs')
    assert.deepEqual(written.permissions, THEIRS.permissions, "the user's own permissions must survive")
    assert.ok(JSON.stringify(written.hooks).includes('echo their own hook'), "the user's own hook must survive")
    assert.equal(written.model, THEIRS.model)
  })

  test('a fresh repo gets a NEW settings.json; a re-run is UNCHANGED', async () => {
    const first = await install()
    assert.equal(entry(first.plan).action, NEW)
    const artifacts = await buildArtifacts({ doc: doc(), detected: DETECTED })
    const again = await buildPlan(root, artifacts, { manifest: await manifestStore.load(root) })
    assert.equal(entry(again).action, UNCHANGED)
  })

  test('POSITIVE CONTROL: --force replaces our entries and never touches the project\'s', async () => {
    // Seen on a retrofit: `init --force` on a repo with a committed settings.json
    // replaced the whole file and destroyed the model pin, the env block and
    // two hooks, under a plan line that read "regenerated".
    await install({ settings: theirsText, force: true })
    const written = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'))
    assert.equal(written.model, THEIRS.model)
    assert.deepEqual(written.env, THEIRS.env)
    assert.ok(JSON.stringify(written.hooks.PreToolUse).includes('curriculum_gate.py'))
    assert.deepEqual(written.hooks.SessionStart, THEIRS.hooks.SessionStart)
  })

  test('POSITIVE CONTROL: an edit to OUR entries is a SKIP, and only --force overrides it', async () => {
    await install()
    const p = join(root, '.claude/settings.json')
    const s = JSON.parse(await readFile(p, 'utf8'))
    s.hooks.PreToolUse[0].hooks[0].timeout = 99
    await writeFile(p, JSON.stringify(s, null, 2) + '\n', 'utf8')
    const artifacts = await buildArtifacts({ doc: doc(), detected: DETECTED })
    const manifest = await manifestStore.load(root)
    const plan = await buildPlan(root, artifacts, { manifest })
    assert.equal(entry(plan).action, SKIP)
    assert.match(entry(plan).reason, /edited the caselaw hook entries/)
    const forced = await buildPlan(root, artifacts, { manifest, force: true })
    assert.equal(entry(forced).action, MERGE)
    assert.equal(JSON.parse(entry(forced).nextText).hooks.PreToolUse[0].hooks[0].timeout, 30)
  })

  test('malformed settings.json is SKIPPED with the reason, never overwritten', async () => {
    const { plan } = await install({ settings: '{ broken' })
    assert.equal(entry(plan).action, SKIP)
    assert.match(entry(plan).reason, /JSON/)
    assert.equal(await readFile(join(root, '.claude/settings.json'), 'utf8'), '{ broken')
  })

  test('reconcile judges only our entries', async () => {
    await install({ settings: theirsText })
    const manifest = await manifestStore.load(root)
    let r = await manifestStore.reconcile(root, manifest, { locate })
    assert.ok(r.clean.includes('.claude/settings.json'))
    // The project edits its own key: still clean.
    const p = join(root, '.claude/settings.json')
    let s = JSON.parse(await readFile(p, 'utf8'))
    s.model = 'something-else'
    await writeFile(p, JSON.stringify(s, null, 2) + '\n', 'utf8')
    r = await manifestStore.reconcile(root, manifest, { locate })
    assert.ok(r.clean.includes('.claude/settings.json'), "the project's own keys are not ours to judge")
    // Our entry edited: modified. Our entries removed: missing.
    s = JSON.parse(await readFile(p, 'utf8'))
    s.hooks.PostToolUse = s.hooks.PostToolUse.map((e) => ({ ...e, matcher: 'Edit' }))
    await writeFile(p, JSON.stringify(s, null, 2) + '\n', 'utf8')
    r = await manifestStore.reconcile(root, manifest, { locate })
    assert.ok(r.modified.includes('.claude/settings.json'))
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter((e) => !JSON.stringify(e).includes(HOOK_MARK))
    delete s.hooks.PostToolUse
    await writeFile(p, JSON.stringify(s, null, 2) + '\n', 'utf8')
    r = await manifestStore.reconcile(root, manifest, { locate })
    assert.ok(r.missing.includes('.claude/settings.json'))
  })

  test('POSITIVE CONTROL: eject strips our entries and gives the project its file back, byte for byte', async () => {
    await install({ settings: theirsText })
    const plan = await planEject({ root })
    assert.ok(plan.stripBlocks.some((b) => b.path === '.claude/settings.json' && b.kind === 'json-merge'))
    assert.ok(!plan.deleteFiles.includes('.claude/settings.json'))
    await applyEject({ root, plan })
    assert.equal(await readFile(join(root, '.claude/settings.json'), 'utf8'), theirsText)
  })

  test('eject removes a settings.json that was only ever ours', async () => {
    await install()
    await applyEject({ root, plan: await planEject({ root }) })
    await assert.rejects(readFile(join(root, '.claude/settings.json'), 'utf8'))
  })
})
