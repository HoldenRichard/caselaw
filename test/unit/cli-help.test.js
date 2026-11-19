/**
 * An agent drives this CLI by trial, so each trial must teach it the whole
 * shape (0.5.0). The 0.4.2 field test: `caselaw rule propose --help` printed
 * the global help, `rule promote` revealed `--paths` and then `--patterns` in
 * two failed runs, and a singular `--pattern` dumped the entire usage text.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { COMMANDS, KNOWN_FLAGS, parseArgs, USAGE } from '../../bin/cli.mjs'
import { HELP_KEYS, helpEntry, helpFlagNames, renderHelp, closestFlag, unknownOptionLine, canonicalFlag, REQUIRED_PROMOTE_FLAGS, missingPromoteFlags, promoteExample } from '../../src/commands/help.js'

const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))

function cli(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
    child.stdin.on('error', () => {})
    child.stdin.end('')
  })
}

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'caselaw-help-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const put = async (rel, text) => { await mkdir(join(root, rel, '..'), { recursive: true }); await writeFile(join(root, rel), text, 'utf8') }

/** `caselaw a "b c" d` as the argument list the parser sees. */
function tokens(line) {
  return [...line.replace(/^caselaw\s+/, '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
}

describe('every command and subcommand has its own help', () => {
  test('POSITIVE CONTROL: each command, and each subcommand of each, has an entry', () => {
    const missing = []
    for (const [cmd, spec] of Object.entries(COMMANDS)) {
      if (spec.subs) for (const s of spec.subs) { if (!helpEntry(cmd, s)) missing.push(`${cmd} ${s}`) }
      else if (!helpEntry(cmd)) missing.push(cmd)
    }
    assert.deepEqual(missing, [])
    for (const key of HELP_KEYS) {
      const [cmd, sub] = key.split(' ')
      assert.ok(COMMANDS[cmd], `help for "${key}" names a command that does not dispatch`)
      if (sub) assert.ok(COMMANDS[cmd].subs?.includes(sub), `help for "${key}" names a subcommand that does not dispatch`)
    }
  })

  test('advertise-only-what-dispatches: every flag the help names is one the parser takes', () => {
    for (const name of helpFlagNames()) assert.ok(KNOWN_FLAGS.includes(name), `help names --${name}, which the parser does not take`)
  })

  test('every example in the help parses clean: no unknown flag, the command and subcommand dispatch', () => {
    let seen = 0
    for (const key of HELP_KEYS) {
      for (const ex of helpEntry(...key.split(' ')).examples) {
        const args = parseArgs(tokens(ex))
        assert.deepEqual(args.unknown, [], `${ex}`)
        assert.ok(COMMANDS[args.command], ex)
        if (COMMANDS[args.command].subs) assert.ok(COMMANDS[args.command].subs.includes(args.sub), ex)
        seen++
      }
    }
    assert.ok(seen >= 30)
  })

  test('POSITIVE CONTROL: rule propose --help prints propose\'s usage, not the global help', async () => {
    const r = await cli(['rule', 'propose', '--help'], { cwd: root })
    assert.equal(r.code, 0)
    assert.match(r.out, /^caselaw rule propose <name>/)
    assert.match(r.out, /--trigger <text>.*\[required without a terminal\]/)
    assert.match(r.out, /\n  Example\n    caselaw rule propose lock-order --trigger/)
    assert.doesNotMatch(r.out, /caselaw check|Options\n/)
  })

  test('the help names the repository\'s actual doctrine directory', async () => {
    assert.match((await cli(['rule', 'propose', '--help'], { cwd: root })).out, /docs\/rules\/proposed\/<name>\.md/)
    await put('.caselaw/answers.json', JSON.stringify({ doctrineDir: 'governance' }))
    const r = await cli(['rule', 'ratify', '--help'], { cwd: root })
    assert.match(r.out, /governance\/rules\/proposed\/ into governance\/rules\/active\//)
    assert.doesNotMatch(r.out, /docs\/rules/)
  })

  test('a command with subcommands lists them when asked without one, and a wrong subcommand says so', async () => {
    const list = await cli(['gate', '--help'], { cwd: root })
    for (const s of COMMANDS.gate.subs) assert.match(list.out, new RegExp(`caselaw gate ${s}`))
    const bad = await cli(['rule', 'bogus', '--help'], { cwd: root })
    assert.equal(bad.code, 0)
    assert.match(bad.out, /Unknown subcommand "bogus"\. caselaw rule takes: propose,/)
  })

  test('required flags are marked and optional ones are not', () => {
    const text = renderHelp('rule', 'adopt', { dir: 'docs' })
    assert.match(text, /--origin <text>\s+the incident in THIS project[^\n]*\[required\]/)
    assert.doesNotMatch(renderHelp('rule', 'propose', { dir: 'docs' }).split('\n').find((l) => l.includes('--enforcement')), /\[/)
  })

  test('the global help points at the per-command help, and a bare --help is still the global help', async () => {
    assert.match(USAGE, /--help for its own flags/)
    const r = await cli(['--help'], { cwd: root })
    assert.equal(r.code, 0)
    assert.match(r.out, /caselaw rule promote <name>/)
  })
})

describe('flag spellings an agent reaches for', () => {
  test('POSITIVE CONTROL: --pattern is --patterns, --path is --paths, --arg is --args, _ is -', () => {
    const a = parseArgs(['rule', 'promote', 'x', '--pattern', 'console.log', '--path', 'src/**', '--arg', 'a', '--doctrine_dir', 'gov'])
    assert.deepEqual(a.unknown, [])
    assert.equal(a.opt.patterns, 'console.log')
    assert.equal(a.opt.paths, 'src/**')
    assert.equal(a.opt.args, 'a')
    assert.equal(a.opt['doctrine-dir'], 'gov')
    assert.equal(canonicalFlag('patterns'), 'patterns')
  })

  test('the = form takes the alias too', () => {
    assert.equal(parseArgs(['rule', 'promote', 'x', '--pattern=foo']).opt.patterns, 'foo')
  })

  test('POSITIVE CONTROL: a flag that is not one is still rejected', () => {
    assert.deepEqual(parseArgs(['rule', 'promote', 'x', '--patern-x', 'a']).unknown, ['--patern-x'])
  })
})

describe('a mistake is one line that names the nearest flag', () => {
  test('POSITIVE CONTROL: a typo prints one line, with the closest flag and where the flags are listed, not the usage', async () => {
    const r = await cli(['rule', 'promote', 'x', '--pattrens', 'a'], { cwd: root })
    assert.equal(r.code, 2)
    assert.equal(r.out.trim().split('\n').length, 1)
    assert.match(r.out, /Unknown option "--pattrens" \(did you mean --patterns\?\)\. Flags: caselaw rule promote --help/)
  })

  test('a flag with no value says so; one with no near match names none', () => {
    assert.equal(unknownOptionLine(['--origin (missing its value)'], { known: KNOWN_FLAGS, command: 'rule', sub: 'adopt' }), '"--origin" needs a value. Flags: caselaw rule adopt --help')
    assert.equal(unknownOptionLine(['--emit'], { known: KNOWN_FLAGS, command: 'review' }), 'Unknown option "--emit". Flags: caselaw review --help')
  })

  test('closestFlag prefers a flag the command takes, and finds a prefix', () => {
    assert.equal(closestFlag('--mesage', KNOWN_FLAGS, ['message']), 'message')
    assert.equal(closestFlag('--doctrine', KNOWN_FLAGS), 'doctrine-dir')
    assert.equal(closestFlag('--zzzzzz', KNOWN_FLAGS), null)
  })
})

describe('rule promote reports every missing flag together', () => {
  const RULE = '# no-console-log\n\n**Trigger:** any change under `src/`\n\n**Rule:** Never leave console.log in shipped code; replace it with the logger.\n\n**Origin:** 2026-08-01, an incident.\n\n**Enforcement:** memory\n\n**Ratified:** 2026-08-02 by t\n'

  test('POSITIVE CONTROL: banned-content with neither --paths nor --patterns names both, once, with a command that works', async () => {
    await put('docs/rules/active/no-console-log.md', RULE)
    const r = await cli(['rule', 'promote', 'no-console-log', '--kind', 'banned-content'], { cwd: root })
    assert.equal(r.code, 2)
    assert.match(r.out, /still needs --paths and --patterns/)
    assert.equal((r.out.match(/--patterns/g) || []).length >= 2, true)
    const example = r.out.split('\n').find((l) => l.trim().startsWith('caselaw rule promote'))
    assert.ok(example, 'an example command is printed')
    assert.deepEqual(parseArgs(tokens(example)).unknown, [])
  })

  test('only the flags actually missing are named', async () => {
    await put('docs/rules/active/no-console-log.md', RULE)
    const r = await cli(['rule', 'promote', 'no-console-log', '--kind', 'banned-content', '--paths', 'src/**'], { cwd: root })
    assert.match(r.out, /still needs --patterns \(/)
    assert.doesNotMatch(r.out, /still needs --paths/)
  })

  test('the singular --pattern satisfies --patterns', async () => {
    await put('docs/rules/active/no-console-log.md', RULE)
    const r = await cli(['rule', 'promote', 'no-console-log', '--kind', 'banned-content', '--paths', 'src/**', '--pattern', 'console.log'], { cwd: root })
    assert.doesNotMatch(r.out, /still needs/)
  })

  test('without --kind, the example for the suggested kind is printed', async () => {
    await put('docs/rules/active/no-console-log.md', RULE)
    const r = await cli(['rule', 'promote', 'no-console-log'], { cwd: root })
    assert.equal(r.code, 2)
    assert.match(r.out, /Each kind needs its own flags, all at once, for example:\n    caselaw rule promote no-console-log --kind /)
  })

  test('every kind has required flags and an example that supplies exactly them', () => {
    for (const [kind, required] of Object.entries(REQUIRED_PROMOTE_FLAGS)) {
      const example = parseArgs(tokens(promoteExample(kind, 'r')))
      for (const flag of required) assert.ok(example.opt[flag], `the ${kind} example lacks --${flag}`)
      assert.ok(missingPromoteFlags(kind, {}, 'r'), kind)
      assert.equal(missingPromoteFlags(kind, Object.fromEntries(required.map((k) => [k, 'x'])), 'r'), null, kind)
    }
  })
})
