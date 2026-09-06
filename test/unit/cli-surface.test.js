/**
 * The CLI surface is what the shipped strings say it is.
 *
 * The rule this file enforces: **a command is advertised only if it dispatches.**
 * The first public release documented `caselaw rule propose|ratify|adopt|promote`,
 * `caselaw gate test|baseline|promote` and a `--emit` flag on review — in the
 * README, in every candidate rule's footer, in the close-out template, in the
 * pointer block written into CLAUDE.md, and in the tool's own hint strings —
 * and every one of them exited 2 with "Unknown command". The logic existed;
 * the dispatch did not. Nothing noticed, because nothing checked.
 *
 * So the first test below reads every shipped file, extracts every command it
 * names, and asserts it against the dispatcher. The rest exercise the wiring
 * end to end through a real subprocess, the way a user meets it.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, appendFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname, relative } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { COMMANDS, KNOWN_FLAGS, USAGE, parseArgs } from '../../bin/cli.mjs'
import { buildArtifacts } from '../../src/generate/artifacts.js'
import { buildPlan, UNCHANGED } from '../../src/core/plan.js'
import * as answersStore from '../../src/core/answers.js'
import * as manifestStore from '../../src/core/manifest.js'
import * as gatesStore from '../../src/core/gates.js'
import { hash } from '../../src/core/text.js'
import { evaluate } from '../../runtime/gate.mjs'

const require = createRequire(import.meta.url)
const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** Run the CLI exactly as a user does: a subprocess with no terminal attached. */
function cli(args, { cwd = REPO, input = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.end(input)
  })
}

// ---------------------------------------------------------------------------
// Advertised surface
// ---------------------------------------------------------------------------

const SCAN_DIRS = ['src', 'templates', 'runtime', 'docs', 'bin']
const SCAN_FILES = ['README.md']
const TEXT_EXT = new Set(['.js', '.mjs', '.md', '.tmpl', '.json'])

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (TEXT_EXT.has(extname(e.name))) yield p
  }
}

/** Every `caselaw …` invocation a file advertises: inline code, and command lines in prose files. */
function advertised(text, file) {
  const out = []
  for (const m of text.matchAll(/`(?:npx )?caselaw ([^`\n]*)`/g)) out.push({ rest: m[1], file })
  if (/\.(md|tmpl)$/.test(file)) {
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:npx )?caselaw (.+)$/)
      if (m) out.push({ rest: m[1], file })
    }
  }
  return out
}

function assertDispatches({ rest, file }) {
  const tokens = rest.trim().split(/\s+/)
  const cmd = tokens[0]
  if (!/^[a-z][a-z-]*$/.test(cmd)) return // `caselaw 0.1.0`, `caselaw gate: …` — prose, not an invocation
  assert.ok(
    COMMANDS[cmd],
    `${file} advertises \`caselaw ${rest.trim()}\`, but "${cmd}" is not a command the CLI dispatches`,
  )
  const subs = COMMANDS[cmd].subs
  if (subs && tokens[1] && /^[a-z][a-z-]*$/.test(tokens[1])) {
    assert.ok(
      subs.includes(tokens[1]),
      `${file} advertises \`caselaw ${rest.trim()}\`, but "${cmd} ${tokens[1]}" is not a subcommand`,
    )
  }
  for (const t of tokens.slice(1)) {
    if (!t.startsWith('--')) continue
    const flag = t.slice(2).replace(/[=`\\"'].*$/, '')
    if (!flag) continue
    assert.ok(
      KNOWN_FLAGS.includes(flag),
      `${file} advertises \`caselaw ${rest.trim()}\`, but --${flag} is not an option the CLI parses`,
    )
  }
}

describe('the CLI surface is what the shipped strings say it is', () => {
  test('POSITIVE CONTROL: every command a shipped file advertises is one the CLI dispatches', async () => {
    const files = [...SCAN_FILES.map((f) => join(REPO, f))]
    for (const d of SCAN_DIRS) for await (const p of walk(join(REPO, d))) files.push(p)
    let seen = 0
    for (const abs of files) {
      const text = await readFile(abs, 'utf8')
      for (const hit of advertised(text, relative(REPO, abs))) {
        assertDispatches(hit)
        seen++
      }
    }
    assert.ok(seen >= 20, `expected the scan to find the advertised commands; found ${seen}`)
  })

  test('every usage line names a real command', () => {
    let seen = 0
    for (const line of USAGE.split('\n')) {
      const m = line.match(/^\s+caselaw (\S+)(?: (\S+))?/)
      if (!m) continue
      seen++
      if (m[1] === '--help') continue
      assert.ok(COMMANDS[m[1]], `usage names "caselaw ${m[1]}", which does not dispatch`)
      if (COMMANDS[m[1]].subs && m[2] && /^[a-z-]+$/.test(m[2])) {
        assert.ok(COMMANDS[m[1]].subs.includes(m[2]), `usage names "caselaw ${m[1]} ${m[2]}", which does not dispatch`)
      }
    }
    assert.ok(seen >= 17)
  })

  test('the dispatcher and the usage text agree on the command set', () => {
    for (const cmd of Object.keys(COMMANDS)) {
      assert.match(USAGE, new RegExp(`\\n\\s+caselaw ${cmd}( |\\n)`), `"${cmd}" dispatches but usage never mentions it`)
    }
  })

  test('--help reports the package version, not a hard-coded one', async () => {
    const { code, out } = await cli(['--help'])
    assert.equal(code, 0)
    assert.equal(out.split('\n')[0], `caselaw ${require('../../package.json').version}`)
  })

  test('POSITIVE CONTROL: an unknown option is an error, not a silent no-op', async () => {
    const r = await cli(['review', '--emit'])
    assert.equal(r.code, 2, 'a flag the CLI does not parse must not run the command as if the flag were absent')
    assert.match(r.out, /--emit/)
  })

  test('parseArgs: rule and gate take a subcommand and a name; valued options land in opt', () => {
    const a = parseArgs(['rule', 'adopt', 'trace-the-premise', '--origin', 'PR #418'])
    assert.equal(a.command, 'rule')
    assert.equal(a.sub, 'adopt')
    assert.equal(a.name, 'trace-the-premise')
    assert.equal(a.opt.origin, 'PR #418')
    assert.deepEqual(a.unknown, [])
    const b = parseArgs(['init', 'some/dir', '--with=decisions,glossary', '--reconfigure'])
    assert.equal(b.dir, 'some/dir')
    assert.deepEqual(b.with, ['decisions', 'glossary'])
    assert.equal(b.reconfigure, true)
    assert.deepEqual(parseArgs(['audit', '--bogus']).unknown, ['--bogus'])
    assert.deepEqual(parseArgs(['rule', 'adopt', 'x', '--origin']).unknown, ['--origin (missing its value)'])
  })
})

// ---------------------------------------------------------------------------
// The loop, end to end
// ---------------------------------------------------------------------------

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'caselaw-cli-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel, content) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const exists = async (rel) => { try { await stat(join(root, rel)); return true } catch { return false } }
const commit = () => {
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: root })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

const DETECTED = { agentConfig: { claudeMd: true }, commands: {}, deploySurface: [] }

/** Install the way `init` does, so the commands meet real artifacts — including the vendored runner. */
async function install() {
  await put('CLAUDE.md', '# Project\n\nMy own notes.\n')
  const doc = answersStore.emptyAnswers({ templateVersion: '1.0', project: { name: 'P' } })
  doc.generatedAt = '2026-08-13T00:00:00.000Z'
  Object.assign(doc.answers, {
    'authority.cannot': ['deploy'],
    'authority.triage': { deploy: 'chosen' },
    'authority.human_proof': 'Deploy by hand and watch the logs.',
    'authority.agent_reach': 'It can run the suite.',
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
      contentHash: e.kind === 'file' ? hash(e.nextText) : e.interiorHash,
    })
  }
  await manifestStore.save(root, manifest)
  await answersStore.save(root, doc)
  return doc
}

const ACTIVE_RULE = (name, origin) =>
  `# ${name}\n\n**Trigger:** any change under \`src/\`\n\n` +
  '**Rule:** Never leave console.log in shipped code. If one is found, replace it with the logger.\n\n' +
  `**Origin:** ${origin}\n\n**Enforcement:** memory\n\n**Ratified:** 2026-08-02 by t\n`

describe('caselaw rule — the loop, wired', () => {
  test('POSITIVE CONTROL: the README example adopts a candidate', async () => {
    await install()
    const r = await cli(['rule', 'adopt', 'trace-the-premise', '--origin', 'PR #418: built against a spec line that did not exist'], { cwd: root })
    assert.equal(r.code, 0, r.out + r.err)
    const text = await readFile(join(root, 'docs/rules/proposed/trace-the-premise.md'), 'utf8')
    assert.match(text, /\*\*Origin:\*\* PR #418/)
    assert.match(text, /\*\*Origin \(upstream\):\*\*/, "the candidate's own evidence is kept as context, demoted")
    assert.equal(await exists('docs/rules/candidates/trace-the-premise.md'), true, 'the candidate stays; adopting copies')
  })

  test('adopt without --origin refuses, and says why', async () => {
    await install()
    const r = await cli(['rule', 'adopt', 'trace-the-premise'], { cwd: root })
    assert.equal(r.code, 2)
    assert.match(r.out, /--origin/)
    assert.equal(await exists('docs/rules/proposed/trace-the-premise.md'), false)
  })

  test('propose with the fields as flags drafts without a terminal — an agent may do this', async () => {
    await install()
    const sha = commit()
    const r = await cli([
      'rule', 'propose', 'no-schema-edits-without-a-migration',
      '--trigger', 'any change to db/schema.sql',
      '--rule', 'Add a migration in the same commit. If none exists, stop and ask.',
      '--origin', `commit ${sha} — the schema drifted from the migrations`,
    ], { cwd: root })
    assert.equal(r.code, 0, r.out + r.err)
    const text = await readFile(join(root, 'docs/rules/proposed/no-schema-edits-without-a-migration.md'), 'utf8')
    assert.match(text, /\*\*Enforcement:\*\* memory/)
    assert.match(text, new RegExp(sha))
    assert.match(r.out, /caselaw rule ratify no-schema-edits-without-a-migration/, 'tells the reader what a human does next')
  })

  test('propose without the fields and without a terminal says which flags to pass', async () => {
    await install()
    const r = await cli(['rule', 'propose', 'something'], { cwd: root })
    assert.equal(r.code, 2)
    assert.match(r.out, /--trigger/)
    assert.equal(await exists('docs/rules/proposed/something.md'), false)
  })

  test('POSITIVE CONTROL: ratify refuses without a human at a terminal', async () => {
    await install()
    const sha = commit()
    await cli(['rule', 'propose', 'x-rule', '--trigger', 'any change to x', '--rule', 'Do x. If not, stop.', '--origin', `commit ${sha}`], { cwd: root })
    const r = await cli(['rule', 'ratify', 'x-rule', '--yes'], { cwd: root })
    assert.notEqual(r.code, 0, 'a pipe is not a person')
    assert.match(r.out, /human/i)
    assert.equal(await exists('docs/rules/proposed/x-rule.md'), true, 'the proposal is untouched')
    assert.equal(await exists('docs/rules/active/x-rule.md'), false)
  })

  test('reject refuses without a terminal too', async () => {
    await install()
    const sha = commit()
    await cli(['rule', 'propose', 'x-rule', '--trigger', 'any change to x', '--rule', 'Do x. If not, stop.', '--origin', `commit ${sha}`], { cwd: root })
    const r = await cli(['rule', 'reject', 'x-rule', '--yes'], { cwd: root })
    assert.notEqual(r.code, 0)
    assert.equal(await exists('docs/rules/proposed/x-rule.md'), true)
  })

  test('POSITIVE CONTROL: promote writes a warn gate the vendored runtime actually runs', async () => {
    await install()
    await put('docs/rules/active/no-console-log.md', ACTIVE_RULE('no-console-log', '2026-08-01 — the noisy-release incident.'))
    await put('src/app.js', 'console.log("hi")\n')
    const r = await cli([
      'rule', 'promote', 'no-console-log',
      '--kind', 'banned-content', '--paths', 'src/**/*.js', '--patterns', 'console.log',
      '--message', 'Use the logger.', '--yes',
    ], { cwd: root })
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.out, /src\/app\.js/, 'the baseline names the existing violation before anything is written')

    const config = await gatesStore.load(root)
    const gate = config.gates.find((g) => g.id === 'no-console-log')
    assert.ok(gate, 'the gate landed in .caselaw/gates.json')
    assert.equal(gate.severity, 'warn', 'born warn, never block')
    assert.equal(gate.kind, 'banned-content')
    assert.deepEqual(gate.paths, ['src/**/*.js'])
    assert.equal(gate.patterns[0].literal, 'console.log')
    assert.equal(gate.origin, 'docs/rules/active/no-console-log.md')
    assert.equal(gate.message, 'Use the logger.')

    const rule = await readFile(join(root, 'docs/rules/active/no-console-log.md'), 'utf8')
    assert.match(rule, /\*\*Enforcement:\*\* machine:no-console-log/)
    assert.match(rule, /\*\*Ratified:\*\* 2026-08-02 by t/, 'the rest of the rule survives byte for byte')

    // The proof that matters: the runtime reads exactly what promote wrote.
    const res = await evaluate({ root, mode: 'all', config, telemetry: false })
    assert.equal(res.fires.length, 1)
    assert.equal(res.fires[0].gate, 'no-console-log')
    assert.equal(res.fires[0].severity, 'warn')
  })

  test('promote --dry-run shows the gate and the baseline and writes nothing', async () => {
    await install()
    await put('docs/rules/active/no-console-log.md', ACTIVE_RULE('no-console-log', '2026-08-01 — an incident.'))
    await put('src/app.js', 'console.log("hi")\n')
    const r = await cli(['rule', 'promote', 'no-console-log', '--kind', 'banned-content', '--paths', 'src/**', '--patterns', 'console.log', '--dry-run'], { cwd: root })
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.out, /"kind": "banned-content"/)
    assert.match(r.out, /1 existing violation/)
    assert.equal((await gatesStore.load(root)).gates.length, 0)
    assert.match(await readFile(join(root, 'docs/rules/active/no-console-log.md'), 'utf8'), /\*\*Enforcement:\*\* memory/)
  })

  test('promote refuses a proposal, a missing rule, and a gate the runtime would drop', async () => {
    await install()
    const sha = commit()
    await cli(['rule', 'propose', 'still-proposed', '--trigger', 'any change to x', '--rule', 'Do x.', '--origin', `commit ${sha}`], { cwd: root })
    const a = await cli(['rule', 'promote', 'still-proposed', '--kind', 'path-scope', '--paths', 'gen/**', '--yes'], { cwd: root })
    assert.equal(a.code, 1)
    assert.match(a.out, /Ratify it first/)

    const b = await cli(['rule', 'promote', 'no-such-rule', '--kind', 'path-scope', '--paths', 'gen/**', '--yes'], { cwd: root })
    assert.equal(b.code, 1)
    assert.match(b.out, /No active rule/)

    await put('docs/rules/active/lint-clean.md', ACTIVE_RULE('lint-clean', '2026-08-01 — an incident.'))
    const c = await cli(['rule', 'promote', 'lint-clean', '--kind', 'shell', '--paths', 'src/**', '--command', 'npm run lint', '--yes'], { cwd: root })
    assert.notEqual(c.code, 0, 'a shell command with whitespace is dropped by the runtime at load; it must not be written')
    assert.equal((await gatesStore.load(root)).gates.length, 0)
  })

  test('promote without --kind and without a terminal names the flag and suggests a kind', async () => {
    await install()
    await put('docs/rules/active/no-console-log.md', ACTIVE_RULE('no-console-log', '2026-08-01 — an incident.'))
    const r = await cli(['rule', 'promote', 'no-console-log'], { cwd: root })
    assert.equal(r.code, 2)
    assert.match(r.out, /--kind/)
    assert.match(r.out, /Suggested for this rule: banned-content/)
  })
})

describe('caselaw gate', () => {
  async function promoted() {
    await install()
    await put('docs/rules/active/no-console-log.md', ACTIVE_RULE('no-console-log', '2026-08-01 — an incident.'))
    await put('src/app.js', 'console.log("hi")\n')
    const r = await cli(['rule', 'promote', 'no-console-log', '--kind', 'banned-content', '--paths', 'src/**/*.js', '--patterns', 'console.log', '--yes'], { cwd: root })
    assert.equal(r.code, 0, r.out + r.err)
  }

  test('gate test runs one gate through the vendored runner, and records nothing', async () => {
    await promoted()
    await rm(join(root, '.caselaw/gate-fires.jsonl'), { force: true })
    const r = await cli(['gate', 'test', 'no-console-log'], { cwd: root })
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.out, /warn\s+no-console-log\s+src\/app\.js/)
    assert.match(r.out, /1 fire/)
    assert.equal(await exists('.caselaw/gate-fires.jsonl'), false, 'a hand-run is a look, not evidence')
  })

  test('gate test names the gates that exist when the id is wrong', async () => {
    await promoted()
    const r = await cli(['gate', 'test', 'nope'], { cwd: root })
    assert.equal(r.code, 1)
    assert.match(r.out, /no-console-log/)
  })

  test('gate baseline runs every gate', async () => {
    await promoted()
    const r = await cli(['gate', 'baseline'], { cwd: root })
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.out, /1 gate/)
    assert.match(r.out, /no-console-log/)
  })

  test('POSITIVE CONTROL: gate promote refuses before the gate has earned it', async () => {
    await promoted()
    const r = await cli(['gate', 'promote', 'no-console-log'], { cwd: root })
    assert.equal(r.code, 1)
    assert.match(r.out, /needed/)
    assert.equal((await gatesStore.load(root)).gates[0].severity, 'warn')
  })

  test('gate promote succeeds once three hook-mode fires are on record', async () => {
    await promoted()
    const line = (mode) => JSON.stringify({ ts: '2026-09-01T00:00:00.000Z', gate: 'no-console-log', mode, path: 'src/app.js', severity: 'warn' }) + '\n'
    await appendFile(join(root, '.caselaw/gate-fires.jsonl'), line('pre') + line('post') + line('staged'))
    const r = await cli(['gate', 'promote', 'no-console-log'], { cwd: root })
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.out, /now blocks/)
    assert.equal((await gatesStore.load(root)).gates[0].severity, 'block')
  })

  test('gate promote --force works without the evidence, and says so', async () => {
    await promoted()
    const r = await cli(['gate', 'promote', 'no-console-log', '--force'], { cwd: root })
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.out, /forced/)
  })
})
