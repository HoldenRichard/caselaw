/**
 * The universal seam: git's pre-commit (0.5).
 *
 * Live hooks differ per agent tool, and a tool with no hook support gets no
 * enforcement from them. Every agent commits through git, so at install the
 * staged-change gates are wired into pre-commit, without ever clobbering a
 * hook or a hooks framework the project already has.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, realpath, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { inspectPreCommit, installPreCommit, ejectableHook, hookScript, HOOK_MARKER, HOOK_LINE, BLOCK_BEGIN, withoutBlock } from '../../src/core/githooks.js'
import { doctor, planEject, applyEject } from '../../src/commands/lifecycle.js'

const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
const RUNNER = fileURLToPath(new URL('../../runtime/gate.mjs', import.meta.url))

let root
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-precommit-')))
  git('init', '-q')
  for (const [k, v] of [['gc.auto', '0'], ['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) git('config', k, v)
  await writeFile(join(root, 'README.md'), '# P\n')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const exists = async (p) => { try { await stat(p); return true } catch { return false } }
const hookPath = () => join(root, '.git/hooks/pre-commit')

describe('what stands at the seam', () => {
  test('no git: nothing to report', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'caselaw-nogit-'))
    try {
      assert.equal((await inspectPreCommit(plain)).state, 'no-git')
      assert.equal((await installPreCommit(plain)).installed, false)
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  test('an empty hooks directory: install writes an executable, marked POSIX sh hook', async () => {
    assert.equal((await inspectPreCommit(root)).state, 'absent')
    const r = await installPreCommit(root)
    assert.equal(r.installed, true)
    const text = await readFile(hookPath(), 'utf8')
    assert.match(text, /^#!\/bin\/sh\n/)
    assert.ok(text.includes(HOOK_MARKER))
    assert.ok(text.includes('--mode staged'))
    assert.ok((await stat(hookPath())).mode & 0o111, 'executable')
    assert.equal((await inspectPreCommit(root)).state, 'ours')
    assert.equal((await installPreCommit(root)).installed, false, 'a second install changes nothing')
  })

  test('POSITIVE CONTROL: a pre-commit hook that is not ours is never overwritten; the exact line to add is given', async () => {
    await mkdir(join(root, '.git/hooks'), { recursive: true })
    await writeFile(hookPath(), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    const r = await installPreCommit(root)
    assert.equal(r.installed, false)
    assert.equal(r.state, 'foreign')
    assert.equal(r.wired, false)
    assert.ok(r.notice.includes(HOOK_LINE))
    assert.equal(await readFile(hookPath(), 'utf8'), '#!/bin/sh\necho mine\n')
  })

  test('a foreign hook that already runs the gates counts as wired', async () => {
    await mkdir(join(root, '.git/hooks'), { recursive: true })
    await writeFile(hookPath(), `#!/bin/sh\n${HOOK_LINE}\n`, { mode: 0o755 })
    const st = await inspectPreCommit(root)
    assert.equal(st.state, 'foreign')
    assert.equal(st.wired, true)
  })

  test('POSITIVE CONTROL: a husky hook gets one marked block, run first; the project\'s own lines survive and eject restores them', async () => {
    await mkdir(join(root, '.husky'))
    await writeFile(join(root, '.husky/pre-commit'), '#!/bin/sh\nnpm test\nexec true\n')
    const r = await installPreCommit(root)
    assert.equal(r.installed, true)
    assert.equal(r.framework, 'husky')
    assert.equal(r.wired, true)
    const text = await readFile(join(root, '.husky/pre-commit'), 'utf8')
    assert.ok(text.startsWith(`#!/bin/sh\n${BLOCK_BEGIN}`), 'the block runs before an exec can skip it')
    assert.ok(text.includes('npm test\nexec true\n'))
    assert.equal(await exists(hookPath()), false, 'nothing written to .git/hooks')
    assert.equal((await inspectPreCommit(root)).wired, true)
    assert.equal(withoutBlock(text), '#!/bin/sh\nnpm test\nexec true\n')
  })

  test('POSITIVE CONTROL: a YAML framework config is never edited; its snippet is the notice', async () => {
    await writeFile(join(root, '.pre-commit-config.yaml'), 'repos: []\n')
    const r = await installPreCommit(root)
    assert.equal(r.installed, false)
    assert.equal(r.wired, false)
    assert.equal(await readFile(join(root, '.pre-commit-config.yaml'), 'utf8'), 'repos: []\n')
    assert.ok(r.notice.includes(HOOK_LINE))
  })

  test('lefthook, pre-commit and core.hooksPath are frameworks too, each with a snippet naming the line', async () => {
    await writeFile(join(root, 'lefthook.yml'), 'pre-commit:\n  commands: {}\n')
    let st = await inspectPreCommit(root)
    assert.equal(st.framework, 'lefthook')
    assert.match(st.notice, /lefthook\.yml[\s\S]*run: node \.caselaw\/bin\/gate\.mjs --mode staged/)
    await rm(join(root, 'lefthook.yml'))

    await writeFile(join(root, '.pre-commit-config.yaml'), 'repos: []\n')
    st = await inspectPreCommit(root)
    assert.equal(st.framework, 'pre-commit')
    assert.match(st.notice, /entry: node \.caselaw\/bin\/gate\.mjs --mode staged/)
    await rm(join(root, '.pre-commit-config.yaml'))

    git('config', 'core.hooksPath', 'tools/githooks')
    st = await inspectPreCommit(root)
    assert.equal(st.framework, 'core.hooksPath')
    assert.equal(st.path, 'tools/githooks/pre-commit')
    assert.equal(await exists(hookPath()), false)
  })

  test('an install below the git root is reported, and nothing is written for it', async () => {
    const sub = join(root, 'app')
    await mkdir(sub)
    const st = await inspectPreCommit(sub)
    assert.equal(st.state, 'nested')
    assert.match(st.notice, /cd app/)
    assert.equal((await installPreCommit(sub)).installed, false)
    assert.equal(await exists(hookPath()), false)
  })
})

describe('the hook does its job', () => {
  async function installRunner(gates) {
    await mkdir(join(root, '.caselaw/bin'), { recursive: true })
    await copyFile(RUNNER, join(root, '.caselaw/bin/gate.mjs'))
    await writeFile(join(root, '.caselaw/gates.json'), JSON.stringify({ version: 1, gates }))
    await installPreCommit(root)
  }
  const commit = (msg = 'c') => spawnSync('git', ['commit', '-qm', msg], { cwd: root, encoding: 'utf8' })
  const banned = (severity) => ({ id: 'no-bad', kind: 'banned-content', severity, paths: ['**/*.txt'], origin: 'docs/rules/active/x.md', message: 'Remove it.', patterns: [{ literal: 'BADWORD', label: 'bad word' }] })

  test('POSITIVE CONTROL: a staged banned string stops the commit, and the report says which gate', async () => {
    await installRunner([banned('block')])
    await writeFile(join(root, 'a.txt'), 'BADWORD\n')
    git('add', 'a.txt')
    const r = commit()
    assert.notEqual(r.status, 0, 'the commit must be refused')
    assert.match(r.stderr, /BLOCK +no-bad/)
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status, 0, 'nothing was committed')
  })

  test('POSITIVE CONTROL: through a core.hooksPath hook (our block inside the project\'s file), a banned string still stops the commit', async () => {
    await mkdir(join(root, 'scripts/hooks'), { recursive: true })
    git('config', 'core.hooksPath', 'scripts/hooks')
    await installRunner([banned('block')])
    assert.ok((await readFile(join(root, 'scripts/hooks/pre-commit'), 'utf8')).includes(BLOCK_BEGIN))
    await writeFile(join(root, 'a.txt'), 'BADWORD\n')
    git('add', 'a.txt')
    const r = commit()
    assert.notEqual(r.status, 0, 'the commit must be refused')
    assert.match(r.stderr, /BLOCK +no-bad/)
  })

  test('a clean commit passes silently; a warn-severity fire passes and is shown', async () => {
    await installRunner([banned('warn')])
    await writeFile(join(root, 'ok.txt'), 'fine\n')
    git('add', 'ok.txt')
    const clean = commit('clean')
    assert.equal(clean.status, 0, clean.stderr)
    assert.doesNotMatch(clean.stderr, /harness gates/, 'quiet when nothing fired')
    await writeFile(join(root, 'w.txt'), 'BADWORD\n')
    git('add', 'w.txt')
    const warned = commit('warned')
    assert.equal(warned.status, 0, warned.stderr)
    assert.match(warned.stderr, /warn +no-bad/)
  })

  test('a missing runner never blocks a commit, and says so', async () => {
    await installPreCommit(root)
    await writeFile(join(root, 'a.txt'), 'x\n')
    git('add', 'a.txt')
    const r = commit()
    assert.equal(r.status, 0)
    assert.match(r.stderr, /gate runner not found/)
  })
})

describe('doctor and eject', () => {
  const ANSWERS = { schemaVersion: 1, templateVersion: '1.2', project: { name: 'P' }, answers: {}, unanswered: [] }
  async function bare() {
    await mkdir(join(root, '.caselaw/bin'), { recursive: true })
    await copyFile(RUNNER, join(root, '.caselaw/bin/gate.mjs'))
    await writeFile(join(root, '.caselaw/answers.json'), JSON.stringify(ANSWERS))
    await writeFile(join(root, '.caselaw/gates.json'), JSON.stringify({ version: 1, gates: [] }))
  }
  const finding = async () => (await doctor({ root })).findings.find((f) => f.name === 'pre-commit')

  test('POSITIVE CONTROL: doctor reports the pre-commit seam unwired, with the line to add, for each case', async () => {
    await bare()
    let f = await finding()
    assert.equal(f.status, 'warn')
    assert.match(f.hint, /caselaw upgrade/)

    await mkdir(join(root, '.husky'))
    await writeFile(join(root, '.husky/pre-commit'), 'npm test\n')
    f = await finding()
    assert.equal(f.status, 'warn')
    assert.match(f.detail, /husky/)
    assert.ok(f.hint.includes(HOOK_LINE))

    await writeFile(join(root, '.husky/pre-commit'), `${HOOK_LINE}\n`)
    assert.equal((await finding()).status, 'ok')
  })

  test('doctor is ok once our hook is in place, and silent about it outside git', async () => {
    await bare()
    await installPreCommit(root)
    assert.equal((await finding()).status, 'ok')
    await rm(join(root, '.git'), { recursive: true, force: true })
    assert.equal(await finding(), undefined)
  })

  test('POSITIVE CONTROL: eject removes our unedited hook and no other', async () => {
    await bare()
    await writeFile(join(root, '.caselaw/manifest.json'), JSON.stringify({ schemaVersion: 1, entries: {} }))
    await installPreCommit(root)
    await writeFile(join(root, '.git/hooks/commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const plan = await planEject({ root })
    assert.equal(plan.gitHook.action, 'delete')
    const res = await applyEject({ root, plan })
    assert.ok(res.removed.includes('.git/hooks/pre-commit'))
    assert.equal(await exists(hookPath()), false)
    assert.equal(await exists(join(root, '.git/hooks/commit-msg')), true)
  })

  test('POSITIVE CONTROL: eject keeps a marked hook the user has edited, and a hook that was never ours', async () => {
    await bare()
    await writeFile(join(root, '.caselaw/manifest.json'), JSON.stringify({ schemaVersion: 1, entries: {} }))
    await mkdir(join(root, '.git/hooks'), { recursive: true })
    await writeFile(hookPath(), hookScript() + 'echo my own addition\n', { mode: 0o755 })
    assert.deepEqual(await ejectableHook(root), { path: hookPath(), action: 'keep', reason: 'you edited it' })
    await applyEject({ root, plan: await planEject({ root }) })
    assert.match(await readFile(hookPath(), 'utf8'), /my own addition/)

    await writeFile(hookPath(), '#!/bin/sh\necho theirs\n')
    assert.equal(await ejectableHook(root), null)
  })

  test('init wires the hook and tells the user; with husky it adds a marked block that eject removes', async () => {
    const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
    git('add', '-A')
    git('commit', '-qm', 'x')
    const draft = run(['init', '--draft'])
    assert.equal(draft.status, 0)
    const path = join(root, '.caselaw/draft.json')
    const d = JSON.parse(await readFile(path, 'utf8'))
    for (const q of d.questions) {
      if (q.id === 'authority.cannot') Object.assign(q, { answer: ['full-suite'], evidence: ['command: x'] })
      if (q.id === 'authority.triage') Object.assign(q, { answer: { 'full-suite': 'physical' }, evidence: ['command: x'] })
      if (q.id === 'authority.human_proof') Object.assign(q, { answer: 'By hand.', source: 'human', evidence: [] })
      if (q.id === 'authority.agent_reach') q.answer = '?'
    }
    await writeFile(path, JSON.stringify(d))
    const preview = run(['init', '--from-draft', '--dry-run'])
    assert.match(preview.stdout, /ALSO {6}\.git\/hooks\/pre-commit/, 'the plan names the hook before anyone confirms')
    assert.equal(await exists(hookPath()), false, 'a dry run writes nothing')
    const r = run(['init', '--from-draft', '--yes'])
    assert.equal(r.status, 0, r.stdout)
    assert.match(r.stdout, /Wired \.git\/hooks\/pre-commit/)
    assert.equal((await inspectPreCommit(root)).state, 'ours')

    const eject = run(['eject', '--yes'])
    assert.match(eject.stdout, /DELETE {2}\.git\/hooks\/pre-commit/)
    assert.equal(await exists(hookPath()), false)

    await mkdir(join(root, '.husky'))
    await writeFile(join(root, '.husky/pre-commit'), 'npm test\n')
    git('add', '-A')
    git('commit', '-qm', 'husky')
    assert.equal(run(['init', '--draft']).status, 0)
    const d2 = JSON.parse(await readFile(path, 'utf8'))
    for (const q of d2.questions) {
      if (q.id === 'authority.cannot') Object.assign(q, { answer: ['full-suite'], evidence: ['command: x'] })
      if (q.id === 'authority.triage') Object.assign(q, { answer: { 'full-suite': 'physical' }, evidence: ['command: x'] })
      if (q.id === 'authority.human_proof') Object.assign(q, { answer: 'By hand.', source: 'human', evidence: [] })
      if (q.id === 'authority.agent_reach') q.answer = '?'
    }
    await writeFile(path, JSON.stringify(d2))
    const again = run(['init', '--from-draft', '--yes'])
    assert.equal(again.status, 0, again.stdout)
    assert.match(again.stdout, /Wired \.husky\/pre-commit/)
    assert.equal(await exists(hookPath()), false)
    const husky = await readFile(join(root, '.husky/pre-commit'), 'utf8')
    assert.ok(husky.includes(BLOCK_BEGIN) && husky.endsWith('npm test\n'), 'one marked block added; the project\'s line stays')
    const out = run(['eject', '--yes'])
    assert.equal(out.status, 0, out.stdout)
    assert.equal(await readFile(join(root, '.husky/pre-commit'), 'utf8'), 'npm test\n', 'eject removes only the block')
  })
})
