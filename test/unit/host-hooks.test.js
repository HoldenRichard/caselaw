/**
 * The gate runner for the hosts that are not Claude Code (0.5).
 *
 * On fresh repos only AGENTS.md was installed and the only live hook was
 * Claude Code's; `--host generic` answered `allow` to `git push origin main`.
 * Each host below sends its own payload (Codex: apply_patch text in
 * tool_input.command; Cursor: {command} and {file_path, edits}; Gemini CLI:
 * run_shell_command, write_file, replace) and each is run the way the
 * installed hook runs it: a real subprocess, exit 2 to block.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXIT, parseApplyPatch, outwardAction } from '../../runtime/gate.mjs'

const RUNNER = fileURLToPath(new URL('../../runtime/gate.mjs', import.meta.url))

function run(argv, { input = '', cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...argv], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

const BLOCK_TOKEN = 'FORBIDDEN_BLOCK'
const gate = (over) => ({
  id: 'g', kind: 'banned-content', severity: 'block', paths: ['**/*'],
  origin: 'docs/rules/active/fixture.md', message: 'Remove it.',
  patterns: [{ literal: BLOCK_TOKEN, label: 'block token' }],
  ...over,
})

/** A throwaway install with these gates and (optionally) these defaults accepted. */
async function withInstall(gates, { defaults = null } = {}, fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-host-')))
  try {
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await writeFile(join(root, '.caselaw/gates.json'), JSON.stringify({ version: 1, gates }), 'utf8')
    if (defaults) await writeFile(join(root, '.caselaw/answers.json'), JSON.stringify({ schemaVersion: 1, answers: { 'harness.defaults': defaults } }), 'utf8')
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const invoke = (root, host, mode, data) =>
  run(['--host', host, '--mode', mode, '--no-telemetry'], { cwd: root, input: JSON.stringify({ cwd: root, ...data }) })

const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
const hookJson = (out) => JSON.parse(out.trim().split('\n').pop())

describe('Codex', () => {
  test('POSITIVE CONTROL: an apply_patch that adds a banned file is blocked, exit 2, reason on stderr', async () => {
    await withInstall([gate({ paths: ['src/**/*.js'] })], {}, async (root) => {
      const r = await invoke(root, 'codex', 'pre', {
        hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
        tool_input: { command: patch('*** Add File: src/a.js', `+const x = "${BLOCK_TOKEN}"`) },
      })
      assert.equal(r.code, EXIT.PRE_BLOCK, r.err)
      assert.match(r.err, /blocked this change/)
      assert.match(r.err, /src\/a\.js/)
    })
  })

  test('an update hunk is checked on its added lines, and a clean patch passes', async () => {
    await withInstall([gate({ paths: ['src/**/*.js'] })], {}, async (root) => {
      const bad = patch('*** Update File: src/a.js', '@@ function f()', ' keep', '-old', `+${BLOCK_TOKEN}`)
      const good = patch('*** Update File: src/a.js', '@@', '-old', '+new')
      const call = (command) => invoke(root, 'codex', 'pre', { tool_name: 'apply_patch', tool_input: { command } })
      assert.equal((await call(bad)).code, EXIT.PRE_BLOCK)
      assert.equal((await call(good)).code, EXIT.OK)
    })
  })

  test('a patch that only deletes a file still reaches a path-scope gate; a rename checks the new path', async () => {
    const scope = { id: 'frozen', kind: 'path-scope', severity: 'block', paths: ['frozen/**'], origin: 'docs/rules/active/fixture.md', message: 'Frozen.' }
    await withInstall([scope], {}, async (root) => {
      const del = await invoke(root, 'codex', 'pre', { tool_name: 'apply_patch', tool_input: { command: patch('*** Delete File: frozen/a.txt') } })
      assert.equal(del.code, EXIT.PRE_BLOCK, del.err)
      const mv = await invoke(root, 'codex', 'pre', { tool_name: 'apply_patch', tool_input: { command: patch('*** Update File: src/a.txt', '*** Move to: frozen/a.txt', '@@', '+x') } })
      assert.equal(mv.code, EXIT.PRE_BLOCK, mv.err)
    })
  })

  test('PostToolUse apply_patch re-reads the file from disk: a banned token that landed is reported, not lost', async () => {
    await withInstall([gate({ paths: ['src/**/*.js'] })], {}, async (root) => {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src/a.js'), `x = "${BLOCK_TOKEN}"\n`)
      const r = await invoke(root, 'codex', 'post', { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: patch('*** Update File: src/a.js', '@@', `+x = "${BLOCK_TOKEN}"`) } })
      assert.equal(r.code, EXIT.OK)
      assert.equal(hookJson(r.out).decision, 'block')
      assert.match(hookJson(r.out).reason, /blocked this change/)
    })
  })

  test('Bash goes to the command gates; a command gate match blocks', async () => {
    const guard = { id: 'no-sweep', kind: 'command', severity: 'block', origin: 'docs/rules/active/fixture.md', message: 'No.', patterns: [{ literal: 'rm -rf /', label: 'rm -rf /' }] }
    await withInstall([guard], {}, async (root) => {
      assert.equal((await invoke(root, 'codex', 'pre', { tool_name: 'Bash', tool_input: { command: 'rm -rf / --no-preserve-root' } })).code, EXIT.PRE_BLOCK)
      assert.equal((await invoke(root, 'codex', 'pre', { tool_name: 'Bash', tool_input: { command: 'ls' } })).code, EXIT.OK)
    })
  })

  test('unknown shapes degrade to unchecked: exit 0, a stderr note, never a crash or a block', async () => {
    await withInstall([gate()], {}, async (root) => {
      for (const data of [
        { tool_name: 'mcp__something', tool_input: { x: 1 } },
        { tool_name: 'apply_patch', tool_input: { command: 'not a patch at all' } },
        { tool_name: 'apply_patch', tool_input: 'a string' },
        { tool_name: 'Bash', tool_input: {} },
        {},
      ]) {
        const r = await invoke(root, 'codex', 'pre', data)
        assert.equal(r.code, EXIT.OK, JSON.stringify(data) + r.err)
        assert.match(r.err, /nothing (was checked|to check)/)
      }
      const garbage = await run(['--host', 'codex', '--mode', 'pre'], { cwd: root, input: '{not json' })
      assert.equal(garbage.code, EXIT.OK)
      assert.match(garbage.err, /nothing was checked/)
    })
  })

  test('parseApplyPatch: whole file for Add, fragments for Update, path only for Delete', () => {
    const files = parseApplyPatch(patch('*** Add File: a.txt', '+one', '+two', '*** Update File: b.txt', '@@', '+x', '@@', '+y', '*** Delete File: c.txt'))
    assert.deepEqual(files, [
      { path: 'a.txt', texts: ['one\ntwo'], whole: true },
      { path: 'b.txt', texts: ['x', 'y'], whole: false },
      { path: 'c.txt', texts: [], whole: false },
    ])
  })
})

describe('Cursor', () => {
  test('POSITIVE CONTROL: beforeShellExecution {command, cwd} reaches the command gates and blocks with exit 2', async () => {
    const guard = { id: 'no-sweep', kind: 'command', severity: 'block', origin: 'docs/rules/active/fixture.md', message: 'No.', patterns: [{ literal: 'git add -A', label: 'git add -A' }] }
    await withInstall([guard], {}, async (root) => {
      const r = await run(['--host', 'cursor', '--mode', 'pre', '--no-telemetry'], { cwd: root, input: JSON.stringify({ command: 'git add -A', cwd: root }) })
      assert.equal(r.code, EXIT.PRE_BLOCK, r.err)
      assert.match(r.err, /no-sweep/)
      const ok = await run(['--host', 'cursor', '--mode', 'pre', '--no-telemetry'], { cwd: root, input: JSON.stringify({ command: 'git add a.txt', cwd: root }) })
      assert.equal(ok.code, EXIT.OK)
      assert.equal(ok.out, '', 'an allow is empty stdout')
    })
  })

  test('afterFileEdit {file_path, edits} is checked from disk, and reported on stderr (it cannot take the edit back)', async () => {
    await withInstall([gate({ paths: ['src/**/*.js'] })], {}, async (root) => {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src/a.js'), `x = "${BLOCK_TOKEN}"\n`)
      const r = await run(['--host', 'cursor', '--mode', 'post', '--no-telemetry'], {
        cwd: root, input: JSON.stringify({ hook_event_name: 'afterFileEdit', file_path: join(root, 'src/a.js'), edits: [{ old_string: 'a', new_string: BLOCK_TOKEN }] }),
      })
      assert.equal(r.code, EXIT.OK)
      assert.match(r.err, /blocked this change/)
      assert.equal(r.out, '')
    })
  })

  test('unknown shapes degrade to unchecked', async () => {
    await withInstall([gate()], {}, async (root) => {
      const r = await run(['--host', 'cursor', '--mode', 'pre'], { cwd: root, input: JSON.stringify({ something: 'else' }) })
      assert.equal(r.code, EXIT.OK)
      assert.match(r.err, /nothing was checked/)
    })
  })
})

describe('Gemini CLI', () => {
  test('POSITIVE CONTROL: write_file and replace are blocked on the proposed text, exit 2', async () => {
    await withInstall([gate({ paths: ['src/**/*.js'] })], {}, async (root) => {
      const write = await invoke(root, 'gemini', 'pre', { hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: join(root, 'src/a.js'), content: BLOCK_TOKEN } })
      assert.equal(write.code, EXIT.PRE_BLOCK, write.err)
      const replace = await invoke(root, 'gemini', 'pre', { tool_name: 'replace', tool_input: { file_path: join(root, 'src/a.js'), old_string: 'a', new_string: BLOCK_TOKEN } })
      assert.equal(replace.code, EXIT.PRE_BLOCK, replace.err)
      const clean = await invoke(root, 'gemini', 'pre', { tool_name: 'write_file', tool_input: { file_path: join(root, 'src/a.js'), content: 'fine' } })
      assert.equal(clean.code, EXIT.OK)
    })
  })

  test('stdout is JSON or empty: a warn is a systemMessage object, never prose', async () => {
    const warn = gate({ severity: 'warn' })
    await withInstall([warn], {}, async (root) => {
      const r = await invoke(root, 'gemini', 'pre', { tool_name: 'write_file', tool_input: { file_path: join(root, 'a.js'), content: BLOCK_TOKEN } })
      assert.equal(r.code, EXIT.OK)
      assert.match(hookJson(r.out).systemMessage, /warn g/)
      const quiet = await invoke(root, 'gemini', 'pre', { tool_name: 'write_file', tool_input: { file_path: join(root, 'a.js'), content: 'fine' } })
      assert.equal(quiet.out, '')
    })
  })

  test('a tool the gate does not check is unchecked, not guessed at', async () => {
    await withInstall([gate()], {}, async (root) => {
      const r = await invoke(root, 'gemini', 'pre', { tool_name: 'read_file', tool_input: { file_path: join(root, 'a.js') } })
      assert.equal(r.code, EXIT.OK)
      assert.match(r.err, /not one the gate checks/)
    })
  })
})

describe('D5: outward actions ask or are noted, never blocked', () => {
  const D5 = ['D1', 'D5']

  test('POSITIVE CONTROL: Claude Code gets permissionDecision "ask" for git push when D5 is accepted', async () => {
    await withInstall([], { defaults: D5 }, async (root) => {
      const r = await invoke(root, 'claude', 'pre', { tool_name: 'Bash', tool_input: { command: 'git push origin main' } })
      assert.equal(r.code, EXIT.OK)
      const out = hookJson(r.out).hookSpecificOutput
      assert.equal(out.hookEventName, 'PreToolUse')
      assert.equal(out.permissionDecision, 'ask')
      assert.match(out.permissionDecisionReason, /D5/)
    })
  })

  test('POSITIVE CONTROL: Cursor gets {"permission":"ask"} for git push when D5 is accepted', async () => {
    await withInstall([], { defaults: D5 }, async (root) => {
      const r = await run(['--host', 'cursor', '--mode', 'pre', '--no-telemetry'], { cwd: root, input: JSON.stringify({ command: 'git push origin main', cwd: root }) })
      assert.equal(r.code, EXIT.OK)
      assert.equal(hookJson(r.out).permission, 'ask')
    })
  })

  test('POSITIVE CONTROL: Codex, Gemini and generic allow with a stderr notice', async () => {
    await withInstall([], { defaults: D5 }, async (root) => {
      const codex = await invoke(root, 'codex', 'pre', { tool_name: 'Bash', tool_input: { command: 'npm publish' } })
      assert.equal(codex.code, EXIT.OK)
      assert.match(codex.err, /D5/)
      assert.doesNotMatch(codex.out, /permissionDecision|"ask"/)
      const gemini = await invoke(root, 'gemini', 'pre', { tool_name: 'run_shell_command', tool_input: { command: 'docker push img:1' } })
      assert.equal(gemini.code, EXIT.OK)
      assert.match(gemini.err, /D5/)
      assert.equal(gemini.out, '', 'Gemini stdout stays JSON-or-empty')
      const generic = await run(['--host', 'generic', '--mode', 'pre', '--no-telemetry'], { cwd: root, input: JSON.stringify({ command: 'git push origin main', cwd: root }) })
      assert.equal(generic.code, EXIT.OK)
      assert.equal(hookJson(generic.out).decision, 'allow')
      assert.match(generic.err, /D5/)
    })
  })

  test('without D5 in force, nothing is asked or noted', async () => {
    await withInstall([], { defaults: ['D1'] }, async (root) => {
      const r = await invoke(root, 'claude', 'pre', { tool_name: 'Bash', tool_input: { command: 'git push origin main' } })
      assert.equal(r.code, EXIT.OK)
      assert.equal(r.out, '')
      assert.equal(r.err, '')
    })
    await withInstall([], {}, async (root) => {
      const r = await invoke(root, 'codex', 'pre', { tool_name: 'Bash', tool_input: { command: 'git push origin main' } })
      assert.equal(r.err, '')
    })
  })

  test('a blocking command gate still blocks, and is not softened into an ask', async () => {
    const guard = { id: 'no-push', kind: 'command', severity: 'block', origin: 'docs/rules/active/fixture.md', message: 'No.', patterns: [{ literal: 'git push', label: 'git push' }] }
    await withInstall([guard], { defaults: D5 }, async (root) => {
      const r = await invoke(root, 'claude', 'pre', { tool_name: 'Bash', tool_input: { command: 'git push origin main' } })
      assert.equal(r.code, EXIT.PRE_BLOCK)
    })
  })

  test('outwardAction names each outward command, and only at the start of a command', () => {
    for (const [cmd, name] of [
      ['git push origin main', 'git push'],
      ['git -C ../x push --force', 'git push'],
      ['npm publish --access public', 'npm publish'],
      ['pnpm publish', 'npm publish'],
      ['yarn npm publish', 'npm publish'],
      ['gh release create v1.0.0 dist/*', 'gh release'],
      ['cargo publish', 'cargo publish'],
      ['twine upload dist/*', 'twine upload'],
      ['python -m twine upload dist/*', 'twine upload'],
      ['docker push ghcr.io/a/b:1', 'docker push'],
      ['npm test && git push', 'git push'],
      ['CI=1 git push', 'git push'],
      ['sudo npm publish', 'npm publish'],
      ['bash -c "git push origin main"', 'git push'],
    ]) assert.equal(outwardAction(cmd), name, cmd)
    for (const cmd of [
      'git commit -m "docs: git push"', 'echo git push', 'git status', 'npm test', 'git push --dry-run', 'npm publish --dry-run',
      'gh release list', 'docker build .', 'cat notes-on-npm-publish.md', '',
    ]) assert.equal(outwardAction(cmd), null, cmd)
  })
})
