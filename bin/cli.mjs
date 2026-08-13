#!/usr/bin/env node
/**
 * caselaw — case law for your codebase.
 *
 * Interviews a project, generates its own governance, and enforces the part
 * that is mechanical.
 *
 * The whole tool obeys the discipline it installs: it detects before it asks,
 * shows the full change set before it writes, refuses to overwrite anything a
 * human has edited, and records what it did so the next run can tell its own
 * output from yours.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { argv, exit, cwd, stdout } from 'node:process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { detect } from '../src/detect/index.js'
import { runInterview } from '../src/interview/runner.js'
import { ttyPrompt } from '../src/interview/prompt.js'
import * as answersStore from '../src/core/answers.js'
import * as manifestStore from '../src/core/manifest.js'
import { buildPlan, formatPlan, SKIP, UNCHANGED } from '../src/core/plan.js'
import { locate } from '../src/core/blocks.js'
import { hash } from '../src/core/text.js'
import { generate as generateAuthoritySplit } from '../src/generate/authority-split.js'
import { generate as generateCloseOut } from '../src/generate/close-out.js'
import { scanMachinePaths } from '../src/core/secrets.js'
import { buildArtifacts } from '../src/generate/artifacts.js'
import { check, planUpgrade, planEject, applyEject, doctor, LifecycleError } from '../src/commands/lifecycle.js'
import { buildReviewPrompt } from '../src/commands/review.js'
import { ADAPTERS, selectAdapters } from '../src/adapters/index.js'
import { MODULES } from '../src/generate/artifacts.js'
import { gather } from '../src/audit/gather.js'
import { runChecks } from '../src/audit/checks.js'
import { formatReport, toJson, agentPrompt } from '../src/audit/report.js'

const CLI_VERSION = '0.1.0'
const TEMPLATE_VERSION = '1.0'

const USAGE = `caselaw ${CLI_VERSION}

  caselaw init [dir]     interview this project and generate its governance
  caselaw check [dir]    CI: are the committed docs still what the answers produce?
  caselaw upgrade [dir]  re-render from your answers at the current template
  caselaw doctor [dir]   is any of this actually wired up?
  caselaw eject [dir]    remove the tooling, keep everything you wrote
  caselaw audit [dir]    is the governance in this repo still true?
  caselaw review [dir]   print a review prompt for a DIFFERENT model to run
  caselaw detect [dir]   print what Stage 0 sees, and ask nothing
  caselaw --help

Options
  --dry-run              build and show the plan, write nothing
  --yes                  accept the plan without the final confirmation
  --force                overwrite content you have edited (read the diff first)
  --json                 machine-readable audit output, for CI
  --agent                print a model-agnostic prompt for a second opinion
  --with <a,b,c>         add optional modules: decisions, glossary, known-issues
  --purge                eject: remove the generated docs too
`

async function main() {
  const args = parseArgs(argv.slice(2))
  if (args.help || !args.command) return say(USAGE)

  switch (args.command) {
    case 'init': return cmdInit(args)
    case 'audit': return cmdAudit(args)
    case 'check': return cmdCheck(args)
    case 'upgrade': return cmdUpgrade(args)
    case 'doctor': return cmdDoctor(args)
    case 'eject': return cmdEject(args)
    case 'review': return cmdReview(args)
    case 'detect': return cmdDetect(args)
    default:
      say(`Unknown command "${args.command}".\n`)
      say(USAGE)
      exit(2)
  }
}

async function cmdCheck(args) {
  const root = resolve(args.dir || cwd())
  const detected = await detect(root)
  const r = await check({ root, detected, strict: args.strict })

  if (!r.installed) { say('No caselaw install here; nothing to check.'); return }

  for (const m of r.missing) say(`  MISSING   ${m.path}`)
  for (const st of r.stale) say(`  STALE     ${st.path}`)
  for (const d of r.diverged) say(`  DIVERGED  ${d.path}  ← ${d.reason}`)

  if (r.ok && !r.diverged.length) say('  Up to date. The committed docs are what the answers produce.')
  else if (r.ok) say(`\n  ${r.diverged.length} file(s) you edited. \`upgrade\` leaves those alone; --strict fails on them.`)
  else say('\n  Run `caselaw upgrade` to bring these back in line.')

  if (!r.ok) exit(1)
}

async function cmdUpgrade(args) {
  const root = resolve(args.dir || cwd())
  const detected = await detect(root)

  let planned
  try {
    planned = await planUpgrade({ root, detected, force: args.force })
  } catch (err) {
    say(`  ${err.message}`)
    return exit(1)
  }
  const { doc, manifest, plan } = planned

  say('')
  say(formatPlan(plan, { root }))
  if (args.dryRun) { say('\n  --dry-run: nothing written.'); return }
  if (plan.summary.willWrite === 0) { say('\n  Already up to date.'); return }

  if (!args.yes) {
    const prompt = ttyPrompt()
    try {
      const okToWrite = await prompt.confirm({ prompt: 'Apply these changes?', default: false })
      if (okToWrite !== true) { say('  Aborted. Nothing written.'); return exit(1) }
    } finally { await prompt.close() }
  }

  await writePlan({ root, plan, manifest, doc })
  say(`\n  Updated ${plan.summary.willWrite} file(s).`)
}

async function cmdDoctor(args) {
  const root = resolve(args.dir || cwd())
  const r = await doctor({ root })
  say('')
  for (const f of r.findings) {
    const mark = f.status === 'ok' ? '  ok  ' : f.status === 'warn' ? '  warn' : '  FAIL'
    say(`${mark}  ${f.name.padEnd(13)} ${f.detail}`)
    if (f.hint && f.status !== 'ok') say(`        ${' '.repeat(13)} ${f.hint}`)
  }
  say('')
  say(r.ok ? '  Wiring looks live.' : '  Something is configured but not working.')
  if (!r.ok) exit(1)
}

async function cmdEject(args) {
  const root = resolve(args.dir || cwd())
  let plan
  try {
    plan = await planEject({ root, purge: args.purge })
  } catch (err) {
    say(`  ${err.message}`)
    return exit(1)
  }

  say('')
  say(`  Eject — ${plan.deleteFiles.length} file(s) removed, ${plan.stripBlocks.length} block(s) stripped`)
  say('')
  for (const p of plan.deleteFiles) say(`  DELETE  ${p}`)
  for (const b of plan.stripBlocks) say(`  STRIP   ${b.path}  (block "${b.blockId}", the rest of the file stays)`)
  for (const l of plan.leaveAlone) say(`  KEEP    ${l.path}  ← ${l.reason}`)
  if (plan.keptDoctrine.length) {
    say(`  KEEP    ${plan.keptDoctrine.length} file(s) under docs/  ← your doctrine; readable without this tool`)
  }
  say('')
  if (plan.purge) {
    say('  --purge: the generated docs go too. This removes governance you wrote.')
  } else {
    say('  Everything under docs/ stays — it is your answers as prose, and it does not')
    say('  need this tool to be useful. What goes is the machinery, so gates stop')
    say('  running and the hooks stop firing. Use --purge to remove the docs as well.')
  }

  if (args.dryRun) { say('\n  --dry-run: nothing removed.'); return }
  if (!args.yes) {
    const prompt = ttyPrompt()
    try {
      const okToGo = await prompt.confirm({ prompt: 'Remove these?', default: false })
      if (okToGo !== true) { say('  Aborted. Nothing removed.'); return exit(1) }
    } finally { await prompt.close() }
  }

  const res = await applyEject({ root, plan })
  say(`\n  Removed ${res.removed.length}, stripped ${res.stripped.length}.`)
  if (res.left.length) say(`  Left ${res.left.length} file(s) you had edited.`)
  for (const f of res.failed) say(`  could not remove ${f.path}: ${f.reason}`)
}

async function cmdAudit(args) {
  const root = resolve(args.dir || cwd())
  const ctx = await gather(root)
  ctx.projectName = ctx.answers?.project?.name ?? basename(root)
  const result = runChecks(ctx)

  if (args.json) {
    say(JSON.stringify(toJson(result, ctx), null, 2))
  } else if (args.agent) {
    say(agentPrompt(result, ctx))
  } else {
    say(formatReport(result, ctx, { color: stdout.isTTY }))
  }
  // Errors fail CI. Warnings and notes never do — an audit that fails a build
  // for a note is an audit somebody removes from the build.
  if (!result.ok) exit(1)
}

async function cmdReview(args) {
  const root = resolve(args.dir || cwd())
  const ctx = await gather(root)
  say(buildReviewPrompt({
    root,
    detected: await detect(root),
    answers: ctx.answers,
    rules: ctx.rules,
    gatesConfig: ctx.gatesConfig,
  }))
}

async function cmdDetect(args) {
  const root = resolve(args.dir || cwd())
  const report = await detect(root)
  say(JSON.stringify(report, null, 2))
}

async function cmdInit(args) {
  const root = resolve(args.dir || cwd())

  say(`\ncaselaw ${CLI_VERSION} — ${root}`)
  say('Reading the repository before asking you anything…')
  const detected = await detect(root)
  say(renderDetection(detected))

  for (const w of detected.warnings || []) {
    say(`  ! ${w.message}${w.hint ? ` — ${w.hint}` : ''}`)
  }

  // Refuse to work on a dirty tree unless told otherwise: the plan we show has
  // to be about our changes, not tangled with in-flight edits.
  if (detected.vcs?.dirty && !args.force && !args.dryRun) {
    say(`\n  Working tree has uncommitted changes (${detected.vcs.dirtyCount ?? 'some'} paths).`)
    say('  Commit or stash first so the plan below is unambiguously ours, or pass --force.')
    return exit(1)
  }

  const existing = await answersStore.load(root)
  const doc = existing ?? answersStore.emptyAnswers({
    templateVersion: TEMPLATE_VERSION,
    project: { name: basename(root) },
  })
  doc.detected = summarizeDetection(detected)
  // Stamped once, then reused. If this came from the clock, the generated
  // docs would differ every day and `check` could never tell calendar drift
  // from real drift.
  doc.generatedAt ??= new Date().toISOString()
  // Recorded in answers so `check` and `upgrade` keep producing the same set;
  // a module chosen at install must not silently vanish on the next run.
  if (args.with.length) doc.modules = [...new Set([...(doc.modules ?? []), ...args.with])]

  const prompt = ttyPrompt()
  try {
    await runInterview({
      doc,
      detected,
      prompt,
      persist: (d) => answersStore.save(root, d),
      sessions: [1],
    })
    return await finishInit({ root, doc, detected, args, prompt })
  } finally {
    await prompt.close()
  }
}

async function finishInit({ root, doc, detected, args, prompt }) {

  const artifacts = await buildArtifacts({ doc, detected })

  // Our own no-machine-paths rule, applied to our own output before it lands.
  for (const a of artifacts) {
    const leaks = scanMachinePaths(a.body)
    if (leaks.length) {
      say(`\n  ! ${a.path} would contain a machine-specific path (${leaks[0].redacted}).`)
      say('    Refusing to write it. This is a rule caselaw ships, applied to itself.')
      return exit(1)
    }
  }

  const manifest = (await manifestStore.load(root)) ?? manifestStore.emptyManifest({
    cliVersion: CLI_VERSION, templateVersion: TEMPLATE_VERSION,
  })
  const plan = await buildPlan(root, artifacts, { manifest, force: args.force })

  say('')
  say(formatPlan(plan, { root }))

  if (args.dryRun) {
    say('\n  --dry-run: nothing written.')
    return
  }
  if (plan.summary.willWrite === 0) {
    say('\n  Already up to date.')
    return
  }
  if (!args.yes) {
    const ok = await prompt.confirm({ prompt: 'Write these files?', default: false })
    if (ok !== true) {
      say('  Aborted. Nothing written.')
      return exit(1)
    }
  }

  await writePlan({ root, plan, manifest, doc })

  say(`\n  Wrote ${plan.summary.willWrite} file(s).`)
  if (doc.unanswered.length) {
    say(`  ${doc.unanswered.length} question(s) unanswered — they are marked in the output, not guessed.`)
  }
  say('  Read docs/authority-split.md. It is the one your agent should read first.\n')
}

/** Write an approved plan and record what we wrote. Shared by init and upgrade. */
async function writePlan({ root, plan, manifest, doc }) {
  for (const e of plan.entries) {
    if (e.action === SKIP || e.action === UNCHANGED) continue
    const abs = join(root, e.path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, e.nextText, 'utf8')
    manifestStore.record(manifest, {
      path: e.path,
      kind: e.kind,
      blockId: e.blockId,
      contentHash: e.kind === 'block' ? e.interiorHash : hash(e.nextText),
    })
  }
  await manifestStore.save(root, manifest)
  if (doc) await answersStore.save(root, doc)
}

function renderDetection(d) {
  const rows = []
  const push = (k, v) => v && rows.push(`  ${k.padEnd(11)}${v}`)
  push('git', d.vcs?.isRepo ? `${d.vcs.branch || 'detached'}${d.vcs.dirty ? ' · dirty' : ' · clean'}${d.vcs.authors90d ? ` · ${d.vcs.authors90d} author(s)/90d` : ''}` : 'not a git repository')
  push('language', (d.stack?.languages || []).slice(0, 2).map((l) => `${l.name} ${l.pct}%`).join(', '))
  push('build', d.stack?.buildSystem)
  for (const k of ['test', 'lint', 'format', 'typecheck', 'build']) {
    push(k, d.commands?.[k]?.cmd)
  }
  push('ci', d.ci?.present ? (d.ci.providers || []).join(', ') || 'yes' : null)
  push('agents', selectAdapters(d).map((a) => a.label).join(', '))
  push('deploys to', (d.deploySurface || []).map((x) => x.kind).join(', '))
  return rows.length ? '\n' + rows.join('\n') : '\n  (nothing detected)'
}

function summarizeDetection(d) {
  return {
    languages: (d.stack?.languages || []).slice(0, 5),
    buildSystem: d.stack?.buildSystem ?? null,
    commands: d.commands ?? {},
    deploySurface: (d.deploySurface || []).map((x) => x.kind),
    at: new Date().toISOString(),
  }
}

function parseArgs(list) {
  const out = { command: null, dir: null, dryRun: false, yes: false, force: false, help: false, json: false, agent: false, strict: false, purge: false, with: [], wantsWith: false }
  for (const a of list) {
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--yes' || a === '-y') out.yes = true
    else if (a === '--force') out.force = true
    else if (a === '--json') out.json = true
    else if (a === '--agent') out.agent = true
    else if (a === '--strict') out.strict = true
    else if (a === '--purge') out.purge = true
    else if (a.startsWith('--with=')) out.with = a.slice(7).split(',').map((x) => x.trim()).filter(Boolean)
    else if (a === '--with') out.wantsWith = true
    else if (out.wantsWith) { out.with = a.split(',').map((x) => x.trim()).filter(Boolean); out.wantsWith = false }
    else if (a.startsWith('-')) { /* ignore unknown flags rather than dying */ }
    else if (!out.command) out.command = a
    else if (!out.dir) out.dir = a
  }
  return out
}

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../templates')
const RUNTIME_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../runtime')

/**
 * PreToolUse blocks a bad write before it lands; PostToolUse catches the
 * structural checks that need the finished file. Both invoke the VENDORED
 * runner, so the hooks keep working without this CLI installed.
 */
function claudeHookSettings() {
  const cmd = (mode) =>
    `node "$CLAUDE_PROJECT_DIR/.caselaw/bin/gate.mjs" --mode ${mode} --host claude --root "$CLAUDE_PROJECT_DIR"`
  const entry = (mode) => ({
    matcher: 'Edit|Write|MultiEdit',
    hooks: [{ type: 'command', command: cmd(mode), timeout: 30 }],
  })
  return { hooks: { PreToolUse: [entry('pre')], PostToolUse: [entry('post')] } }
}

/** Every file under templates/<sub>, as paths relative to that directory. */
async function templateFiles(sub) {
  const base = join(TEMPLATE_ROOT, sub)
  const out = []
  for (const entry of await readdir(base, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const abs = join(entry.parentPath ?? entry.path, entry.name)
    out.push(abs.slice(base.length + 1))
  }
  return out.sort()
}

const say = (s) => stdout.write(s + '\n')

main().catch((err) => {
  say(`\ncaselaw failed: ${err.message}`)
  if (process.env.CASELAW_DEBUG) say(String(err.stack))
  exit(1)
})
