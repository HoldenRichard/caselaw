/**
 * 0.5 (WP3): CaseLaw does not raise false alarms about its own edits, the audit
 * is quiet and precise on a fresh install, and an Origin is a real commit.
 *
 * Field tests of 0.4.2: `rule catch` and `rule promote` made `check --strict`
 * exit 1; a fresh install printed a dozen identical errors; a required
 * question had no "none"; an invented SHA was waved through.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import * as manifestStore from '../../src/core/manifest.js'
import { writeManaged } from '../../src/core/safe-write.js'
import { locate } from '../../src/core/blocks.js'
import { hash } from '../../src/core/text.js'
import { buildPlan, UNCHANGED, SKIP, NEW, formatPlan } from '../../src/core/plan.js'
import { runChecks, SEVERITY } from '../../src/audit/checks.js'
import { gather, parseAuthority } from '../../src/audit/gather.js'
import { QUESTIONS, optionsFor, settleNone, describeUnanswered, NONE_VALUE } from '../../src/interview/questions.js'
import { askOne } from '../../src/interview/runner.js'
import { scriptedPrompt } from '../../src/interview/prompt.js'
import { buildDraft, validateDraft, applyNotes } from '../../src/interview/draft.js'
import { emptyAnswers } from '../../src/core/answers.js'
import { buildModel, generate, settleProblem } from '../../src/generate/authority-split.js'
import { generate as generateCloseOut } from '../../src/generate/close-out.js'
import { parseRule, validateRule, findReferences, gitRefResolver } from '../../src/core/rules.js'
import { cmdRule } from '../../src/commands/rule.js'

const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
const HAS_GIT = (() => { try { execFileSync('git', ['--version']); return true } catch { return false } })()

function cli(args, { cwd }) {
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

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'caselaw-quiet-'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** A committed repository with a caselaw install (all six defaults), made the way an agent does it. */
async function installed() {
  git(root, 'init', '-q')
  await writeFile(join(root, 'README.md'), '# Demo\n\nA thing.\n', 'utf8')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'echo ok' } }), 'utf8')
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init')
  assert.equal((await cli(['init', '--draft'], { cwd: root })).code, 0)
  const r = await cli(['init', '--from-draft', '--yes'], { cwd: root })
  assert.equal(r.code, 0, r.out)
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'install')
  return git(root, 'rev-parse', '--short', 'HEAD').trim()
}

const driftOf = async () => (await cli(['audit', '--json'], { cwd: root })).out
const findings = async (code) => JSON.parse(await driftOf()).findings.filter((f) => f.code === code)

// ---------------------------------------------------------------------------
// 1. The tool's own edits are not hand edits
// ---------------------------------------------------------------------------

describe('the manifest and the tool\'s own edits', () => {
  async function withEntry(text = 'generated\n') {
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs/rule.md'), text, 'utf8')
    const m = manifestStore.emptyManifest()
    manifestStore.record(m, { path: 'docs/rule.md', kind: 'file', contentHash: hash(text) })
    await manifestStore.save(root, m)
  }
  const reconcile = async () => manifestStore.reconcile(root, await manifestStore.load(root), { locate })

  test('a write through writeManaged is clean, not modified', async () => {
    await withEntry()
    await writeManaged(root, 'docs/rule.md', 'generated\n\nOrigin: commit abc1234\n')
    const r = await reconcile()
    assert.deepEqual(r.modified, [])
    assert.deepEqual(r.clean, ['docs/rule.md'])
    assert.deepEqual(r.toolEdited, ['docs/rule.md'])
  })

  test('POSITIVE CONTROL: a hand edit after the tool wrote is still detected', async () => {
    await withEntry()
    await writeManaged(root, 'docs/rule.md', 'generated\n\nOrigin: commit abc1234\n')
    await writeFile(join(root, 'docs/rule.md'), 'generated\n\nOrigin: commit abc1234\nby hand\n', 'utf8')
    assert.deepEqual((await reconcile()).modified, ['docs/rule.md'])
  })

  test('POSITIVE CONTROL: a hand edit BEFORE the tool wrote is not laundered by the tool\'s write', async () => {
    await withEntry()
    await writeFile(join(root, 'docs/rule.md'), 'generated\nby hand\n', 'utf8')
    await writeManaged(root, 'docs/rule.md', 'generated\nby hand\n\nOrigin: x\n')
    assert.deepEqual((await reconcile()).modified, ['docs/rule.md'])
  })

  test('writing back what was generated drops the mark', async () => {
    await withEntry()
    await writeManaged(root, 'docs/rule.md', 'other\n')
    await writeManaged(root, 'docs/rule.md', 'generated\n')
    assert.equal((await manifestStore.load(root)).entries['docs/rule.md'].toolHash, undefined)
  })

  test('a file the manifest does not own is written, and the manifest is untouched', async () => {
    await withEntry()
    const before = await readFile(join(root, '.caselaw/manifest.json'), 'utf8')
    await writeManaged(root, 'docs/not-ours.md', 'hello\n')
    assert.equal(await readFile(join(root, 'docs/not-ours.md'), 'utf8'), 'hello\n')
    assert.equal(await readFile(join(root, '.caselaw/manifest.json'), 'utf8'), before)
  })

  test('the plan keeps a tool-edited file, says so, and --force regenerates it', async () => {
    await withEntry('generated\n')
    await writeManaged(root, 'docs/rule.md', 'generated\n\nOrigin: x\n')
    const manifest = await manifestStore.load(root)
    const art = [{ path: 'docs/rule.md', kind: 'file', body: 'generated\n' }]
    const plan = await buildPlan(root, art, { manifest })
    assert.equal(plan.entries[0].action, UNCHANGED)
    assert.match(formatPlan(plan), /kept: a caselaw command wrote into it/)
    assert.equal((await buildPlan(root, art, { manifest, force: true })).entries[0].action, NEW)
  })

  test('POSITIVE CONTROL: a hand-edited file is still skipped by the plan', async () => {
    await withEntry('generated\n')
    await writeFile(join(root, 'docs/rule.md'), 'generated\nby hand\n', 'utf8')
    const plan = await buildPlan(root, [{ path: 'docs/rule.md', kind: 'file', body: 'generated\n' }], { manifest: await manifestStore.load(root) })
    assert.equal(plan.entries[0].action, SKIP)
  })

  test('re-recording the same bytes (an upgrade over a kept file) does not drop the mark', async () => {
    await withEntry()
    await writeManaged(root, 'docs/rule.md', 'edited by a command\n')
    const m = await manifestStore.load(root)
    manifestStore.record(m, { path: 'docs/rule.md', kind: 'file', contentHash: hash('edited by a command\n') })
    assert.equal(m.entries['docs/rule.md'].hash, hash('generated\n'))
    assert.equal(m.entries['docs/rule.md'].toolHash, hash('edited by a command\n'))
  })

  test('eject leaves a tool-edited file alone, like a hand edit', async () => {
    await withEntry()
    await writeManaged(root, 'docs/rule.md', 'edited by a command\n')
    const m = await manifestStore.load(root)
    const plan = manifestStore.ejectPlan(m, await manifestStore.reconcile(root, m, { locate }))
    assert.deepEqual(plan.deleteFiles, [])
    assert.equal(plan.leaveAlone[0].path, 'docs/rule.md')
  })
})

describe('the commands, end to end (field: `check --strict` exited 1 after the tool\'s own edit)', { skip: !HAS_GIT }, () => {
  test('rule catch: check --strict and the audit stay clean; a later hand edit is still reported', async () => {
    const sha = await installed()
    const caught = await cli(['rule', 'catch', 'seen-to-fail', '--what', `commit ${sha}: a check passed without being run`], { cwd: root })
    assert.equal(caught.code, 0, caught.out)
    assert.match(caught.out, /first catch here/)

    const strict = await cli(['check', '--strict'], { cwd: root })
    assert.equal(strict.code, 0, strict.out)
    assert.doesNotMatch(strict.out, /DIVERGED/)
    assert.deepEqual(await findings('drift'), [])

    // POSITIVE CONTROL: the same check must still fail on a real hand edit.
    const path = join(root, 'docs/rules/active/seen-to-fail.md')
    await writeFile(path, (await readFile(path, 'utf8')) + '\nhand-written line\n', 'utf8')
    const after = await cli(['check', '--strict'], { cwd: root })
    assert.equal(after.code, 1, after.out)
    assert.match(after.out, /DIVERGED\s+docs\/rules\/active\/seen-to-fail\.md/)
    assert.equal((await findings('drift')).length, 1)
  })

  test('rule promote: gates.json and the rule file are not drift, and an upgrade keeps them', async () => {
    await installed()
    const p = await cli(['rule', 'promote', 're-derive-claims', '--kind', 'banned-content', '--paths', 'docs/**', '--patterns', 'ZZTOP', '--yes'], { cwd: root })
    assert.equal(p.code, 0, p.out)
    const strict = await cli(['check', '--strict'], { cwd: root })
    assert.equal(strict.code, 0, strict.out)
    assert.deepEqual(await findings('drift'), [])

    const gatesBefore = await readFile(join(root, '.caselaw/gates.json'), 'utf8')
    const up = await cli(['upgrade', '--yes'], { cwd: root })
    assert.equal(up.code, 0, up.out)
    assert.equal(await readFile(join(root, '.caselaw/gates.json'), 'utf8'), gatesBefore, 'upgrade must not wipe the promoted gate')
    assert.match(await readFile(join(root, 'docs/rules/active/re-derive-claims.md'), 'utf8'), /machine:re-derive-claims/)

    // The warn -> block step rewrites gates.json too, and is just as much the tool's own.
    const blocked = await cli(['gate', 'promote', 're-derive-claims', '--force'], { cwd: root })
    assert.equal(blocked.code, 0, blocked.out)
    assert.match(await readFile(join(root, '.caselaw/gates.json'), 'utf8'), /"severity": "block"/)
    assert.equal((await cli(['check', '--strict'], { cwd: root })).code, 0)
    assert.deepEqual(await findings('drift'), [])

    // POSITIVE CONTROL: editing gates.json by hand afterwards is reported.
    const gates = join(root, '.caselaw/gates.json')
    await writeFile(gates, (await readFile(gates, 'utf8')).replace('"block"', '"warn"'), 'utf8')
    assert.equal((await cli(['check', '--strict'], { cwd: root })).code, 1)
  })

  test('rule demote of a default: no "recorded as generated but missing" error', async () => {
    await installed()
    const code = await cmdRule(
      { sub: 'demote', name: 'say-what-was-not-covered', opt: { reason: 'test' }, yes: true },
      { root, say: () => {}, interactive: true, prompt: () => ({ confirm: async () => true, close: async () => {} }) },
    )
    assert.equal(code, 0)
    assert.deepEqual(await findings('drift'), [])
    const manifest = await manifestStore.load(root)
    assert.equal(manifest.entries['docs/rules/active/say-what-was-not-covered.md'], undefined)
  })
})

// ---------------------------------------------------------------------------
// 2. The audit on a fresh install
// ---------------------------------------------------------------------------

describe('audit: untracked governance files are one finding', () => {
  const ctx = (over = {}) => ({
    root, now: new Date('2026-08-13T00:00:00Z'),
    rules: { active: [], proposed: [], candidates: [] }, gatesConfig: { version: 1, gates: [] },
    docRefs: [], untracked: [], docTexts: {}, staleCommands: [], fireCounts: {}, earnedFires: {},
    drifted: [], authority: null, answers: null, adrs: null, gitignoreClaims: [], installAgeDays: 100, installed: true,
    ...over,
  })
  const tracked = (r) => r.findings.filter((f) => f.code === 'doctrine-tracked')
  const FILES = ['docs/authority-split.md', 'docs/close-out.md', 'AGENTS.md', 'docs/rules/active/a.md']

  test('before the first commit: one warning that says to commit the install, and the audit passes', () => {
    const r = runChecks(ctx({ untracked: FILES, installCommitted: false }))
    assert.equal(tracked(r).length, 1)
    assert.equal(tracked(r)[0].severity, SEVERITY.WARN)
    assert.match(tracked(r)[0].message, /^commit the install: 4 governance files/)
    for (const f of FILES) assert.ok(tracked(r)[0].message.includes(f), `${f} is listed`)
    assert.equal(r.ok, true)
  })

  test('POSITIVE CONTROL: once the install has been committed, an untracked file is one error naming them all', () => {
    const r = runChecks(ctx({ untracked: FILES, installCommitted: true }))
    assert.equal(tracked(r).length, 1)
    assert.equal(tracked(r)[0].severity, SEVERITY.ERROR)
    assert.equal(r.ok, false)
    for (const f of FILES) assert.ok(tracked(r)[0].message.includes(f))
  })

  test('an untracked proposal is a note, never an error, even after the install is committed', () => {
    const draft = 'docs/rules/proposed/my-rule.md'
    const r = runChecks(ctx({ untracked: [draft], installCommitted: true }))
    assert.equal(tracked(r).length, 1)
    assert.equal(tracked(r)[0].severity, SEVERITY.INFO)
    assert.equal(r.ok, true)
    // ...and beside a real untracked doctrine file it is reported separately, so the error stays an error.
    const both = runChecks(ctx({ untracked: [draft, 'AGENTS.md'], installCommitted: true }))
    assert.deepEqual(tracked(both).map((f) => f.severity).sort(), [SEVERITY.ERROR, SEVERITY.INFO].sort())
    assert.ok(!tracked(both).find((f) => f.severity === SEVERITY.ERROR).message.includes(draft))
  })

  test('gather: false before the install is in HEAD, true after', { skip: !HAS_GIT }, async () => {
    git(root, 'init', '-q')
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await writeFile(join(root, '.caselaw/answers.json'), '{}', 'utf8')
    await writeFile(join(root, 'AGENTS.md'), '# a\n', 'utf8')
    assert.equal((await gather(root)).installCommitted, false)
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'x')
    assert.equal((await gather(root)).installCommitted, true)
  })

  test('a fresh install exits 0 from audit and prints one finding for the untracked files', { skip: !HAS_GIT }, async () => {
    git(root, 'init', '-q')
    await writeFile(join(root, 'README.md'), '# Demo\n', 'utf8')
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'echo ok' } }), 'utf8')
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init')
    await cli(['init', '--draft'], { cwd: root })
    assert.equal((await cli(['init', '--from-draft', '--yes'], { cwd: root })).code, 0)
    const a = await cli(['audit'], { cwd: root })
    assert.equal(a.code, 0, a.out)
    assert.equal((a.out.match(/doctrine-tracked/g) || []).length, 1, a.out)
    assert.match(a.out, /commit the install/)
  })
})

// ---------------------------------------------------------------------------
// 3. Questions that can be answered "none", and say which are open
// ---------------------------------------------------------------------------

describe('"none" is an answer', () => {
  const MULTI = ['authority.cannot', 'outside.authority', 'outside.claims']

  test('the required list questions each offer it', () => {
    for (const id of MULTI) {
      const q = QUESTIONS.find((x) => x.id === id)
      assert.ok(optionsFor(q, { detected: {} }).some((o) => o.value === NONE_VALUE), `${id} has no "none"`)
    }
  })

  test('picked at the terminal, it is stored as an empty answer: answered, not unanswered', async () => {
    const q = QUESTIONS.find((x) => x.id === 'outside.authority')
    const doc = emptyAnswers()
    const idx = optionsFor(q, { detected: {} }).findIndex((o) => o.value === NONE_VALUE) + 1
    const value = await askOne(q, { doc, detected: {}, prompt: scriptedPrompt([[NONE_VALUE]]) })
    assert.deepEqual(value, [], `option ${idx} must settle to []`)
    assert.deepEqual(settleNone(['none', 'app-review']), ['app-review'], 'beside real choices it is dropped')
    assert.deepEqual(settleNone(['app-review']), ['app-review'])
  })

  test('in a draft: ["none"] holds up with evidence; mixing it with others is refused', async () => {
    const detected = {}
    const fill = (answer) => {
      const d = buildDraft({ doc: emptyAnswers(), detected })
      Object.assign(d.questions.find((q) => q.id === 'outside.authority'), { answer, evidence: ['command: ls'] })
      return d
    }
    assert.deepEqual(await validateDraft(fill(['none']), { root, detected }), [])
    const mixed = await validateDraft(fill(['none', 'external-reviewer']), { root, detected })
    assert.match(mixed.join('\n'), /outside\.authority: "none" is an answer on its own/)
  })

  test('end to end: --from-draft with none stores [] and leaves no warning for it', { skip: !HAS_GIT }, async () => {
    git(root, 'init', '-q')
    await writeFile(join(root, 'README.md'), '# Demo\n', 'utf8')
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init')
    await cli(['init', '--draft'], { cwd: root })
    const path = join(root, '.caselaw/draft.json')
    const draft = JSON.parse(await readFile(path, 'utf8'))
    Object.assign(draft.questions.find((q) => q.id === 'outside.authority'), { answer: ['none'], evidence: ['README.md'] })
    await writeFile(path, JSON.stringify(draft), 'utf8')
    const r = await cli(['init', '--from-draft', '--yes'], { cwd: root })
    assert.equal(r.code, 0, r.out)
    const doc = JSON.parse(await readFile(join(root, '.caselaw/answers.json'), 'utf8'))
    assert.deepEqual(doc.answers['outside.authority'], [])
    assert.ok(!doc.unanswered.some((u) => u.id === 'outside.authority'))
    // The one still open is named by id, with how to answer it.
    assert.match(r.out, /\d question\(s\) unanswered/)
    assert.match(r.out, /authority\.cannot: Right now, today/)
    assert.match(r.out, /answer \["none"\] if nothing applies/)
    assert.match(r.out, /caselaw init --from-draft --yes/)
    assert.doesNotMatch(r.out, /outside\.authority:/)
  })

  test('describeUnanswered names each id, what it takes and both ways to answer', () => {
    const lines = describeUnanswered([{ id: 'outside.authority', prompt: 'Who outside?' }, { id: 'authority.retest_days', prompt: 'Days?' }])
    assert.equal(lines[0], 'outside.authority: Who outside?')
    assert.match(lines[1], /takes: .*none/)
    assert.match(lines.join('\n'), /authority\.retest_days: Days\?\n {2}takes: a number from 7 to 365/)
    assert.match(lines.at(-1), /caselaw init --interview.*caselaw init --draft.*caselaw init --from-draft --yes/)
    assert.deepEqual(describeUnanswered([]), [])
  })

  test('the audit names the question id and the way to answer it', () => {
    const r = runChecks({
      root, now: new Date(), rules: { active: [], proposed: [], candidates: [] }, gatesConfig: { version: 1, gates: [] },
      docRefs: [], untracked: [], docTexts: {}, staleCommands: [], fireCounts: {}, earnedFires: {}, drifted: [],
      authority: null, adrs: null, gitignoreClaims: [], installAgeDays: 1, installed: true,
      answers: { unanswered: [{ id: 'outside.authority', prompt: 'Who outside?', generates: ['docs/authority-split.md#outside-authority'] }] },
    })
    const f = r.findings.find((x) => x.code === 'open-questions')
    assert.match(f.message, /unanswered outside\.authority: Who outside\?/)
    assert.match(f.hint, /caselaw init --draft.*outside\.authority.*caselaw init --from-draft --yes/)
  })
})

// ---------------------------------------------------------------------------
// 4. Generated docs do not repeat themselves
// ---------------------------------------------------------------------------

describe('generated docs: no repeated lines', () => {
  const DRAFTED = 'The repository declares these verification commands: npm test. Their execution and coverage still need to be verified locally.'
  const CI = { ciGates: { gates: [{ file: '.github/workflows/ci.yml', job: 't', cmd: 'npm test', line: 9 }], setup: [], shared: [], contexts: [], unread: [] } }

  /** Non-empty lines that carry words and occur more than once. */
  const repeated = (text) => {
    const seen = new Map()
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!/[A-Za-z0-9]/.test(t) || t === '- none') continue
      seen.set(t, (seen.get(t) || 0) + 1)
    }
    return [...seen].filter(([, n]) => n > 1).map(([l]) => l)
  }

  test('POSITIVE CONTROL: the drafted verification sentence beside the CI line is said once', async () => {
    const answers = { 'authority.agent_reach': DRAFTED }
    const { content } = await generate({ answers, detected: CI, projectName: 'P', now: new Date('2026-08-12') })
    assert.deepEqual(repeated(content), [])
    assert.equal((content.match(/npm test/g) || []).length, 1, content)
  })

  test('the drafted sentence stands when nothing else says it; a person\'s own answer always stands', async () => {
    const alone = await generate({ answers: { 'authority.agent_reach': DRAFTED }, detected: {}, projectName: 'P' })
    assert.match(alone.content, /The repository declares these verification commands/)
    const own = await generate({ answers: { 'authority.agent_reach': 'It could boot the simulator.' }, detected: CI, projectName: 'P' })
    assert.match(own.content, /It could boot the simulator\./)
    assert.match(own.content, /Run what CI runs/)
  })

  test('the same line twice in the "can" list collapses', () => {
    const m = buildModel({ answers: { 'authority.agent_reach': 'Run the linter.' }, detected: {}, projectName: 'P' })
    assert.deepEqual(m.can, ['Run the linter.'])
  })

  test('every doc generated for a rich install has no repeated line', async () => {
    const answers = {
      'authority.cannot': ['device', 'prod-logs', 'deploy'],
      'authority.triage': { device: 'physical', 'prod-logs': 'untested', deploy: 'chosen' },
      'authority.human_proof': 'Build to a phone.',
      'authority.agent_reach': DRAFTED,
      'outside.authority': ['app-review'],
      'harness.autonomy': 'ask-first',
      'harness.defaults': ['D1', 'D2'],
    }
    const detected = { ...CI, deploySurface: [{ kind: 'fly' }], commands: { test: { cmd: 'npm test', exitCode: 0, verifiedAt: '2026-08-12' } } }
    const split = await generate({ answers, detected, projectName: 'P', now: new Date('2026-08-12') })
    const close = await generateCloseOut({ answers, detected, projectName: 'P' })
    assert.deepEqual(repeated(split.content), [], 'authority-split.md')
    assert.deepEqual(repeated(close.content), [], 'close-out.md')
  })
})

// ---------------------------------------------------------------------------
// 5. Origins are real
// ---------------------------------------------------------------------------

describe('an Origin that names a commit must name one that exists', { skip: !HAS_GIT }, () => {
  const rule = (origin) => parseRule(`# a-rule\n\n**Trigger:** any change to the demo\n\n**Rule:** Run the demo.\n\n**Origin:** ${origin}\n\n**Enforcement:** memory\n`, { path: 'a-rule.md' })
  let full, shallow, oldest, newest

  beforeEach(async () => {
    full = join(root, 'full')
    await mkdir(full)
    git(full, 'init', '-q')
    for (const n of [1, 2, 3]) git(full, 'commit', '--allow-empty', '-qm', `c${n}`)
    oldest = git(full, 'rev-parse', '--short', 'HEAD~2').trim()
    newest = git(full, 'rev-parse', '--short', 'HEAD').trim()
    shallow = join(root, 'shallow')
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${full}`, shallow])
  })

  test('POSITIVE CONTROL: an invented SHA in a full repository is an error', () => {
    const v = validateRule(rule('commit abc1234 broke the build'), { root: full })
    assert.equal(v.ok, false)
    assert.equal(v.problems.find((p) => p.code === 'origin-unresolvable').severity, 'error')
  })

  test('a real SHA, short or long, is clean', () => {
    for (const sha of [oldest, newest, git(full, 'rev-parse', 'HEAD').trim()]) {
      assert.deepEqual(validateRule(rule(`commit ${sha} broke the build`), { root: full }).problems, [], sha)
    }
  })

  test('POSITIVE CONTROL: "deadbeef" (all letters, the classic invented SHA) is checked, not waved through', () => {
    assert.equal(findReferences('deadbeef broke it').total, 0, 'it is still not counted as a citation')
    assert.deepEqual(findReferences('deadbeef broke it').shaLike, ['deadbeef'])
    const v = validateRule(rule('deadbeef broke it, 2026-08-01'), { root: full })
    assert.equal(v.ok, false)
    assert.match(v.problems.find((p) => p.code === 'origin-unresolvable').message, /deadbeef/)
  })

  test('a date or a compact number is not mistaken for a SHA', () => {
    assert.deepEqual(findReferences('on 2026-08-01 and 20260801 and 1234567').shaLike, [])
    assert.equal(validateRule(rule('broke on 2026-08-01'), { root: full }).ok, true)
  })

  test('shallow clone: a commit beyond its history is a warning that says why, not an error', () => {
    assert.equal(gitRefResolver(shallow)(oldest), null, 'absent from a shallow clone is unknown, not false')
    const v = validateRule(rule(`commit ${oldest} broke the build`), { root: shallow })
    assert.equal(v.ok, true)
    const p = v.problems.find((x) => x.code === 'origin-unresolvable')
    assert.equal(p.severity, 'warn')
    assert.match(p.message, /shallow clone/)
    assert.match(p.hint, /git fetch --unshallow/)
  })

  test('POSITIVE CONTROL: shallow does not excuse a commit that is present, nor make a present one fail', () => {
    assert.equal(gitRefResolver(shallow)(newest), true)
    assert.deepEqual(validateRule(rule(`commit ${newest} broke the build`), { root: shallow }).problems, [])
  })

  test('outside a repository the answer stays a warning', () => {
    const plain = join(root, 'plain')
    return mkdir(plain).then(() => {
      const v = validateRule(rule('commit abc1234 broke the build'), { root: plain })
      assert.equal(v.ok, true)
      assert.equal(v.problems.find((p) => p.code === 'origin-unresolvable').severity, 'warn')
    })
  })

  test('`rule propose` with an invented SHA exits 1 and says the commit is not here', async () => {
    git(root, 'init', '-q'); git(root, 'commit', '--allow-empty', '-qm', 'c1')
    const r = await cli(['rule', 'propose', 'fake-origin', '--trigger', 'any change to the demo', '--rule', 'Run the demo.', '--origin', 'commit abc1234 broke prod'], { cwd: root })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /not in this repository: abc1234/)
  })

  test('the audit does not call a shallow clone\'s unchecked citation an error', async () => {
    await mkdir(join(shallow, 'docs/rules/active'), { recursive: true })
    await writeFile(join(shallow, 'docs/rules/active/a-rule.md'), `# a-rule\n\n**Trigger:** any change to the demo\n\n**Rule:** Run the demo.\n\n**Origin:** commit ${oldest} broke the build\n\n**Enforcement:** memory\n`, 'utf8')
    const g = await gather(shallow)
    const r = runChecks(g)
    const origin = r.findings.filter((f) => f.code === 'origin-resolves')
    assert.equal(origin.length, 1)
    assert.equal(origin[0].severity, SEVERITY.WARN)
  })
})

// ---------------------------------------------------------------------------
// 6. An untested boundary can carry its own settle command
// ---------------------------------------------------------------------------

describe('a recorded settle command', () => {
  const answers = {
    'authority.cannot': ['deploy', 'hardware'],
    'authority.triage': { deploy: 'untested', hardware: 'untested' },
    'authority.notes': { deploy: 'never tried' },
    'authority.settle': { deploy: './scripts/smoke.sh --staging' },
  }

  test('is rendered in the boundary\'s row instead of the placeholder', async () => {
    const { content } = await generate({ answers, detected: {}, projectName: 'P', now: new Date('2026-08-12') })
    assert.match(content, /\| deploy \| never tried \| `\.\/scripts\/smoke\.sh --staging` \|/)
    assert.match(content, /\| drive or observe the real hardware it talks to \| not recorded \| _no one-liner recorded/)
  })

  test('beats a detected guess, and the audit shows it in its warning', async () => {
    const withGuess = { ...answers, 'authority.cannot': ['secrets'], 'authority.triage': { secrets: 'untested' }, 'authority.settle': { secrets: 'cat .env.example' } }
    const { content } = await generate({ answers: withGuess, detected: {}, projectName: 'P', now: new Date('2026-08-12') })
    assert.match(content, /`cat \.env\.example`/)
    assert.doesNotMatch(content, /ls -la \.env/)

    const authority = parseAuthority((await generate({ answers, detected: {}, projectName: 'P', now: new Date('2026-08-12') })).content, 'docs/authority-split.md')
    assert.equal(authority.untested.find((b) => b.label === 'deploy').settleCommand, './scripts/smoke.sh --staging')
    const r = runChecks({
      root, now: new Date('2026-08-13'), rules: { active: [], proposed: [], candidates: [] }, gatesConfig: { version: 1, gates: [] },
      docRefs: [], untracked: [], docTexts: {}, staleCommands: [], fireCounts: {}, earnedFires: {}, drifted: [],
      authority, answers: null, adrs: null, gitignoreClaims: [], installAgeDays: 1, installed: true,
    })
    const w = r.findings.find((f) => f.code === 'authority-retest' && /deploy/.test(f.message))
    assert.equal(w.hint, 'Settle it: ./scripts/smoke.sh --staging')
    assert.equal(r.findings.find((f) => /hardware/.test(f.message)).hint, 'Try it once and record what happened.')
  })

  test('POSITIVE CONTROL: a command that would break the table or its code span is not rendered', async () => {
    for (const bad of ['echo `id`', 'ls | wc -l', 'a\nb', '', '   ', 7, 'x'.repeat(301)]) {
      assert.ok(settleProblem(bad), `${JSON.stringify(bad)} must be refused`)
      const { content } = await generate({ answers: { ...answers, 'authority.settle': { deploy: bad } }, detected: {}, projectName: 'P' })
      assert.match(content, /\| deploy \| never tried \| _no one-liner recorded/, JSON.stringify(bad))
    }
    assert.equal(settleProblem('./scripts/smoke.sh --staging'), null)
  })

  test('a draft note may carry it; the draft refuses a bad one and applies a good one', async () => {
    const detected = {}
    const make = (settle) => {
      const d = buildDraft({ doc: emptyAnswers(), detected })
      Object.assign(d.questions.find((q) => q.id === 'authority.cannot'), { answer: ['deploy'], evidence: ['command: ls'] })
      d.notes = { deploy: { reason: 'never tried', evidence: ['command: ls'], settle } }
      return d
    }
    assert.deepEqual(await validateDraft(make('./scripts/smoke.sh'), { root, detected }), [])
    assert.match((await validateDraft(make('echo `id`'), { root, detected })).join('\n'), /notes\.deploy\.settle: must not contain a backtick/)

    const doc = emptyAnswers()
    applyNotes(make('./scripts/smoke.sh'), doc, { confirmed: 'in chat (--yes)' })
    assert.deepEqual(doc.answers['authority.settle'], { deploy: './scripts/smoke.sh' })
    const noSettle = emptyAnswers()
    applyNotes(make(undefined), noSettle, { confirmed: 'in chat (--yes)' })
    assert.equal(noSettle.answers['authority.settle'], undefined)
  })
})

describe('drift: a gitignored generated file absent from a fresh clone (0.5.0 CI self-audit)', () => {
  test('POSITIVE CONTROL: an ignored missing file is not drift; an unignored missing one still is', async () => {
    const { gather } = await import('../../src/audit/gather.js')
    const { mkdtemp, writeFile: wf, mkdir: md } = await import('node:fs/promises')
    const { tmpdir: td } = await import('node:os')
    const { join: j } = await import('node:path')
    const { execFileSync } = await import('node:child_process')
    const dir = await mkdtemp(j(td(), 'caselaw-drift-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    await wf(j(dir, '.gitignore'), '.codex/\n')
    await md(j(dir, '.caselaw'), { recursive: true })
    await wf(j(dir, '.caselaw/manifest.json'), JSON.stringify({ schemaVersion: 1, entries: {
      '.codex/hooks.json': { kind: 'file', hash: 'a'.repeat(64) },
      'docs/close-out.md': { kind: 'file', hash: 'b'.repeat(64) },
    } }))
    const g = await gather(dir)
    const missing = (g.drifted || []).filter((d) => d.kind === 'missing').map((d) => d.path)
    assert.deepEqual(missing, ['docs/close-out.md'])
  })
})
