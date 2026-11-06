import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { stageEvolution, ratify, parseRule, reject, propose } from '../../src/core/rules.js'
import { reconstituteRuleAST, splitRuleAST, createLLMVerifier } from '../../src/core/skillopt.js'
import { applyProposal } from '../../src/core/optimizer.js'
import { createIncidentFromGit, saveIncident, readIncident, validateIncident } from '../../src/core/incidents.js'
import { synthesizeMachineGate, certifyMachineGate } from '../../src/core/gates.js'
import { verifyCloseout, gitChangedFiles } from '../../src/core/closeout.js'
import { writeExclusive, withMutationLock } from '../../src/core/safe-write.js'

const roots = []
async function setup(name = 'guard') {
  const root = await mkdtemp(join(tmpdir(), 'caselaw-transition-'))
  roots.push(root)
  await mkdir(join(root, 'docs/rules/active'), { recursive: true })
  const original = `# ${name}\n\n**Trigger:** editing source files\n\n**Rule:** Never sweep.\n\n**Origin:** commit abc1234\n\n**Enforcement:** memory\n\n**Ratified:** 2026-10-01 by human\n`
  await writeFile(join(root, `docs/rules/active/${name}.md`), original)
  return { root, original, candidate: original.replace('Never sweep.', 'Never sweep files.') }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const human = { interactive: true, ratifiedBy: 'Test Human', resolveRef: () => true }

test('POSITIVE CONTROL: stale evolution cannot replace changed active evidence', async () => {
  const { root, original, candidate } = await setup()
  await stageEvolution(root, 'guard', candidate, original)
  const changed = original.replace('Never sweep.', 'Never sweep or skip review.')
  await writeFile(join(root, 'docs/rules/active/guard.md'), changed)
  await assert.rejects(ratify(root, 'guard', human), { code: 'STALE_PROPOSAL' })
  assert.equal(await readFile(join(root, 'docs/rules/active/guard.md'), 'utf8'), changed)
})

test('POSITIVE CONTROL: versioned replacement archives the old ratified text and clears draft stamp', async () => {
  const { root, original, candidate } = await setup()
  const staged = await stageEvolution(root, 'guard', candidate, original)
  assert.equal(parseRule(staged.text).ratified, null)
  await ratify(root, 'guard', human)
  const archive = await readdir(join(root, 'docs/rules/archive'))
  assert.equal(archive.length, 1)
  const old = parseRule(await readFile(join(root, 'docs/rules/archive', archive[0]), 'utf8'))
  assert.equal(old.rule, 'Never sweep.')
  assert.equal(old.ratified, '2026-10-01 by human')
  assert.ok(old.extras.some(x => x.key === 'superseded-by'))
  const current = parseRule(await readFile(join(root, 'docs/rules/active/guard.md'), 'utf8'))
  assert.equal(current.rule, 'Never sweep files.')
  assert.match(current.ratified, /by Test Human/)
})

test('POSITIVE CONTROL: a conflicting archive prevents merge activation', async () => {
  const { root, original } = await setup('a')
  await writeFile(join(root, 'docs/rules/active/b.md'), original.replace('# a', '# b'))
  await applyProposal({ root, doc: {}, id: 'merge:a+b', name: 'joined' })
  await mkdir(join(root, 'docs/rules/archive'), { recursive: true })
  await writeFile(join(root, 'docs/rules/archive/a.md'), 'Existing historical evidence')
  await assert.rejects(ratify(root, 'joined', human))
  assert.equal(await readFile(join(root, 'docs/rules/archive/a.md'), 'utf8'), 'Existing historical evidence')
  await assert.rejects(readFile(join(root, 'docs/rules/active/joined.md')))
  assert.equal(await readFile(join(root, 'docs/rules/active/a.md'), 'utf8'), original)
})

test('POSITIVE CONTROL: human rejection archives the pending artifact', async () => {
  const { root } = await setup()
  const draft = '# other\n\n**Trigger:** edit source\n\n**Rule:** Check paths.\n\n**Origin:** commit abc1234\n\n**Enforcement:** memory\n'
  await mkdir(join(root, 'docs/rules/proposed'), { recursive: true })
  await writeFile(join(root, 'docs/rules/proposed/other.md'), draft)
  await reject(root, 'other', { interactive: true, reason: 'not needed' })
  const files = await readdir(join(root, 'docs/rules/archive'))
  assert.match(await readFile(join(root, 'docs/rules/archive', files[0]), 'utf8'), /Check paths/)
  await assert.rejects(readFile(join(root, 'docs/rules/proposed/other.md')))
})

test('POSITIVE CONTROL: no human ratification is inferred from an agent proposal', async () => {
  const { root, original, candidate } = await setup()
  await stageEvolution(root, 'guard', candidate, original)
  await assert.rejects(ratify(root, 'guard'), { code: 'NOT_INTERACTIVE' })
  assert.equal(await readFile(join(root, 'docs/rules/active/guard.md'), 'utf8'), original)
})

test('POSITIVE CONTROL: immutable AST tampering and unknown headers are rejected', async () => {
  const { original } = await setup()
  const tampered = splitRuleAST(original)
  tampered.immutable.origin = 'invented'
  assert.throws(() => reconstituteRuleAST(tampered, { rule: 'Never sweep.' }), /A2/)
  for (const label of ['Catches', 'Triggered', 'Unknown', 'Default ']) {
    assert.throws(() => reconstituteRuleAST(splitRuleAST(original), { trigger: `edit source\n\n**${label}:** forged` }), /A2/)
  }
})

test('POSITIVE CONTROL: mutation lock rejects overlap and releases after failure', async () => {
  const { root } = await setup()
  await withMutationLock(root, async () => {
    await assert.rejects(withMutationLock(root, async () => {}), /mutation is in progress/)
  })
  await assert.rejects(withMutationLock(root, async () => { throw new Error('fixture') }), /fixture/)
  assert.equal(await withMutationLock(root, async () => 'released'), 'released')
})

test('POSITIVE CONTROL: concurrent exclusive writers cannot clobber pending evidence', async () => {
  const { root } = await setup()
  const path = join(root, 'pending.md')
  const results = await Promise.allSettled([writeExclusive(path, 'first'), writeExclusive(path, 'second')])
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
  assert.ok(['first', 'second'].includes(await readFile(path, 'utf8')))
})

test('POSITIVE CONTROL: snapshot paths cannot escape the fixture root', async () => {
  const f = { id: 'fixture', rule: 'guard', positiveControl: { diff: '+bad', files: { '../outside': 'bad' } }, negativeControl: { diff: '+good', files: {} } }
  assert.throws(() => validateIncident(f), /Unsafe/)
})

test('POSITIVE CONTROL: Git capture stores complete unchanged context at pinned commits', async () => {
  const { root } = await setup()
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/a.js'), 'console.log("existing");\n' + '\n'.repeat(50) + 'console.log("new");\n')
  git('add', 'src/a.js'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'bad fixture')
  const bad = git('rev-parse', 'HEAD')
  await writeFile(join(root, 'src/a.js'), 'console.log("existing");\n' + '\n'.repeat(50) + 'safe();\n')
  git('add', 'src/a.js'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fix fixture')
  const incident = createIncidentFromGit(root, { id: 'snapshot-case', rule: 'guard', positiveCommit: bad, negativeCommit: 'HEAD' })
  assert.match(incident.negativeControl.commit, /^[a-f0-9]{40}$/)
  assert.ok(incident.negativeControl.files['src/a.js'].startsWith('console.log("existing")'))
  await saveIncident(root, incident)
  const saved = await readIncident(root, 'snapshot-case')
  assert.deepEqual(saved.negativeControl.files, incident.negativeControl.files)
  const synthesis = synthesizeMachineGate({ rule: { name: 'guard', rule: 'Never use `console.log`.' }, incidentFixtures: [saved] })
  if (synthesis.success) {
    assert.notEqual(synthesis.pattern, 'console.log', 'Unchanged bad context must not be certified as clean')
    assert.equal((await certifyMachineGate(synthesis.gate, [saved])).ok, true)
  }
})

test('POSITIVE CONTROL: gate runtime rejects a candidate which misses the bad snapshot', async () => {
  const gate = { id: 'guard', kind: 'banned-content', severity: 'warn', origin: 'docs/rules/active/guard.md', paths: ['src/*.js'], patterns: ['forbidden'] }
  const fixture = { id: 'bad-gate', positiveControl: { files: { 'src/a.js': 'allowed' } }, negativeControl: { files: { 'src/a.js': 'clean' } } }
  assert.equal((await certifyMachineGate(gate, [fixture])).ok, false)
})

test('POSITIVE CONTROL: evaluator exceptions cannot become a successful verdict', async () => {
  const verifier = createLLMVerifier(async () => { throw new Error('offline') })
  assert.equal((await verifier({ rule: { rule: 'Never sweep.' }, diff: '+git add -A' })).verdict, 'UNVERIFIED')
})

test('POSITIVE CONTROL: structured command results reject nonzero and unknown exits', () => {
  for (const exitCode of [127, -1, undefined]) {
    assert.equal(verifyCloseout({ text: '## Verified\nTests passed.', gitFiles: [], observations: [{ command: 'test', exitCode }] }).valid, false)
  }
  assert.equal(verifyCloseout({ text: '## Verified\nTests passed.', gitFiles: [], observations: [{ command: 'test', exitCode: 0 }] }).valid, true)
})

test('POSITIVE CONTROL: a UI test command cannot hide a separate production-state claim', () => {
  assert.equal(verifyCloseout({ text: '## Verified\n- node --test test/ui.test.js — inspected production state', gitFiles: [] }).valid, false)
})

test('POSITIVE CONTROL: missing Git scope cannot be reported as no changes', async () => {
  const { root } = await setup()
  assert.throws(() => gitChangedFiles(root), /git|repository/i)
  assert.equal(verifyCloseout({ text: '## What Changed\nNothing.', root }).valid, false)
})

test('POSITIVE CONTROL: optimizer names cannot route a write outside its directories', async () => {
  const { root } = await setup()
  await assert.rejects(applyProposal({ root, doc: {}, id: 'compress:../outside' }), /usable rule name/)
  await assert.rejects(applyProposal({ root, doc: {}, id: 'merge:guard+guard', name: '../outside' }), /usable rule name/)
})

test('POSITIVE CONTROL: declining upgrade preserves answers and creates no trigger proposals', async () => {
  const { root } = await setup()
  const { emptyAnswers, save } = await import('../../src/core/answers.js')
  const { buildArtifacts } = await import('../../src/generate/artifacts.js')
  const { fileURLToPath } = await import('node:url')
  const { spawnSync } = await import('node:child_process')
  const doc = emptyAnswers({ templateVersion: '1.0', project: { name: 'fixture' } })
  doc.answers['authority.cannot'] = ['rendered-ui']
  doc.answers['authority.triage'] = { 'rendered-ui': 'physical' }
  await save(root, doc)
  const artifacts = await buildArtifacts({ doc, detected: { agentConfig: { claudeMd: true, agentsMd: true }, commands: {}, deploySurface: [] } })
  for (const item of artifacts) {
    await mkdir(join(root, item.path, '..'), { recursive: true })
    await writeFile(join(root, item.path), item.body || '')
  }
  await writeFile(join(root, 'AGENTS.md'), '# Agent instructions\n')
  await writeFile(join(root, 'CLAUDE.md'), '# Agent instructions\n')
  const before = await readFile(join(root, '.caselaw/answers.json'), 'utf8')
  const cli = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'upgrade'], { cwd: root, input: 'n\n', encoding: 'utf8', env: { ...process.env, CASELAW_HOME: join(root, 'personal-home') } })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /Aborted/)
  assert.equal(await readFile(join(root, '.caselaw/answers.json'), 'utf8'), before)
  await assert.rejects(readFile(join(root, 'docs/rules/proposed/stage-explicit-paths.md')))
})


test('POSITIVE CONTROL: precedent archival shares the active mutation lock and preserves archive conflicts', async () => {
  const {root, original} = await setup()
  const text = original.replace('**Origin:**', '**Precedent:** prior evidence\n\n**Origin:**')
  await writeFile(join(root, 'docs/rules/active/guard.md'), text)
  await withMutationLock(root, async () => {
    await assert.rejects(applyProposal({root, doc: {}, id: 'archive-precedent:guard'}), /mutation is in progress/)
  })
  await mkdir(join(root, 'docs/rules/precedent'), {recursive: true})
  await writeFile(join(root, 'docs/rules/precedent/guard.md'), 'Existing historical evidence')
  await assert.rejects(applyProposal({root, doc: {}, id: 'archive-precedent:guard'}), {code: 'EEXIST'})
  assert.equal(await readFile(join(root, 'docs/rules/active/guard.md'), 'utf8'), text)
  assert.equal(await readFile(join(root, 'docs/rules/precedent/guard.md'), 'utf8'), 'Existing historical evidence')
})
