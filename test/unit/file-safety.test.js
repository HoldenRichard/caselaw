/**
 * The install layer touches real files, owns what it wrote, and reads what
 * an editor saved.
 *
 * - A managed path replaced by a symlink hashed by its TARGET, reconciled as
 *   pristine content we own, and `upgrade` — without --force — overwrote a
 *   file outside the repository through it; a directory in a managed path
 *   vanished from the eject plan. Real files only, everything else reported.
 * - UNCHANGED artifacts were never recorded, so after an interrupted install
 *   or an eject that kept the docs, files in exactly our shape stayed unowned:
 *   upgrade could not update them and eject could not remove them.
 * - A UTF-8 BOM — what Notepad and PowerShell write — made every CLI-side
 *   JSON loader throw while the runtime tolerated it, so doctor reported the
 *   exact opposite of the truth.
 * - A corrupt answers.json was diagnosed as "not installed", with the hint
 *   `caselaw init`, which reads the same file and dies the same way.
 * - upgrade never advanced the version stamps, so the new-questions mechanism
 *   could never converge.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { emptyManifest, record, reconcile, ejectPlan, MANIFEST_PATH } from '../../src/core/manifest.js'
import { buildPlan, SKIP, UNCHANGED } from '../../src/core/plan.js'
import { locate } from '../../src/core/blocks.js'
import { hash } from '../../src/core/text.js'
import * as gatesStore from '../../src/core/gates.js'
import * as answersStore from '../../src/core/answers.js'
import * as manifestStore from '../../src/core/manifest.js'
import { buildArtifacts } from '../../src/generate/artifacts.js'
import { doctor, applyEject, planEject } from '../../src/commands/lifecycle.js'
import { CLI_VERSION, TEMPLATE_VERSION } from '../../bin/cli.mjs'

const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
const DETECTED = { agentConfig: { claudeMd: true }, commands: {}, deploySurface: [] }
const answersDoc = (templateVersion = '1.0') => {
  const doc = answersStore.emptyAnswers({ templateVersion, project: { name: 'P' } })
  doc.generatedAt = '2026-08-13T00:00:00.000Z'
  Object.assign(doc.answers, {
    'authority.cannot': ['deploy'], 'authority.triage': { deploy: 'chosen' },
    'authority.human_proof': 'Deploy by hand and watch the logs.', 'authority.agent_reach': 'It can run the suite.',
  })
  return doc
}
async function installAt(root) {
  execFileSync('git', ['init', '-q'], { cwd: root })
  await writeFile(join(root, 'CLAUDE.md'), '# Project\n\nMy own notes.\n', 'utf8')
  const doc = answersDoc()
  const artifacts = await buildArtifacts({ doc, detected: DETECTED })
  const manifest = manifestStore.emptyManifest()
  const plan = await buildPlan(root, artifacts, { manifest })
  for (const e of plan.entries) {
    if (e.action === UNCHANGED || e.action === SKIP) continue
    await mkdir(join(root, e.path, '..'), { recursive: true })
    await writeFile(join(root, e.path), e.nextText, 'utf8')
    manifestStore.record(manifest, { path: e.path, kind: e.kind, blockId: e.blockId, contentHash: e.kind === 'file' ? hash(e.nextText) : e.interiorHash })
  }
  await manifestStore.save(root, manifest)
  await answersStore.save(root, doc)
  return doc
}

describe('real files only', () => {
  test('POSITIVE CONTROL: a managed path that is a symlink or a directory is never treated as ours to rewrite or silently delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'caselaw-c8-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'caselaw-c8-outside-'))
    try {
      const generated = '# generated doctrine\n'
      const target = join(outside, 'stolen.md')
      await writeFile(target, generated, 'utf8')
      await mkdir(join(root, 'docs'), { recursive: true })
      await symlink(target, join(root, 'docs/close-out.md'))
      await mkdir(join(root, 'docs/authority-split.md'), { recursive: true })
      await writeFile(join(root, 'docs/authority-split.md/inside.txt'), 'x', 'utf8')

      const manifest = emptyManifest()
      record(manifest, { path: 'docs/close-out.md', kind: 'file', contentHash: hash(generated) })
      record(manifest, { path: 'docs/authority-split.md', kind: 'file', contentHash: hash('# authority\n') })

      const r = await reconcile(root, manifest, { locate })
      assert.ok(!r.clean.includes('docs/close-out.md'), 'reconcile must not report a symlinked managed path as clean — it hashed the target, not a file in this repo')
      assert.ok(!r.modified.includes('docs/close-out.md') && !r.missing.includes('docs/close-out.md'))
      assert.ok(r.unreadable.some((u) => u.path === 'docs/authority-split.md' && /directory/.test(u.reason)))
      assert.ok(r.unreadable.some((u) => u.path === 'docs/close-out.md' && /symlink/.test(u.reason)))

      const plan = ejectPlan(manifest, r)
      assert.ok(!plan.deleteFiles.includes('docs/authority-split.md'), 'ejectPlan must not schedule a blind DELETE for what it cannot read')
      assert.ok(plan.leaveAlone.some((x) => x.path === 'docs/authority-split.md' && /directory/.test(x.reason)), 'an unreadable managed path belongs in leaveAlone, with a reason')
      assert.ok(plan.leaveAlone.some((x) => x.path === 'docs/close-out.md' && /symlink/.test(x.reason)))

      const built = await buildPlan(root, [{ path: 'docs/close-out.md', kind: 'file', body: '# regenerated doctrine\n' }], { manifest })
      const entry = built.entries.find((e) => e.path === 'docs/close-out.md')
      assert.equal(entry.action, SKIP, `buildPlan handed writePlan a writable "${entry.action}" for a symlink out of the repo; applying it would overwrite ${target}`)
      assert.match(entry.reason, /symlink/)
      assert.equal(await readFile(target, 'utf8'), generated, 'the file outside the repo is untouched')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('eject leaves a symlinked managed path alone and says so', async () => {
    const root = await mkdtemp(join(tmpdir(), 'caselaw-eject-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'caselaw-eject-outside-'))
    try {
      await installAt(root)
      const target = join(outside, 'theirs.md')
      await writeFile(target, '# theirs\n\n<!-- caselaw:begin id=pointer v=1 hash=x -->\nblock\n<!-- caselaw:end id=pointer -->\n', 'utf8')
      await unlink(join(root, 'CLAUDE.md'))
      await symlink(target, join(root, 'CLAUDE.md'))
      const plan = await planEject({ root })
      assert.ok(plan.leaveAlone.some((x) => x.path === 'CLAUDE.md' && /symlink/.test(x.reason)))
      const res = await applyEject({ root, plan })
      assert.ok(!res.stripped.includes('CLAUDE.md') && !res.removed.includes('CLAUDE.md'))
      assert.match(await readFile(target, 'utf8'), /caselaw:begin/, 'the file behind the link was not written through')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('ownership survives what it should', () => {
  test('POSITIVE CONTROL: writePlan records UNCHANGED artifacts, so a re-install re-owns files already on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'caselaw-unchanged-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      await answersStore.save(root, answersDoc())
      const run = () => execFileSync(process.execPath, [CLI, 'upgrade', '--yes', root], { cwd: root, encoding: 'utf8' })
      run()
      const first = await manifestStore.load(root)
      const owned = Object.keys(first.entries)
      assert.ok(owned.length > 1, 'sanity: the first upgrade should own more than one artifact')
      // The state `eject` and an interrupted install both leave behind: the
      // artifacts are on disk, the manifest that claimed them is gone.
      const victim = owned.find((p) => p.startsWith('docs/') && p !== 'docs/authority-split.md')
      await unlink(join(root, MANIFEST_PATH))
      await unlink(join(root, victim))
      run()
      const reowned = new Set(Object.keys((await manifestStore.load(root)).entries))
      const lost = owned.filter((p) => !reowned.has(p))
      assert.deepEqual(lost, [], `artifacts left unowned after re-install (upgrade cannot update them, eject cannot remove them): ${lost.join(', ')}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('POSITIVE CONTROL: upgrade stamps the running CLI and template version into the install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'caselaw-vstall-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      await writeFile(join(root, 'CLAUDE.md'), '# Project\n\nMy own notes.\n', 'utf8')
      await answersStore.save(root, answersDoc('0.9'))
      await manifestStore.save(root, manifestStore.emptyManifest({ cliVersion: '0.0.1', templateVersion: '0.9' }))
      const out = execFileSync(process.execPath, [CLI, 'upgrade', '--yes', root], { encoding: 'utf8' })
      assert.match(out, /Updated \d+ file\(s\)\./, 'the upgrade must actually have written something')
      const manifest = JSON.parse(await readFile(join(root, '.caselaw/manifest.json'), 'utf8'))
      const answers = JSON.parse(await readFile(join(root, '.caselaw/answers.json'), 'utf8'))
      assert.equal(manifest.cliVersion, CLI_VERSION, 'manifest.cliVersion must record the build that last wrote these files')
      assert.equal(manifest.templateVersion, TEMPLATE_VERSION)
      assert.equal(answers.templateVersion, TEMPLATE_VERSION, 'answers.templateVersion is what newQuestionsSince() reads; frozen, an upgrade can never converge')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('what an editor saved is still readable', () => {
  test('POSITIVE CONTROL: a UTF-8 BOM must not make gates.json, answers.json or manifest.json unreadable', async () => {
    const BOM = '﻿'
    const root = await mkdtemp(join(tmpdir(), 'caselaw-bom-'))
    try {
      await mkdir(join(root, '.caselaw'), { recursive: true })
      const gates = { version: gatesStore.SCHEMA_VERSION, gates: [{ id: 'no-todo', kind: 'banned-content', severity: 'block', paths: ['docs/**/*.md'], origin: 'docs/rules/active/no-todo.md', message: 'No XXTODOXX markers in docs.', patterns: [{ literal: 'XXTODOXX', label: 'todo marker' }] }] }
      await writeFile(join(root, gatesStore.GATES_PATH), BOM + JSON.stringify(gates, null, 2) + '\n', 'utf8')
      await writeFile(join(root, answersStore.ANSWERS_PATH), BOM + JSON.stringify(answersStore.emptyAnswers({ templateVersion: '1.0' }), null, 2) + '\n', 'utf8')
      await writeFile(join(root, manifestStore.MANIFEST_PATH), BOM + JSON.stringify(manifestStore.emptyManifest({ cliVersion: '0.1.0', templateVersion: '1.0' }), null, 2) + '\n', 'utf8')
      assert.equal((await gatesStore.load(root)).gates.length, 1, 'the gate must survive the BOM')
      assert.equal((await answersStore.load(root)).templateVersion, '1.0', 'doctor otherwise says "no .caselaw/answers.json" on an installed repo')
      assert.equal((await manifestStore.load(root)).schemaVersion, manifestStore.SCHEMA_VERSION)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('POSITIVE CONTROL: a corrupt answers.json is diagnosed as corrupt, not as "not installed"', async () => {
    const root = await mkdtemp(join(tmpdir(), 'caselaw-doctor-corrupt-'))
    try {
      await installAt(root)
      assert.equal((await doctor({ root })).ok, true, 'sanity: healthy before corruption')
      const whole = await readFile(join(root, '.caselaw/answers.json'), 'utf8')
      await writeFile(join(root, '.caselaw/answers.json'), whole.slice(0, Math.floor(whole.length / 2)), 'utf8')
      const r = await doctor({ root })
      const installed = r.findings.find((f) => f.name === 'installed')
      assert.equal(installed.status, 'fail')
      assert.doesNotMatch(installed.detail, /no \.caselaw\/answers\.json/, 'a file that exists but does not parse is corrupt, not absent')
      assert.match(installed.detail, /unreadable|corrupt|parse|JSON/i)
      assert.doesNotMatch(installed.hint ?? '', /caselaw init/, '`caselaw init` cannot recover this: it loads the same file and throws')
      for (const name of ['gate runner', 'hooks', 'gates']) {
        assert.ok(r.findings.some((f) => f.name === name), `doctor stopped before checking "${name}" — the wiring it exists to inspect is still live`)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
