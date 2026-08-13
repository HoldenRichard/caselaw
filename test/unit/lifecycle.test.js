import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { check, planUpgrade, planEject, applyEject, doctor, newQuestionsSince, LifecycleError } from '../../src/commands/lifecycle.js'
import { buildArtifacts } from '../../src/generate/artifacts.js'
import { buildPlan, UNCHANGED } from '../../src/core/plan.js'
import * as answersStore from '../../src/core/answers.js'
import * as manifestStore from '../../src/core/manifest.js'
import { hash } from '../../src/core/text.js'

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-life-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const DETECTED = { agentConfig: { claudeMd: true }, commands: {}, deploySurface: [] }

const put = async (rel, content) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const exists = async (p) => { try { await stat(join(root, p)); return true } catch { return false } }

/** Install the way `init` does, so lifecycle tests exercise the real artifacts. */
async function install(answers = {}) {
  await put('CLAUDE.md', '# Project\n\nMy own notes.\n')
  const doc = answersStore.emptyAnswers({ templateVersion: '1.0', project: { name: 'P' } })
  doc.generatedAt = '2026-08-13T00:00:00.000Z'
  Object.assign(doc.answers, {
    'authority.cannot': ['deploy'],
    'authority.triage': { deploy: 'chosen' },
    'authority.human_proof': 'Deploy by hand and watch the logs.',
    'authority.agent_reach': 'It can run the suite.',
    ...answers,
  })
  const artifacts = await buildArtifacts({ doc, detected: DETECTED })
  const manifest = manifestStore.emptyManifest()
  const plan = await buildPlan(root, artifacts, { manifest })
  for (const e of plan.entries) {
    if (e.action === UNCHANGED) continue
    await mkdir(join(root, e.path, '..'), { recursive: true })
    await writeFile(join(root, e.path), e.nextText, 'utf8')
    manifestStore.record(manifest, {
      path: e.path, kind: e.kind, blockId: e.blockId,
      contentHash: e.kind === 'block' ? e.interiorHash : hash(e.nextText),
    })
  }
  await manifestStore.save(root, manifest)
  await answersStore.save(root, doc)
  return doc
}

describe('check — stale vs diverged vs missing', () => {
  test('a fresh install is up to date', async () => {
    await install()
    const r = await check({ root, detected: DETECTED })
    assert.equal(r.ok, true)
    assert.deepEqual(r.stale, [])
    assert.deepEqual(r.diverged, [])
  })

  test('POSITIVE CONTROL: changed answers make the docs STALE and fail', async () => {
    const doc = await install()
    doc.answers['authority.human_proof'] = 'Something entirely different now.'
    await answersStore.save(root, doc)

    const r = await check({ root, detected: DETECTED })
    assert.equal(r.ok, false, 'committed docs that no longer match the answers must fail CI')
    assert.ok(r.stale.some((s) => s.path === 'docs/authority-split.md'))
  })

  test('POSITIVE CONTROL: a deleted artifact is MISSING, not stale', async () => {
    await install()
    await rm(join(root, 'docs/close-out.md'))
    const r = await check({ root, detected: DETECTED })
    assert.equal(r.ok, false)
    assert.ok(r.missing.some((m) => m.path === 'docs/close-out.md'))
  })

  test('a hand-edited file is DIVERGED and does not fail by default', async () => {
    await install()
    await put('docs/close-out.md', 'I rewrote this entirely.\n')
    const r = await check({ root, detected: DETECTED })
    assert.equal(r.ok, true, 'failing a build for a deliberate edit is how a check gets deleted')
    assert.ok(r.diverged.some((d) => d.path === 'docs/close-out.md'))
  })

  test('POSITIVE CONTROL: --strict does fail on a divergence', async () => {
    await install()
    await put('docs/close-out.md', 'mine now\n')
    assert.equal((await check({ root, detected: DETECTED, strict: true })).ok, false)
  })

  test('an uninstalled repo is not a failure', async () => {
    const r = await check({ root, detected: DETECTED })
    assert.equal(r.installed, false)
    assert.equal(r.ok, true)
  })
})

describe('upgrade', () => {
  test('brings a stale doc back in line without touching an edited one', async () => {
    const doc = await install()
    doc.answers['authority.human_proof'] = 'Changed.'
    await answersStore.save(root, doc)
    await put('docs/close-out.md', 'MY VERSION\n')

    const { plan } = await planUpgrade({ root, detected: DETECTED })
    const willWrite = plan.entries.filter((e) => e.action !== UNCHANGED && e.action !== 'SKIP')
    assert.ok(willWrite.some((e) => e.path === 'docs/authority-split.md'))
    assert.ok(plan.entries.find((e) => e.path === 'docs/close-out.md').action === 'SKIP',
      'the file the human rewrote must be left alone')
  })

  test('POSITIVE CONTROL: upgrading an uninstalled repo is refused, not improvised', async () => {
    await assert.rejects(
      () => planUpgrade({ root, detected: DETECTED }),
      (e) => e instanceof LifecycleError && e.code === 'NOT_INSTALLED',
    )
  })

  test('only questions added since the recorded template version are asked', () => {
    const qs = [{ id: 'a', since: '1.0' }, { id: 'b', since: '1.1' }, { id: 'c', since: '2.0' }]
    assert.deepEqual(newQuestionsSince('1.0', qs).map((q) => q.id), ['b', 'c'])
    assert.deepEqual(newQuestionsSince('1.1', qs).map((q) => q.id), ['c'])
    assert.deepEqual(newQuestionsSince('2.0', qs).map((q) => q.id), [],
      're-asking answered questions is how an upgrade becomes something people avoid')
  })
})

describe('eject', () => {
  test('removes the machinery and KEEPS the doctrine', async () => {
    await install()
    const plan = await planEject({ root })

    assert.ok(plan.deleteFiles.includes('.harness/bin/gate.mjs'))
    assert.ok(plan.deleteFiles.includes('.claude/settings.json'))
    assert.ok(!plan.deleteFiles.some((p) => p.startsWith('docs/')),
      'docs are the user\'s answers as prose; an uninstall must not destroy them')
    assert.ok(plan.keptDoctrine.length > 0)
  })

  test('--purge does remove the doctrine, for someone who asks', async () => {
    await install()
    const plan = await planEject({ root, purge: true })
    assert.ok(plan.deleteFiles.some((p) => p.startsWith('docs/')))
    assert.equal(plan.keptDoctrine.length, 0)
  })

  test('POSITIVE CONTROL: a file the human edited is never taken back', async () => {
    await install()
    await put('docs/close-out.md', 'mine\n')
    const plan = await planEject({ root })
    assert.ok(plan.leaveAlone.some((l) => l.path === 'docs/close-out.md'))
    assert.ok(!plan.deleteFiles.includes('docs/close-out.md'))
  })

  test('restores a shared file byte-for-byte, leaving no stray blank line', async () => {
    const original = '# Project\n\nMy own notes.\n'
    await install()
    const plan = await planEject({ root })
    await applyEject({ root, plan })
    assert.equal(await readFile(join(root, 'CLAUDE.md'), 'utf8'), original,
      'a stray blank line shows up as a diff in the next commit for no reason')
  })

  test('a file that held nothing but our block is removed, not left empty', async () => {
    await install()
    assert.equal(await exists('.gitignore'), true)
    const plan = await planEject({ root })
    await applyEject({ root, plan })
    assert.equal(await exists('.gitignore'), false, 'an empty .gitignore looks deliberate to the next reader')
  })

  test('the harness bookkeeping goes', async () => {
    await install()
    await applyEject({ root, plan: await planEject({ root }) })
    assert.equal(await exists('.harness/manifest.json'), false)
    assert.equal(await exists('.harness/answers.json'), false)
  })

  test('POSITIVE CONTROL: ejecting an uninstalled repo is refused', async () => {
    await assert.rejects(
      () => planEject({ root }),
      (e) => e instanceof LifecycleError && e.code === 'NOT_INSTALLED',
    )
  })
})

describe('doctor — is any of this actually wired up?', () => {
  test('a healthy install passes every wiring check', async () => {
    await install()
    const r = await doctor({ root })
    assert.equal(r.ok, true, JSON.stringify(r.findings, null, 1))
    assert.ok(r.findings.some((f) => f.name === 'gate runner' && f.status === 'ok'))
    assert.ok(r.findings.some((f) => f.name === 'hooks' && f.status === 'ok'))
  })

  test('POSITIVE CONTROL: hooks configured with no runner to invoke is a FAIL', async () => {
    await install()
    await rm(join(root, '.harness/bin/gate.mjs'))
    const r = await doctor({ root })
    assert.equal(r.ok, false, 'config that nothing can invoke is the failure this tool exists to prevent')
    assert.ok(r.findings.some((f) => f.name === 'gate runner' && f.status === 'fail'))
  })

  test('POSITIVE CONTROL: unparseable settings.json is a FAIL, not a shrug', async () => {
    await install()
    await put('.claude/settings.json', '{ broken')
    const r = await doctor({ root })
    assert.ok(r.findings.some((f) => f.name === 'hooks' && f.status === 'fail'))
  })

  test('POSITIVE CONTROL: hooks that never mention the runner are flagged', async () => {
    await install()
    await put('.claude/settings.json', JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }))
    const r = await doctor({ root })
    const f = r.findings.find((x) => x.name === 'hooks')
    assert.equal(f.status, 'warn')
    assert.match(f.hint, /nothing invokes/)
  })

  test('an uninstalled repo fails clearly rather than pretending', async () => {
    const r = await doctor({ root })
    assert.equal(r.ok, false)
    assert.match(r.findings[0].hint, /harness init/)
  })
})

describe('the whole round trip', () => {
  test('install → drift → check → upgrade → check → eject', async () => {
    const doc = await install()

    assert.equal((await check({ root, detected: DETECTED })).ok, true)

    doc.answers['authority.human_proof'] = 'A different procedure.'
    await answersStore.save(root, doc)
    assert.equal((await check({ root, detected: DETECTED })).ok, false)

    const { plan, manifest } = await planUpgrade({ root, detected: DETECTED })
    for (const e of plan.entries) {
      if (e.action === UNCHANGED || e.action === 'SKIP') continue
      await writeFile(join(root, e.path), e.nextText, 'utf8')
      manifestStore.record(manifest, {
        path: e.path, kind: e.kind, blockId: e.blockId,
        contentHash: e.kind === 'block' ? e.interiorHash : hash(e.nextText),
      })
    }
    await manifestStore.save(root, manifest)

    assert.equal((await check({ root, detected: DETECTED })).ok, true, 'upgrade must actually resolve the drift')
    assert.match(await readFile(join(root, 'docs/authority-split.md'), 'utf8'), /A different procedure/)

    await applyEject({ root, plan: await planEject({ root }) })
    assert.equal(await exists('.harness/bin/gate.mjs'), false)
    assert.equal(await exists('docs/authority-split.md'), true, 'the doctrine outlives the tool')
  })
})
