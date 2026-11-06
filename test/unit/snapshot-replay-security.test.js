import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { validateSnapshotFiles, saveIncident } from '../../src/core/incidents.js'
import { synthesizeMachineGate, certifyMachineGate } from '../../src/core/gates.js'
import { cmdGate } from '../../src/commands/gate.js'

const roots = []
async function scratch() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-replay-security-')))
  roots.push(root)
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function put(root, path, content) {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), content)
}
const gate = { id: 'guard', kind: 'banned-content', severity: 'warn', origin: 'docs/rules/active/guard.md', paths: ['src/a.js'], patterns: ['forbidden'] }
const rule = { name: 'guard', rule: 'Never use `forbidden`.' }
const pair = (id = 'case-a', path = 'src/a.js') => ({
  id, rule: 'guard',
  positiveControl: { diff: '+forbidden', files: { [path]: 'forbidden' } },
  negativeControl: { diff: '+safe', files: { [path]: 'safe' } },
})
async function cliFixture(root, runner) {
  const original = '# guard\n\n**Trigger:** edit source\n\n**Rule:** Never use `forbidden`.\n\n**Origin:** scratch\n\n**Enforcement:** memory\n\n**Ratified:** human\n'
  await put(root, 'docs/rules/active/guard.md', original)
  await saveIncident(root, pair())
  if (runner !== undefined) await put(root, '.caselaw/bin/gate.mjs', runner)
  return original
}

// Include nested spellings: Git metadata must never be materialized at any depth.
test('snapshot validation rejects Git metadata, case folds, NTFS aliases and streams', () => {
  for (const path of [
    '.git/config', '.GIT/config', 'nested/.Git/HEAD', '.git./config', '.git /config',
    'nested/.GIT. /config', 'git~1/config', 'nested/GIT~2/HEAD', '.git:stream',
    '.git::$INDEX_ALLOCATION/config', 'src/a.js:stream', '.g\u200cit/config', 'src/a\0.js',
  ]) {
    assert.throws(() => validateSnapshotFiles({ [path]: 'text' }), { code: 'INVALID_SNAPSHOT' }, path)
  }
  assert.deepEqual(Object.keys(validateSnapshotFiles({ '.github/workflows/ci.yml': 'safe', 'src/git.js': null })), ['.github/workflows/ci.yml', 'src/git.js'])
})

test('forged Git metadata is rejected before snapshot replay can execute fsmonitor', async () => {
  const root = await scratch()
  const marker = join(root, 'executed')
  const files = {
    '.git/HEAD': 'ref: refs/heads/main\n', '.git/objects/placeholder': '', '.git/refs/heads/placeholder': '',
    '.git/config': `[core]\n repositoryformatversion = 0\n bare = false\n fsmonitor = "echo executed > ${marker}"\n`,
  }
  const fixture = pair()
  Object.assign(fixture.positiveControl.files, files)
  Object.assign(fixture.negativeControl.files, files)
  const result = await certifyMachineGate(gate, [fixture])
  assert.equal(result.ok, false)
  assert.match(result.reason, /Unsafe/)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('synthesis and certification reject incomplete combined scope before replay', async () => {
  const fixtures = [pair(), pair('case-b', 'src/b.js')]
  const synthesis = synthesizeMachineGate({ rule, incidentFixtures: fixtures })
  assert.equal(synthesis.success, false)
  assert.match(synthesis.reason, /missing snapshot path.*src\/b.js.*Re-capture/)
  const replay = await certifyMachineGate({ ...gate, paths: ['src/a.js', 'src/b.js'] }, fixtures)
  assert.equal(replay.ok, false)
  assert.match(replay.reason, /combined gate scope/)
})

test('explicit null snapshots cover absent union paths and replay successfully', async () => {
  const fixtures = [pair(), pair('case-b', 'src/b.js')]
  for (const fixture of fixtures) {
    for (const control of ['positiveControl', 'negativeControl']) {
      for (const path of ['src/a.js', 'src/b.js']) {
        if (!Object.hasOwn(fixture[control].files, path)) fixture[control].files[path] = null
      }
    }
  }
  const synthesis = synthesizeMachineGate({ rule, incidentFixtures: fixtures })
  assert.equal(synthesis.success, true)
  assert.deepEqual(await certifyMachineGate(synthesis.gate, fixtures), { ok: true, fixtureCount: 2 })
})

test('unchanged forbidden content in a combined negative snapshot prevents certification', async () => {
  const fixture = pair()
  fixture.positiveControl.files['src/b.js'] = 'forbidden'
  fixture.negativeControl.files['src/b.js'] = 'forbidden'
  assert.equal(synthesizeMachineGate({ rule, incidentFixtures: [fixture] }).success, false)
  const result = await certifyMachineGate({ ...gate, paths: ['src/a.js', 'src/b.js'] }, [fixture])
  assert.equal(result.ok, false)
  assert.match(result.reason, /negativeControl/)
})

test('explicitly scoped gate still must catch the bad snapshot', async () => {
  const result = await certifyMachineGate({ ...gate, patterns: ['missing-pattern'] }, [pair()])
  assert.equal(result.ok, false)
  assert.match(result.reason, /Runtime rejected case-a positiveControl/)
})

test('certification refuses broad glob scope even if recorded files happen to match', async () => {
  for (const paths of [['src/*.js'], ['**/*'], ['src/a?.js'], ['src/{a,b}.js']]) {
    const result = await certifyMachineGate({ ...gate, paths }, [pair()])
    assert.equal(result.ok, false)
    assert.match(result.reason, /exact file paths/)
  }
})

test('CLI refuses missing installed runtime and preserves enforcement', async () => {
  const root = await scratch()
  const original = await cliFixture(root)
  const lines = []
  assert.equal(await cmdGate({ sub: 'synthesize', name: 'guard', yes: true }, { root, say: line => lines.push(line) }), 1)
  assert.match(lines.join('\n'), /No vendored runner/)
  assert.equal(await readFile(join(root, 'docs/rules/active/guard.md'), 'utf8'), original)
  await assert.rejects(readFile(join(root, '.caselaw/gates.json')), { code: 'ENOENT' })
})

test('CLI refuses installed module without evaluate instead of falling back', async () => {
  const root = await scratch()
  const original = await cliFixture(root, 'export const version = 1\n')
  const lines = []
  assert.equal(await cmdGate({ sub: 'synthesize', name: 'guard', yes: true }, { root, say: line => lines.push(line) }), 1)
  assert.match(lines.join('\n'), /must export evaluate/)
  assert.equal(await readFile(join(root, 'docs/rules/active/guard.md'), 'utf8'), original)
  await assert.rejects(readFile(join(root, '.caselaw/gates.json')), { code: 'ENOENT' })
})

test('CLI replays installed evaluator and limits its claim to recorded snapshots', async () => {
  const root = await scratch()
  const runtime = await readFile(new URL('../../runtime/gate.mjs', import.meta.url))
  await cliFixture(root, runtime)
  const lines = []
  assert.equal(await cmdGate({ sub: 'synthesize', name: 'guard', yes: true }, { root, say: line => lines.push(line) }), 0)
  assert.match(lines.join('\n'), /installed runtime matched 1 recorded snapshot pair\(s\) only/)
  assert.match(await readFile(join(root, 'docs/rules/active/guard.md'), 'utf8'), /machine:guard/)
})

test('replay child clears inherited Git overrides, global hooks and ancestor discovery', async () => {
  const root = await scratch()
  const hostileConfig = join(root, 'global-config')
  await writeFile(hostileConfig, '[core]\n fsmonitor = hostile-command\n hooksPath = /hostile-hooks\n')
  const runner = join(root, 'inspect.mjs')
  await writeFile(runner, `
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { evaluate as actualEvaluate } from ${JSON.stringify(new URL('../../runtime/gate.mjs', import.meta.url).href)};
export async function evaluateWrapper(options) {
  assert.equal(process.env.GIT_DIR, undefined);
  assert.equal(process.env.GIT_WORK_TREE, undefined);
  assert.equal(process.env.GIT_CONFIG_COUNT, '2');
  assert.equal(execFileSync('git', ['config', '--get', 'core.fsmonitor'], {encoding:'utf8'}).trim(), 'false');
  assert.equal(execFileSync('git', ['config', '--get', 'core.hooksPath'], {encoding:'utf8'}).trim(), options.root + '/.git/hooks');
  assert.notEqual(spawnSync('git', ['config', '--global', '--get', 'core.fsmonitor']).status, 0);
  assert.notEqual(spawnSync('git', ['rev-parse', '--show-toplevel']).status, 0);
  assert.deepEqual(options.targets, ['src/a.js']);
  return actualEvaluate(options);
}
export { evaluateWrapper as evaluate };
`)
  // Inject hostile environment only into a separate parent process, never this
  // test worker's process.env, so parallel tests cannot observe temporary state.
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
import assert from 'node:assert/strict';
import { certifyMachineGate } from ${JSON.stringify(new URL('../../src/core/gates.js', import.meta.url).href)};
const before = {...process.env};
assert.deepEqual(await certifyMachineGate(${JSON.stringify(gate)}, [${JSON.stringify(pair())}], ${JSON.stringify(runner)}), {ok:true, fixtureCount:1});
assert.ok(JSON.stringify({...process.env}) === JSON.stringify(before), 'Parent environment changed');
`], {
    encoding: 'utf8', env: {
      ...process.env, GIT_CONFIG_GLOBAL: hostileConfig, GIT_DIR: '/hostile-git', GIT_WORK_TREE: '/hostile-tree',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'hostile-command',
    },
  })
  assert.equal(child.status, 0, child.stderr)
})
