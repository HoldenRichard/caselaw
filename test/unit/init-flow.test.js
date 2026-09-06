/**
 * Installing into a stranger's repository, the way a maintainer meets it.
 *
 * Three foreign repositories were installed into, checked, upgraded and
 * ejected by agents reading nothing but the tool's own output. Every test
 * here is a moment one of them stopped: the second `init` refused because the
 * first one's files made the tree "dirty"; free text was cut at its first
 * comma; the doctrine landed in a docs/ that typedoc deletes on every build;
 * the project was titled after the clone directory; `check` said "committed"
 * about files nothing had committed; `--strict` recommended a remedy the
 * previous step had proved would not work; eject deleted two files it never
 * listed and left five empty directories.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, appendFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))

function cli(args, { cwd, input = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.end(input)
  })
}

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'caselaw-init-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root })
  await writeFile(join(root, 'README.md'), '# A project\n', 'utf8')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel, content) => { await mkdir(join(root, rel, '..'), { recursive: true }); await writeFile(join(root, rel), content, 'utf8') }
const commit = () => { execFileSync('git', ['add', '-A'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'x'], { cwd: root }) }
const exists = async (rel) => { try { await stat(join(root, rel)); return true } catch { return false } }

// A repo with no detected language offers the same seven boundary options in
// the same order; "4" is "run the full test suite". The interview asks:
// what the agent cannot do, then a triage per selection, human proof, agent
// reach — and a re-test cadence only when something was marked untested.
const ANSWERS = '4\np\nTap through it on a phone.\nRun the suite.\n'

describe('init, twice', () => {
  test('POSITIVE CONTROL: a second init is not refused over the first one\'s own uncommitted files', async () => {
    commit()
    const first = await cli(['init', '--yes'], { cwd: root, input: ANSWERS })
    assert.equal(first.code, 0, first.out + first.err)
    assert.match(first.out, /Commit these files/, 'init must tell the user what to do next')
    const second = await cli(['init', '--yes'], { cwd: root, input: '' })
    assert.equal(second.code, 0, `the tree is dirty only with caselaw's own install: ${second.out}`)
    assert.match(second.out, /Already up to date/)
  })

  test('foreign uncommitted changes are still refused, and named', async () => {
    commit()
    await put('src/x.js', 'x\n')
    const r = await cli(['init', '--yes'], { cwd: root, input: ANSWERS })
    assert.equal(r.code, 1)
    assert.match(r.out, /not caselaw's/)
    assert.match(r.out, /src\/x\.js/)
  })

  test('the project is named from its manifest, not the directory it was cloned into', async () => {
    await put('package.json', JSON.stringify({ name: '@acme/widget', version: '1.0.0', scripts: { test: 'node --test' } }))
    commit()
    const r = await cli(['init', '--yes'], { cwd: root, input: ANSWERS })
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.out, /project\s+widget/)
    assert.match(await readFile(join(root, 'docs/authority-split.md'), 'utf8'), /^# Authority split — widget/)
    assert.equal(JSON.parse(await readFile(join(root, '.caselaw/answers.json'), 'utf8')).project.name, 'widget')
  })
})

describe('what the interview accepts', () => {
  test('POSITIVE CONTROL: free text after + may contain commas', async () => {
    commit()
    const sentence = 'pair the bridge with the Home app on a real iPhone, then confirm the accessory responds'
    const r = await cli(['init', '--yes'], { cwd: root, input: `+${sentence}\np\nTap it.\nRun it.\n` })
    assert.equal(r.code, 0, r.out + r.err)
    const answers = JSON.parse(await readFile(join(root, '.caselaw/answers.json'), 'utf8'))
    assert.deepEqual(answers.answers['authority.cannot'], [sentence], 'the whole sentence, not the part before the first comma')
    assert.deepEqual(answers.unanswered, [])
    assert.match(await readFile(join(root, 'docs/authority-split.md'), 'utf8'), new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

describe('where the doctrine may land', () => {
  test('POSITIVE CONTROL: doctrine is not written into a docs/ that typedoc deletes on every build', async () => {
    await put('typedoc.json', JSON.stringify({ out: 'docs', entryPoints: ['src/index.ts'] }))
    commit()
    const r = await cli(['init', '--yes'], { cwd: root, input: ANSWERS })
    assert.equal(r.code, 1, 'writing into a build output directory must be refused without --force')
    assert.match(r.out, /typedoc/)
    assert.match(r.out, /--force/)
    assert.equal(await exists('docs/authority-split.md'), false)
    const forced = await cli(['init', '--yes', '--force'], { cwd: root, input: ANSWERS })
    assert.equal(forced.code, 0, forced.out + forced.err)
  })

  test('nor into a docs/ that mkdocs publishes', async () => {
    await put('mkdocs.yml', 'site_name: x\nsite_dir: server/docs\n')
    commit()
    const r = await cli(['init', '--yes'], { cwd: root, input: ANSWERS })
    assert.equal(r.code, 1)
    assert.match(r.out, /mkdocs/)
  })

  test('a generated file that .gitignore would keep out of the repo is called out', async () => {
    await put('.gitignore', '.claude/*\n')
    commit()
    const r = await cli(['init', '--yes'], { cwd: root, input: ANSWERS })
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.out, /\.claude\/commands\/close-out\.md is ignored by \.gitignore/)
  })
})

describe('check, honestly', () => {
  test('POSITIVE CONTROL: check does not say "committed", and --strict names a remedy that works', async () => {
    commit()
    await cli(['init', '--yes'], { cwd: root, input: ANSWERS })
    const clean = await cli(['check'], { cwd: root, input: '' })
    assert.equal(clean.code, 0)
    assert.doesNotMatch(clean.out, /committed docs/, 'nothing is committed yet; check never looked')
    assert.match(clean.out, /generated docs/)
    await appendFile(join(root, 'docs/authority-split.md'), '\nmy own line\n')
    const strict = await cli(['check', '--strict'], { cwd: root, input: '' })
    assert.equal(strict.code, 1)
    assert.doesNotMatch(strict.out, /Run `caselaw upgrade` to bring/, 'upgrade leaves an edited file alone; the previous release recommended it anyway')
    assert.match(strict.out, /upgrade --force/)
  })
})

describe('eject, completely', () => {
  test('POSITIVE CONTROL: eject lists every file it removes, counts them, and prunes the directories it empties', async () => {
    commit()
    await cli(['init', '--yes'], { cwd: root, input: ANSWERS })
    const r = await cli(['eject', '--yes'], { cwd: root, input: '' })
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.out, /DELETE {2}\.caselaw\/answers\.json/, 'answers.json is the file every doc calls the source of truth; its deletion is announced')
    assert.match(r.out, /DELETE {2}\.caselaw\/manifest\.json/)
    assert.match(r.out, /DELETE {2}CLAUDE\.md {2}\(it holds nothing but caselaw's block\)/, 'a file that will go is not promised to stay')
    assert.match(r.out, /pruned \d+ empty director/)
    assert.equal(await exists('.caselaw'), false, 'no empty .caselaw/ left behind')
    assert.equal(await exists('.claude'), false, 'no empty .claude/ left behind')
    assert.equal(await exists('docs/authority-split.md'), true, 'the doctrine stays')
    const header = r.out.match(/Eject — (\d+) file\(s\) removed, (\d+) block\(s\) stripped/)
    const result = r.out.match(/Removed (\d+), stripped (\d+)/)
    assert.ok(header && result)
    assert.equal(header[1], result[1], 'the plan and the result agree on how many files went')
    assert.equal(header[2], result[2])
  })
})
