/**
 * The commands that make an install survivable: check, upgrade, eject, doctor.
 *
 * Everything before this phase was a one-way door. That is tolerable while you
 * are the only user and intolerable for anyone else: a tool that can only be
 * installed is a tool people refuse to try. The three properties that matter:
 *
 *   check    tells CI when the committed docs no longer match the answers
 *   upgrade  re-renders without eating anything a human wrote
 *   eject    removes exactly what we own and says what it left behind
 *
 * `doctor` is separate on purpose: check asks "is the content current?",
 * doctor asks "is any of this actually wired up?". A repo can pass one and
 * fail the other, and the failure that matters most — config nothing invokes —
 * only doctor can see.
 */

import { readFile, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import * as answersStore from '../core/answers.js'
import * as manifestStore from '../core/manifest.js'
import * as gatesStore from '../core/gates.js'
import { buildArtifacts } from '../generate/artifacts.js'
import { buildPlan, SKIP, UNCHANGED } from '../core/plan.js'
import { locate, remove as removeBlock } from '../core/blocks.js'
import { strip as stripJson } from '../core/jsonmerge.js'
import { kindAt, refusal } from '../core/fsguard.js'
import { hash } from '../core/text.js'

const pExecFile = promisify(execFile)

/**
 * Would regenerating produce something different from what is committed?
 *
 * Two distinct answers, kept apart because they call for opposite responses:
 *   stale    — our output is out of date. `upgrade` fixes it. Fails CI.
 *   diverged — a human edited our output. `upgrade` will not touch it, and
 *              that is correct. Reported, but does not fail unless asked,
 *              because failing a build for a deliberate edit is how a check
 *              gets deleted.
 */
export async function check({ root, detected, strict = false }) {
  const doc = await answersStore.load(root)
  if (!doc) {
    return { installed: false, ok: true, stale: [], diverged: [], missing: [] }
  }

  const artifacts = await buildArtifacts({ doc, detected })
  const manifest = (await manifestStore.load(root)) ?? manifestStore.emptyManifest()
  const plan = await buildPlan(root, artifacts, { manifest })

  const stale = []
  const diverged = []
  const missing = []

  for (const e of plan.entries) {
    if (e.action === UNCHANGED) continue
    if (e.action === SKIP) {
      diverged.push({ path: e.path, reason: e.reason })
      continue
    }
    // A tracked artifact that is absent is missing, not merely stale.
    const known = manifest.entries?.[e.path]
    const onDisk = await exists(join(root, e.path))
    if (known && !onDisk) missing.push({ path: e.path })
    else stale.push({ path: e.path, action: e.action })
  }

  return {
    installed: true,
    stale, diverged, missing,
    ok: stale.length === 0 && missing.length === 0 && (!strict || diverged.length === 0),
  }
}

/**
 * Re-render from answers.json at the current template version.
 *
 * Refuses nothing and overwrites nothing: it produces a plan the caller shows
 * before writing, exactly like `init`. The only difference is that the answers
 * already exist, so no interview runs unless questions were ADDED since the
 * recorded template version.
 */
export async function planUpgrade({ root, detected, force = false }) {
  const doc = await answersStore.load(root)
  if (!doc) throw new LifecycleError('No .caselaw/answers.json here. Run `caselaw init` first.', { code: 'NOT_INSTALLED' })

  const artifacts = await buildArtifacts({ doc, detected })
  const manifest = (await manifestStore.load(root)) ?? manifestStore.emptyManifest()
  const plan = await buildPlan(root, artifacts, { manifest, force })
  return { doc, manifest, plan, artifacts }
}

/**
 * Questions added since the template version this project was generated at.
 * An upgrade asks only these — re-interrogating someone about answers they
 * already gave is how an upgrade becomes something people avoid running.
 */
export function newQuestionsSince(templateVersion, questions) {
  const from = versionTuple(templateVersion)
  return questions.filter((q) => cmpVersion(versionTuple(q.since || '1.0'), from) > 0)
}

function versionTuple(v) {
  // Three parts: a question added at "1.0.1" used to be invisible.
  const [maj = 0, min = 0, patch = 0] = String(v ?? '0').split('.').map((n) => Number(n) || 0)
  return [maj, min, patch]
}
function cmpVersion(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * Remove the harness, leaving the project working.
 *
 * Whole files we created are deleted. Managed blocks are stripped from files
 * the user also owns. Anything the user edited is LEFT and reported: taking
 * back a file someone has since made their own is the one thing an uninstall
 * must never do.
 */
export async function planEject({ root, purge = false }) {
  const manifest = await manifestStore.load(root)
  if (!manifest) throw new LifecycleError('Nothing to eject — no .caselaw/manifest.json here.', { code: 'NOT_INSTALLED' })

  const reconciliation = await manifestStore.reconcile(root, manifest, { locate })
  const raw = manifestStore.ejectPlan(manifest, reconciliation)

  // Doctrine is KEPT by default. Everything under docs/ is the user's own
  // answers rendered as prose a human can read and follow with no tool
  // installed — deleting it on uninstall would destroy real work, and it is
  // the half of the design that is supposed to outlive this CLI. Machinery
  // goes: the runner, the schema, the gate config, and the agent wiring.
  //
  // `purge` removes the doctrine too, for someone who genuinely wants the
  // repo back exactly as it was.
  const isDoctrine = (p) => p.startsWith('docs/')
  const keptDoctrine = purge ? [] : raw.deleteFiles.filter(isDoctrine)
  const deleteFiles = purge ? raw.deleteFiles : raw.deleteFiles.filter((p) => !isDoctrine(p))

  const bookkeeping = ['.caselaw/answers.json', '.caselaw/manifest.json']
  return { manifest, reconciliation, ...raw, deleteFiles, keptDoctrine, bookkeeping, purge }
}

export async function applyEject({ root, plan }) {
  const removed = []
  const stripped = []
  const failed = []

  for (const path of plan.deleteFiles) {
    try {
      const refused = refusal(await kindAt(join(root, path)))
      if (refused) { failed.push({ path, reason: refused }); continue }
      await rm(join(root, path), { force: true })
      removed.push(path)
    } catch (err) {
      failed.push({ path, reason: err.message })
    }
  }

  for (const { path, blockId, kind } of plan.stripBlocks) {
    try {
      const refused = refusal(await kindAt(join(root, path)))
      if (refused) { failed.push({ path, reason: refused }); continue }
      const text = await readFile(join(root, path), 'utf8')
      if (kind === 'json-merge') {
        const r = stripJson(text)
        if (!r.ok) { failed.push({ path, reason: r.reason }); continue }
        if (r.action === 'absent') continue
        if (r.action === 'emptied') {
          // Nothing of the project's was in the file: it was ours, and it goes.
          await rm(join(root, path), { force: true })
          removed.push(path)
        } else {
          await writeFile(join(root, path), r.text, 'utf8')
          stripped.push(path)
        }
        continue
      }
      const out = removeBlock(text, blockId)
      if (out.action !== 'removed') continue
      if (out.text.trim() === '') {
        // The file held nothing but our block. Leaving an empty file behind
        // is litter, and an empty .gitignore is worse than litter — it looks
        // deliberate to the next reader.
        await rm(join(root, path), { force: true })
        removed.push(path)
      } else {
        await writeFile(join(root, path), out.text, 'utf8')
        stripped.push(path)
      }
    } catch (err) {
      failed.push({ path, reason: err.message })
    }
  }

  for (const path of plan.bookkeeping) {
    try { await rm(join(root, path), { force: true }) } catch { /* best effort */ }
  }

  return { removed, stripped, failed, left: plan.leaveAlone }
}

/**
 * Is any of this actually wired up?
 *
 * The failure this exists to catch: a repo full of correct configuration that
 * nothing ever invokes. Content checks pass, the docs are current, and no gate
 * has ever run. That is the most expensive way to be wrong, because it looks
 * exactly like working.
 */
export async function doctor({ root }) {
  const findings = []
  const ok = (name, detail) => findings.push({ name, status: 'ok', detail })
  const bad = (name, detail, hint) => findings.push({ name, status: 'fail', detail, hint })
  const warn = (name, detail, hint) => findings.push({ name, status: 'warn', detail, hint })

  let answers = null
  let answersError = null
  try {
    answers = await answersStore.load(root)
  } catch (err) {
    answersError = err
  }
  if (answersError) {
    // The file is there and does not parse. That is not "not installed", and
    // `init` cannot help — it reads the same file and dies the same way.
    bad('installed', `.caselaw/answers.json is unreadable: ${answersError.message}`, 'Restore it from git, or `caselaw eject` (which removes it) and install again. The wiring below is still checked.')
  } else if (!answers) {
    bad('installed', 'no .caselaw/answers.json', 'Run `caselaw init`.')
    return { findings, ok: false }
  } else {
    ok('installed', `answers.json, template ${answers.templateVersion}`)
  }

  // The vendored runner must exist AND execute.
  const runner = join(root, '.caselaw/bin/gate.mjs')
  if (!(await exists(runner))) {
    bad('gate runner', '.caselaw/bin/gate.mjs is missing', 'Run `caselaw upgrade` to restore it.')
  } else {
    try {
      // A diagnostic is a look, not evidence: without --no-telemetry every
      // doctor run appended to gate-fires.jsonl and manufactured the fires that
      // promote a warn gate to block.
      await pExecFile(process.execPath, [runner, '--mode', 'all', '--root', root, '--no-telemetry'], { timeout: 20000 })
      ok('gate runner', 'runs')
    } catch (err) {
      // Exit 1 means gates fired — the runner works fine.
      if (err?.code === 1) ok('gate runner', 'runs (gates currently firing)')
      else bad('gate runner', `does not run: ${err?.message ?? err}`, 'The hooks are configured but cannot execute.')
    }
  }

  // Hooks must point at a runner that is really there.
  const settingsPath = join(root, '.claude/settings.json')
  if (await exists(settingsPath)) {
    try {
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
      const commands = Object.values(settings.hooks ?? {})
        .flat()
        .flatMap((e) => (e.hooks ?? []).map((h) => h.command))
        .filter(Boolean)
      const ours = commands.filter((c) => c.includes('gate.mjs'))
      if (!commands.length) {
        warn('hooks', 'settings.json has no hook commands', 'Gates will only run in CI or by hand.')
      } else if (!ours.length) {
        // A settings file that exists and never invokes the runner is the
        // harness installed and inert — the failure this tool exists to
        // prevent, and it used to be reported as a warning under a green
        // "Wiring looks live".
        bad('hooks', 'settings.json exists but nothing invokes the gate runner', 'Re-run `caselaw init` (or `upgrade`) so the hook entries are merged in; until then no gate runs on any edit.')
      } else {
        // Run the command exactly as Claude Code would. A substring match on
        // "gate.mjs" used to pass a hook whose path could never execute.
        const probe = await exerciseHook(ours[0], root)
        if (probe.ok) ok('hooks', `${ours.length} hook command(s) wired and answering`)
        else bad('hooks', `the installed hook command does not reach the runner: ${probe.reason}`, 'The hook is configured but cannot execute; nothing is enforced on any edit.')
      }
    } catch (err) {
      bad('hooks', `.claude/settings.json is unreadable: ${err.message}`, 'Fix the JSON; a broken settings file disables every hook.')
    }
  } else {
    warn('hooks', 'no .claude/settings.json', 'Gates will only run in CI or by hand.')
  }

  // Gate config must parse, or every gate is silently absent.
  try {
    const gates = await gatesStore.load(root)
    if (!gates) warn('gates', 'no gates.json', 'Expected until a rule earns one.')
    else {
      const { ok: valid, problems } = gatesStore.validateConfig(gates)
      if (valid && gates.gates.length === 0) warn('gates', '0 gates: nothing is enforced yet', 'Expected until a rule earns one — `caselaw rule promote <name>`.')
      else if (valid) ok('gates', `${gates.gates.length} gate(s), config valid`)
      else bad('gates', `${problems.filter((p) => p.severity === 'error').length} config error(s)`, 'Run `caselaw audit` for detail.')
    }
  } catch (err) {
    bad('gates', err.message, 'A gates.json that does not parse means no gate runs at all.')
  }

  return { findings, ok: !findings.some((f) => f.status === 'fail') }
}

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

/**
 * Run an installed hook command the way the host does — through a shell,
 * with CLAUDE_PROJECT_DIR set, a PreToolUse payload on stdin — and read what
 * comes back. A clean payload must produce neither a block nor any sign the
 * runner was never reached.
 */
function exerciseHook(command, root) {
  if (process.platform === 'win32') return Promise.resolve({ ok: true, reason: 'not exercised on Windows' })
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: root,
    tool_input: { file_path: join(root, 'README.md'), old_string: '', new_string: '' },
  })
  return new Promise((resolvePromise) => {
    const child = spawn('sh', ['-c', command], {
      cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ ok: false, reason: e.message }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (/runner not found|Cannot find module|MODULE_NOT_FOUND|internal error/i.test(out + err)) {
        return resolvePromise({ ok: false, reason: (out + err).trim().split('\n')[0].slice(0, 200) })
      }
      if (code !== 0 && code !== 2) return resolvePromise({ ok: false, reason: `exit ${code}: ${(err || out).trim().split('\n')[0].slice(0, 200)}` })
      resolvePromise({ ok: true, reason: null })
    })
    child.stdin.end(payload)
  })
}

export class LifecycleError extends Error {
  constructor(message, meta = {}) {
    super(message)
    this.name = 'LifecycleError'
    Object.assign(this, meta)
  }
}
