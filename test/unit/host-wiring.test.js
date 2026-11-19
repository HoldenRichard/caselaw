/**
 * Every major coding agent, out of the box (0.5).
 *
 * Field tests on fresh repos found AGENTS.md installed and nothing else: Claude
 * Code does not read AGENTS.md, Gemini CLI reads GEMINI.md, and the only live
 * hook was Claude Code's, and only where .claude/ already existed. The setup
 * draft now carries a `hosts` field (prefilled from detection, extended by the
 * agent that knows which tool it is running in) and the selected hosts drive
 * the bridges, the live hooks and the session-start rule digest.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { buildArtifacts, HOST_HOOKS, codexHookSettings, cursorHookSettings, geminiHookSettings } from '../../src/generate/artifacts.js'
import { detectedHosts, cleanHosts, HOST_IDS } from '../../src/adapters/index.js'
import { buildDraft, validateDraft, draftSheet, HOW_TO_FILL } from '../../src/interview/draft.js'
import { emptyAnswers } from '../../src/core/answers.js'
import { merge, strip, extractOurs, HOOK_MARK } from '../../src/core/jsonmerge.js'
import { emptyEnvironment } from '../../src/detect/environment.js'
import { doctor } from '../../src/commands/lifecycle.js'
import { sessionDigest } from '../../runtime/gate.mjs'

const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
const RUNNER = fileURLToPath(new URL('../../runtime/gate.mjs', import.meta.url))

function spawned(file, args, { cwd, input = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
const cli = (args, opts) => spawned(CLI, args, opts)

let root
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-hosts-')))
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [k, v] of [['gc.auto', '0'], ['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) {
    execFileSync('git', ['config', k, v], { cwd: root })
  }
  await writeFile(join(root, 'README.md'), '# A project\n', 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'x'], { cwd: root })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const exists = async (rel) => { try { await stat(join(root, rel)); return true } catch { return false } }
const read = (rel) => readFile(join(root, rel), 'utf8')

const environment = (agentConfig = {}) => ({ ...emptyEnvironment(), agentConfig: { ...emptyEnvironment().agentConfig, ...agentConfig } })
const detectedWith = (agentConfig = {}) => ({ agentConfig: environment(agentConfig).agentConfig, stack: { languages: [] }, commands: {}, deploySurface: [] })

const FILL = {
  'authority.cannot': { answer: ['full-suite'], evidence: ['command: node --test'] },
  'authority.triage': { answer: { 'full-suite': 'physical' }, evidence: ['command: node --test'] },
  'authority.human_proof': { answer: 'Run it by hand.', source: 'human', evidence: [] },
  'authority.agent_reach': { answer: '?' },
}
async function applyDraft(hosts, { extra = (d) => d } = {}) {
  assert.equal((await cli(['init', '--draft'], { cwd: root })).code, 0)
  const path = join(root, '.caselaw/draft.json')
  const draft = JSON.parse(await readFile(path, 'utf8'))
  for (const q of draft.questions) if (FILL[q.id]) Object.assign(q, FILL[q.id])
  if (hosts !== undefined) draft.hosts = hosts
  else delete draft.hosts
  await writeFile(path, JSON.stringify(extra(draft)), 'utf8')
  return cli(['init', '--from-draft', '--yes'], { cwd: root })
}

describe('the draft carries a hosts field', () => {
  test('prefilled from detection, agents-md always, in canonical order', () => {
    const draft = buildDraft({ doc: emptyAnswers(), detected: detectedWith({ geminiDir: true, cursorRules: true, codexDir: true }) })
    assert.deepEqual(draft.hosts, ['codex', 'cursor', 'gemini', 'agents-md'])
    assert.deepEqual(buildDraft({ doc: emptyAnswers(), detected: detectedWith() }).hosts, ['agents-md'])
  })

  test('the setup agent is told to add the tool it runs in, and every supported id is named', () => {
    const line = HOW_TO_FILL.find((l) => l.includes('"hosts"'))
    assert.ok(line, 'howToFill must tell the agent about hosts')
    assert.match(line, /tool you are running in/)
    for (const id of HOST_IDS) assert.ok(line.includes(id), `howToFill names ${id}`)
  })

  test('a draft in progress and an earlier install both outrank detection', () => {
    const doc = emptyAnswers()
    doc.hosts = ['claude-code', 'agents-md']
    assert.deepEqual(buildDraft({ doc, detected: detectedWith({ geminiDir: true }) }).hosts, ['claude-code', 'agents-md'])
    const previous = { hosts: ['gemini'] }
    assert.deepEqual(buildDraft({ doc, detected: detectedWith(), previous }).hosts, ['gemini', 'agents-md'])
  })

  test('POSITIVE CONTROL: an unknown host id is refused, naming the ones that exist', async () => {
    const draft = buildDraft({ doc: emptyAnswers(), detected: detectedWith() })
    draft.hosts = ['claude-code', 'emacs']
    const errors = await validateDraft(draft, { root, detected: detectedWith(), doc: emptyAnswers() })
    assert.ok(errors.some((e) => /^hosts:/.test(e) && e.includes('gemini')), errors.join('\n'))
    draft.hosts = 'claude-code'
    assert.ok((await validateDraft(draft, { root, detected: detectedWith(), doc: emptyAnswers() })).some((e) => /^hosts:/.test(e)))
  })

  test('backward compatibility: a draft with no hosts field validates, and cleanHosts reads it as "detection decides"', async () => {
    const draft = buildDraft({ doc: emptyAnswers(), detected: detectedWith() })
    delete draft.hosts
    assert.deepEqual(await validateDraft(draft, { root, detected: detectedWith(), doc: emptyAnswers() }), [])
    assert.equal(cleanHosts(undefined), null)
    assert.deepEqual(cleanHosts(['gemini']), ['gemini', 'agents-md'])
  })

  test('the dry-run sheet shows which tools will be wired', async () => {
    const draft = buildDraft({ doc: emptyAnswers(), detected: detectedWith({ geminiMd: true }) })
    assert.ok((await draftSheet(root, draft)).some((l) => l.includes('Agent tools to wire: gemini, agents-md')))
  })
})

describe('detection', () => {
  test('GEMINI.md, .gemini/ and .codex/ are detected as hosts', () => {
    assert.deepEqual(detectedHosts(detectedWith({ geminiMd: true })), ['gemini', 'agents-md'])
    assert.deepEqual(detectedHosts(detectedWith({ geminiDir: true })), ['gemini', 'agents-md'])
    assert.deepEqual(detectedHosts(detectedWith({ codexDir: true })), ['codex', 'agents-md'])
    assert.deepEqual(detectedHosts(detectedWith({ claudeDir: true, copilot: true })), ['claude-code', 'copilot', 'agents-md'])
  })

  test('detectEnvironment reads them off the tree', async () => {
    await mkdir(join(root, '.gemini'))
    await mkdir(join(root, '.codex'))
    await writeFile(join(root, 'GEMINI.md'), '# hi\n')
    const { detectEnvironment } = await import('../../src/detect/environment.js')
    const { environment: env } = await detectEnvironment(root, { gh: false })
    assert.equal(env.agentConfig.geminiMd, true)
    assert.equal(env.agentConfig.geminiDir, true)
    assert.equal(env.agentConfig.codexDir, true)
  })
})

describe('bridges and hooks follow the selected hosts', () => {
  const doc = (hosts, defaults = []) => {
    const d = emptyAnswers({ templateVersion: '1.2', project: { name: 'P' } })
    d.generatedAt = '2026-11-19T00:00:00.000Z'
    if (hosts !== undefined) d.hosts = hosts
    Object.assign(d.answers, { 'authority.cannot': ['deploy'], 'authority.triage': { deploy: 'chosen' }, 'authority.human_proof': 'By hand.', 'authority.agent_reach': 'The suite.', 'harness.defaults': defaults })
    return d
  }
  const paths = async (d, detected = detectedWith()) => (await buildArtifacts({ doc: d, detected })).map((a) => a.path)

  test('POSITIVE CONTROL: claude-code selected on a repo with no CLAUDE.md still gets CLAUDE.md and the hooks', async () => {
    const got = await paths(doc(['claude-code', 'agents-md']))
    assert.ok(got.includes('CLAUDE.md'))
    assert.ok(got.includes('.claude/settings.json'))
    const claude = (await buildArtifacts({ doc: doc(['claude-code']), detected: detectedWith() })).find((a) => a.path === 'CLAUDE.md')
    assert.equal(claude.body, '@AGENTS.md')
  })

  test('gemini selected writes GEMINI.md with the @AGENTS.md import and .gemini/settings.json', async () => {
    const arts = await buildArtifacts({ doc: doc(['gemini']), detected: detectedWith() })
    assert.equal(arts.find((a) => a.path === 'GEMINI.md').body, '@AGENTS.md')
    assert.ok(arts.some((a) => a.path === '.gemini/settings.json' && a.kind === 'json-merge'))
    assert.ok(!arts.some((a) => a.path === 'CLAUDE.md'))
  })

  test('codex and cursor selected get their hook files and no stray bridges', async () => {
    const got = await paths(doc(['codex', 'cursor']))
    assert.ok(got.includes('.codex/hooks.json'))
    assert.ok(got.includes('.cursor/hooks.json'))
    assert.ok(!got.includes('GEMINI.md') && !got.includes('CLAUDE.md') && !got.includes('.gemini/settings.json'))
  })

  test('only agents-md selected: no host files at all, whatever detection would have said', async () => {
    const got = await paths(doc(['agents-md']), detectedWith({ claudeMd: true, geminiMd: true, cursorRules: true }))
    assert.ok(!got.some((p) => /CLAUDE|GEMINI|\.claude|\.gemini|\.codex|\.cursor/.test(p)), got.join(', '))
  })

  test('backward compatibility: no hosts field means the old detection, plus the new hosts', async () => {
    const got = await paths(doc(undefined), detectedWith({ claudeMd: true }))
    assert.ok(got.includes('CLAUDE.md') && got.includes('.claude/settings.json'))
    assert.ok(!got.includes('GEMINI.md') && !got.includes('.codex/hooks.json'))
    assert.ok((await paths(doc(undefined), detectedWith({ geminiDir: true }))).includes('GEMINI.md'))
    assert.deepEqual((await paths(doc(undefined), detectedWith())).filter((p) => /CLAUDE|GEMINI|hooks|settings/.test(p)), [])
  })

  test('every hook command runs the vendored runner and names its host', () => {
    for (const [host, want] of [['codex', codexHookSettings()], ['cursor', cursorHookSettings()], ['gemini', geminiHookSettings()]]) {
      const commands = JSON.stringify(want)
      assert.ok(commands.includes(HOOK_MARK), host)
      assert.ok(commands.includes(`--host ${host}`), host)
      assert.ok(commands.includes('--mode session'), `${host} injects the digest at session start`)
    }
  })

  test('host formats: Codex nested with matchers, Cursor flat with version, Gemini BeforeTool in ms', () => {
    const codex = codexHookSettings({ commands: true }).hooks
    assert.equal(codex.PreToolUse[0].matcher, 'Bash|apply_patch')
    assert.equal(codex.PostToolUse[0].matcher, 'apply_patch')
    assert.ok(codex.SessionStart[0].hooks[0].command.includes('--mode session'))
    assert.equal(codexHookSettings().hooks.PreToolUse[0].matcher, 'apply_patch', 'no shell hook unless a command gate or D5 needs one')
    const cursor = cursorHookSettings({ commands: true }).hooks
    assert.ok(cursor.beforeShellExecution[0].command && !cursor.beforeShellExecution[0].hooks)
    assert.ok(cursor.afterFileEdit && cursor.sessionStart)
    assert.equal(JSON.parse(merge(null, cursor).text).version, 1)
    const gemini = geminiHookSettings({ commands: true }).hooks
    assert.equal(gemini.BeforeTool[0].matcher, 'run_shell_command|write_file|replace')
    assert.equal(gemini.BeforeTool[0].hooks[0].timeout, 30000)
    assert.ok(gemini.SessionStart)
  })

  test('D5 accepted wires the shell hook for Claude Code too: the ask needs a command to see', async () => {
    const arts = await buildArtifacts({ doc: doc(['claude-code'], ['D5']), detected: detectedWith() })
    const settings = arts.find((a) => a.path === '.claude/settings.json')
    assert.ok(settings.merge.PreToolUse.some((e) => e.matcher === 'Bash'))
    const without = (await buildArtifacts({ doc: doc(['claude-code'], ['D1']), detected: detectedWith() })).find((a) => a.path === '.claude/settings.json')
    assert.ok(!without.merge.PreToolUse.some((e) => e.matcher === 'Bash'))
  })

  test('Claude Code re-injects the digest after a compaction: its SessionStart matcher names compact', async () => {
    const { claudeHookSettings } = await import('../../src/generate/artifacts.js')
    const entry = claudeHookSettings().hooks.SessionStart[0]
    for (const source of ['startup', 'resume', 'clear', 'compact']) assert.match(entry.matcher, new RegExp(`\\b${source}\\b`))
    assert.ok(entry.hooks[0].command.includes('--mode session --host claude'))
  })
})

describe('jsonmerge for the other hosts', () => {
  test('POSITIVE CONTROL: Cursor\'s flat entries merge beside the project\'s own and strip cleanly', () => {
    const theirs = JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './format.sh' }], stop: [{ command: './done.sh' }] } }, null, 2) + '\n'
    const merged = JSON.parse(merge(theirs, cursorHookSettings().hooks).text)
    assert.equal(merged.hooks.afterFileEdit.length, 2)
    assert.equal(merged.hooks.afterFileEdit[0].command, './format.sh', 'theirs first')
    assert.deepEqual(merged.hooks.stop, [{ command: './done.sh' }])
    assert.equal(extractOurs(merged).afterFileEdit.length, 1)
    const back = strip(merge(theirs, cursorHookSettings().hooks).text)
    assert.equal(back.action, 'stripped')
    assert.equal(back.text, theirs, 'the project\'s file back, byte for byte')
  })

  test('a Cursor hooks.json that is only ours (version stamp included) is emptied, not left behind', () => {
    assert.equal(strip(merge(null, cursorHookSettings().hooks).text).action, 'emptied')
  })

  test('formatting is preserved: a one-line file stays one line, tabs stay tabs, CRLF and a missing final newline stay', () => {
    const oneLine = '{"model":"x"}'
    const merged = merge(oneLine, geminiHookSettings().hooks).text
    assert.ok(!merged.includes('\n'), 'one line in, one line out')
    assert.equal(JSON.parse(merged).model, 'x')
    assert.equal(strip(merged).text, oneLine, 'and back, byte for byte')

    const tabbed = '{\n\t"model": "x"\n}\n'
    const tabMerged = merge(tabbed, geminiHookSettings().hooks).text
    assert.match(tabMerged, /\n\t"model": "x"/)
    assert.match(tabMerged, /\n\t"hooks": \{\n\t\t"/)

    const crlf = '{\r\n  "model": "x"\r\n}'
    const crlfMerged = merge(crlf, geminiHookSettings().hooks).text
    assert.ok(crlfMerged.includes('\r\n') && !/[^\r]\n/.test(crlfMerged), 'CRLF kept')
    assert.ok(!crlfMerged.endsWith('\n'), 'no final newline added')
    assert.equal(strip(crlfMerged).text, crlf)

    const four = '{\n    "model": "x"\n}\n'
    assert.match(merge(four, geminiHookSettings().hooks).text, /\n {4}"hooks": \{\n {8}"/)
  })

  test('unreadable JSON is refused for every host, not guessed at', () => {
    assert.equal(merge('{ nope', codexHookSettings().hooks).ok, false)
  })
})

describe('the session digest', () => {
  async function install(files, answers = {}) {
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await writeFile(join(root, '.caselaw/answers.json'), JSON.stringify({ schemaVersion: 1, answers: {}, ...answers }), 'utf8')
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(root, rel, '..'), { recursive: true })
      await writeFile(join(root, rel), text, 'utf8')
    }
  }
  const rule = (trigger) => `# r\n\n**Trigger:** ${trigger}\n\n**Rule:** do it.\n`

  test('POSITIVE CONTROL: one pointer line, then one `- name: Trigger` line per active rule', async () => {
    await install({
      'docs/rules/active/b-rule.md': rule('Editing the schema.'),
      'docs/rules/active/a-rule.md': rule('Reporting any test result.'),
      'docs/rules/active/WHY-THIS-IS-EMPTY.md': '# empty\n',
      'docs/rules/proposed/p.md': rule('A proposal, not in force.'),
    })
    const lines = (await sessionDigest(root)).split('\n')
    assert.match(lines[0], /docs\/authority-split\.md/)
    assert.deepEqual(lines.slice(1), ['- a-rule: Reporting any test result.', '- b-rule: Editing the schema.'])
  })

  test('each rule line stays short: a long Trigger is cut to about 25 words', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    await install({ 'docs/rules/active/long.md': rule(long) })
    const line = (await sessionDigest(root)).split('\n')[1]
    assert.ok(line.split(/\s+/).length <= 25, line)
    assert.match(line, /…$/)
  })

  test('it follows a relocated doctrine directory and says so when no rule is active', async () => {
    await install({ 'governance/rules/active/x.md': rule('Anything.') }, { doctrineDir: 'governance' })
    const text = await sessionDigest(root)
    assert.match(text.split('\n')[0], /governance\/authority-split\.md/)
    assert.match(text, /- x: Anything\./)
    await rm(join(root, 'governance/rules/active/x.md'))
    assert.match(await sessionDigest(root), /\(no active rules yet\)/)
  })

  test('it is read from the files on every call: a rule ratified after the session began is in the next digest', async () => {
    await install({ 'docs/rules/active/one.md': rule('First.') })
    assert.doesNotMatch(await sessionDigest(root), /two:/)
    await writeFile(join(root, 'docs/rules/active/two.md'), rule('Second.'))
    assert.match(await sessionDigest(root), /- two: Second\./)
  })

  test('each host gets the shape it reads: plain stdout, additional_context JSON, hookSpecificOutput JSON', async () => {
    await install({ 'docs/rules/active/one.md': rule('First.') })
    const call = (host) => spawned(RUNNER, ['--mode', 'session', '--host', host], { cwd: root, input: JSON.stringify({ cwd: root }) })
    for (const host of ['claude', 'codex']) {
      const r = await call(host)
      assert.equal(r.code, 0)
      assert.match(r.out, /^CaseLaw: read `docs\/authority-split\.md` first/)
      assert.match(r.out, /- one: First\./)
    }
    assert.match(JSON.parse((await call('cursor')).out).additional_context, /- one: First\./)
    const gemini = JSON.parse((await call('gemini')).out)
    assert.equal(gemini.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(gemini.hookSpecificOutput.additionalContext, /- one: First\./)
  })

  test('outside any install it prints nothing and exits 0', async () => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'caselaw-none-')))
    try {
      const r = await spawned(RUNNER, ['--mode', 'session', '--host', 'claude'], { cwd: elsewhere, input: JSON.stringify({ cwd: elsewhere }) })
      assert.equal(r.code, 0)
      assert.equal(r.out, '')
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('init --from-draft with hosts, end to end', () => {
  const ALL = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'agents-md']

  test('POSITIVE CONTROL: a fresh repo with every host selected gets every bridge and every hook file, and doctor finds them live', async () => {
    const r = await applyDraft(ALL)
    assert.equal(r.code, 0, r.out + r.err)
    assert.equal((await read('CLAUDE.md')).includes('@AGENTS.md'), true)
    assert.equal((await read('GEMINI.md')).includes('@AGENTS.md'), true)
    for (const { path } of Object.values(HOST_HOOKS)) {
      assert.equal(await exists(path), true, `${path} written`)
      assert.ok((await read(path)).includes(HOOK_MARK))
    }
    assert.deepEqual(JSON.parse(await read('.caselaw/answers.json')).hosts, ALL)
    const d = await doctor({ root })
    for (const name of ['hooks', 'hooks:codex', 'hooks:cursor', 'hooks:gemini']) {
      assert.equal(d.findings.find((f) => f.name === name)?.status, 'ok', `${name}: ${JSON.stringify(d.findings)}`)
    }
    const check = await cli(['check'], { cwd: root })
    assert.equal(check.code, 0, check.out)
  })

  test('a draft with no hosts field installs by detection, as 0.4.2 did (no hosts recorded)', async () => {
    const r = await applyDraft(undefined)
    assert.equal(r.code, 0, r.out + r.err)
    assert.equal(await exists('CLAUDE.md'), false)
    assert.equal(await exists('GEMINI.md'), false)
    assert.equal('hosts' in JSON.parse(await read('.caselaw/answers.json')), false)
    assert.equal(await exists('AGENTS.md'), true)
  })

  test('existing user content is never clobbered: CLAUDE.md, GEMINI.md and the settings files keep what the project wrote', async () => {
    await writeFile(join(root, 'CLAUDE.md'), '# Mine\n\nKeep this.\n')
    await mkdir(join(root, '.gemini'))
    await writeFile(join(root, '.gemini/settings.json'), '{"model":"keep-me"}')
    await mkdir(join(root, '.codex'))
    await writeFile(join(root, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] }] } }, null, 2) + '\n')
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '-qm', 'own config'], { cwd: root })
    const r = await applyDraft(ALL)
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(await read('CLAUDE.md'), /^# Mine\n\nKeep this\.\n/)
    assert.match(await read('CLAUDE.md'), /@AGENTS\.md/)
    assert.equal(JSON.parse(await read('.gemini/settings.json')).model, 'keep-me')
    const codex = JSON.parse(await read('.codex/hooks.json'))
    assert.equal(codex.hooks.PreToolUse[0].hooks[0].command, 'echo theirs')
    assert.equal(codex.hooks.PreToolUse.length, 2)
  })

  test('POSITIVE CONTROL: doctor fails a selected host whose hook file is gone', async () => {
    await applyDraft(['codex', 'agents-md'])
    await rm(join(root, '.codex/hooks.json'))
    const d = await doctor({ root })
    const finding = d.findings.find((f) => f.name === 'hooks:codex')
    assert.equal(finding.status, 'fail')
    assert.match(finding.detail, /\.codex\/hooks\.json is missing/)
    assert.equal(d.ok, false)
  })

  test('POSITIVE CONTROL: doctor fails a host file that exists and never invokes the runner', async () => {
    await applyDraft(['gemini', 'agents-md'])
    await writeFile(join(root, '.gemini/settings.json'), JSON.stringify({ hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }] } }))
    const finding = (await doctor({ root })).findings.find((f) => f.name === 'hooks:gemini')
    assert.equal(finding.status, 'fail')
    assert.match(finding.detail, /nothing invokes the gate runner/)
  })

  test('eject removes the host files caselaw wrote and strips only its entries from the rest', async () => {
    await mkdir(join(root, '.gemini'))
    await writeFile(join(root, '.gemini/settings.json'), '{"model":"keep-me"}')
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '-qm', 'own config'], { cwd: root })
    assert.equal((await applyDraft(ALL)).code, 0)
    const r = await cli(['eject', '--yes'], { cwd: root })
    assert.equal(r.code, 0, r.out)
    for (const rel of ['CLAUDE.md', 'GEMINI.md', '.codex/hooks.json', '.cursor/hooks.json', '.claude/settings.json']) assert.equal(await exists(rel), false, rel)
    assert.equal(await read('.gemini/settings.json'), '{"model":"keep-me"}', 'the project\'s one-line file, byte for byte')
    assert.equal(await exists('.codex'), false)
    assert.equal(await exists('.cursor'), false)
  })

  test('the installed Codex hook command runs the vendored runner from a subdirectory (probe through sh, as the host does)', async () => {
    assert.equal((await applyDraft(['codex', 'agents-md'])).code, 0)
    await mkdir(join(root, 'sub/dir'), { recursive: true })
    const hooks = JSON.parse(await read('.codex/hooks.json')).hooks
    const session = hooks.SessionStart[0].hooks[0].command
    const out = await new Promise((resolve) => {
      const child = spawn('sh', ['-c', session], { cwd: join(root, 'sub/dir'), stdio: ['pipe', 'pipe', 'pipe'] })
      let text = ''
      child.stdout.on('data', (d) => (text += d))
      child.on('close', () => resolve(text))
      child.stdin.end(JSON.stringify({ cwd: join(root, 'sub/dir') }))
    })
    assert.match(out, /CaseLaw: read `docs\/authority-split\.md` first/)
  })
})
