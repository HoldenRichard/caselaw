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
 *
 * Everything here returns an exit code instead of calling process.exit(), so
 * the dispatcher can be imported by a test — and it is: the test that matters
 * most asserts that every command a shipped string advertises is one this
 * file dispatches. The first public release advertised seven that were not.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, basename } from 'node:path'
import { argv, cwd, stdout, stdin } from 'node:process'
import { pathToFileURL } from 'node:url'

import { detect } from '../src/detect/index.js'
import { runInterview } from '../src/interview/runner.js'
import { ttyPrompt } from '../src/interview/prompt.js'
import * as answersStore from '../src/core/answers.js'
import * as manifestStore from '../src/core/manifest.js'
import { buildPlan, formatPlan, SKIP, UNCHANGED } from '../src/core/plan.js'
import { hash } from '../src/core/text.js'
import { scanMachinePaths } from '../src/core/secrets.js'
import { buildArtifacts } from '../src/generate/artifacts.js'
import { check, planUpgrade, planEject, applyEject, doctor } from '../src/commands/lifecycle.js'
import { buildReviewPrompt } from '../src/commands/review.js'
import { selectAdapters } from '../src/adapters/index.js'
import { gather } from '../src/audit/gather.js'
import { runChecks } from '../src/audit/checks.js'
import { formatReport, toJson, agentPrompt } from '../src/audit/report.js'
import { cmdRule, RULE_SUBCOMMANDS } from '../src/commands/rule.js'
import { cmdGate, GATE_SUBCOMMANDS } from '../src/commands/gate.js'

const require = createRequire(import.meta.url)

/**
 * Read from package.json, never hard-coded. 0.1.1 shipped with a CLI that
 * announced itself as 0.1.0 and stamped that into every manifest it wrote.
 */
export const CLI_VERSION = require('../package.json').version
const TEMPLATE_VERSION = '1.0'

/** The dispatch table. test/unit/cli-surface.test.js checks every advertised command against it. */
export const COMMANDS = {
  init: { help: 'interview this project and generate its governance' },
  check: { help: 'CI: are the committed docs still what the answers produce?' },
  upgrade: { help: 're-render from your answers at the current template' },
  doctor: { help: 'is any of this actually wired up?' },
  eject: { help: 'remove the tooling, keep everything you wrote' },
  audit: { help: 'is the governance in this repo still true?' },
  review: { help: 'print a review prompt for a DIFFERENT model to run' },
  detect: { help: 'print what Stage 0 sees, and ask nothing' },
  rule: { subs: RULE_SUBCOMMANDS, help: 'the case-law loop: draft, ratify, adopt, promote' },
  gate: { subs: GATE_SUBCOMMANDS, help: 'run a gate by hand; promote one that has earned it' },
}

export const BOOL_FLAGS = ['help', 'dry-run', 'yes', 'force', 'json', 'agent', 'strict', 'purge', 'reconfigure']
export const VALUED_FLAGS = [
  'with', 'origin', 'trigger', 'rule', 'enforcement', 'by', 'reason',
  'kind', 'id', 'paths', 'patterns', 'message', 'command', 'args', 'when', 'require', 'extract', 'assert',
]
export const KNOWN_FLAGS = [...BOOL_FLAGS, ...VALUED_FLAGS]

export const USAGE = `caselaw ${CLI_VERSION}

  caselaw init [dir]            interview this project and generate its governance
  caselaw check [dir]           CI: are the committed docs still what the answers produce?
  caselaw upgrade [dir]         re-render from your answers at the current template
  caselaw doctor [dir]          is any of this actually wired up?
  caselaw eject [dir]           remove the tooling, keep everything you wrote
  caselaw audit [dir]           is the governance in this repo still true?
  caselaw review [dir]          print a review prompt for a DIFFERENT model to run
  caselaw detect [dir]          print what Stage 0 sees, and ask nothing

  caselaw rule propose <name>   draft a rule into docs/rules/proposed/ (an agent may do this)
  caselaw rule ratify <name>    move a proposal into active/ — a human, at a terminal
  caselaw rule reject <name>    drop a proposal — also a human
  caselaw rule adopt <name>     take a shipped candidate, with --origin "<your own incident>"
  caselaw rule promote <name>   turn the checkable part of an active rule into a warn gate
  caselaw gate test <id>        run one gate over the whole tree and show what it would catch
  caselaw gate baseline         run every gate over the whole tree
  caselaw gate promote <id>     warn -> block, once the gate has earned it
  caselaw --help

Options
  --dry-run              build and show the plan, write nothing
  --yes                  accept without the final confirmation
  --force                overwrite content you edited (read the diff first); gate promote: before it earned it
  --json                 machine-readable output, for CI
  --agent                audit: print a model-agnostic prompt for a second opinion
  --strict               check: fail on files you edited too
  --with <a,b,c>         init: add optional modules: decisions, glossary, known-issues
  --reconfigure          init: ask every question again, including ones already answered
  --purge                eject: remove the generated docs too
  --origin <text>        rule adopt / rule propose: the incident in THIS project that proved it
  --trigger <text>       rule propose: the fields, when not answering at a terminal
  --rule <text>
  --by <name>            rule ratify: who is ratifying (default: git user.name)
  --reason <text>        rule reject: why
  --kind <kind>          rule promote: banned-content | required-content | cross-file |
                         path-scope | paired-edit | shell
  --paths <a,b>          rule promote: the globs the gate applies to
  --patterns <a,b>       rule promote: literals to ban or require (prefix a regex with re:)
  --message <text>       rule promote: what the person it fires on should do
  --command <exe>        rule promote (shell): the executable; --args <a,b> for its arguments
  --when <a,b>           rule promote (paired-edit): editing these… --require <a,b> …needs these
  --extract <json>       rule promote (cross-file): see runtime/schema/gates.schema.json; --assert <json>
  --id <id>              rule promote: the gate id (default: the rule name)
`

/**
 * @returns {Promise<number>} the exit code
 */
export async function main(list = argv.slice(2)) {
  const args = parseArgs(list)

  if (args.unknown.length) {
    // An unknown flag used to be ignored, so a documented-but-unimplemented
    // --emit ran the bare command, exited 0, and nothing told the reader the
    // flag had done nothing.
    say(`Unknown option ${args.unknown.map((u) => `"${u}"`).join(', ')}.\n`)
    say(USAGE)
    return 2
  }
  if (args.help || !args.command) {
    say(USAGE)
    return 0
  }

  const root = resolve(args.dir || cwd())

  switch (args.command) {
    case 'init': return cmdInit(args, root)
    case 'audit': return cmdAudit(args, root)
    case 'check': return cmdCheck(args, root)
    case 'upgrade': return cmdUpgrade(args, root)
    case 'doctor': return cmdDoctor(args, root)
    case 'eject': return cmdEject(args, root)
    case 'review': return cmdReview(args, root)
    case 'detect': return cmdDetect(args, root)
    case 'rule': return cmdRule(args, { root, say, interactive: isInteractive(), prompt: ttyPrompt })
    case 'gate': return cmdGate(args, { root, say })
    default:
      say(`Unknown command "${args.command}".\n`)
      say(USAGE)
      return 2
  }
}

async function cmdCheck(args, root) {
  const detected = await detect(root)
  const r = await check({ root, detected, strict: args.strict })

  if (!r.installed) {
    say('No caselaw install here; nothing to check.')
    return 0
  }

  for (const m of r.missing) say(`  MISSING   ${m.path}`)
  for (const st of r.stale) say(`  STALE     ${st.path}`)
  for (const d of r.diverged) say(`  DIVERGED  ${d.path}  ← ${d.reason}`)

  if (r.ok && !r.diverged.length) say('  Up to date. The committed docs are what the answers produce.')
  else if (r.ok) say(`\n  ${r.diverged.length} file(s) you edited. \`upgrade\` leaves those alone; --strict fails on them.`)
  else say('\n  Run `caselaw upgrade` to bring these back in line.')

  return r.ok ? 0 : 1
}

async function cmdUpgrade(args, root) {
  const detected = await detect(root)

  let planned
  try {
    planned = await planUpgrade({ root, detected, force: args.force })
  } catch (err) {
    say(`  ${err.message}`)
    return 1
  }
  const { doc, manifest, plan } = planned

  say('')
  say(formatPlan(plan, { root }))
  if (args.dryRun) {
    say('\n  --dry-run: nothing written.')
    return 0
  }
  if (plan.summary.willWrite === 0) {
    say('\n  Already up to date.')
    return 0
  }

  if (!args.yes) {
    const prompt = ttyPrompt()
    try {
      const okToWrite = await prompt.confirm({ prompt: 'Apply these changes?', default: false })
      if (okToWrite !== true) {
        say('  Aborted. Nothing written.')
        return 1
      }
    } finally {
      await prompt.close()
    }
  }

  await writePlan({ root, plan, manifest, doc })
  say(`\n  Updated ${plan.summary.willWrite} file(s).`)
  return 0
}

async function cmdDoctor(args, root) {
  const r = await doctor({ root })
  say('')
  for (const f of r.findings) {
    const mark = f.status === 'ok' ? '  ok  ' : f.status === 'warn' ? '  warn' : '  FAIL'
    say(`${mark}  ${f.name.padEnd(13)} ${f.detail}`)
    if (f.hint && f.status !== 'ok') say(`        ${' '.repeat(13)} ${f.hint}`)
  }
  say('')
  say(r.ok ? '  Wiring looks live.' : '  Something is configured but not working.')
  return r.ok ? 0 : 1
}

async function cmdEject(args, root) {
  let plan
  try {
    plan = await planEject({ root, purge: args.purge })
  } catch (err) {
    say(`  ${err.message}`)
    return 1
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

  if (args.dryRun) {
    say('\n  --dry-run: nothing removed.')
    return 0
  }
  if (!args.yes) {
    const prompt = ttyPrompt()
    try {
      const okToGo = await prompt.confirm({ prompt: 'Remove these?', default: false })
      if (okToGo !== true) {
        say('  Aborted. Nothing removed.')
        return 1
      }
    } finally {
      await prompt.close()
    }
  }

  const res = await applyEject({ root, plan })
  say(`\n  Removed ${res.removed.length}, stripped ${res.stripped.length}.`)
  if (res.left.length) say(`  Left ${res.left.length} file(s) you had edited.`)
  for (const f of res.failed) say(`  could not remove ${f.path}: ${f.reason}`)
  return 0
}

async function cmdAudit(args, root) {
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
  return result.ok ? 0 : 1
}

async function cmdReview(args, root) {
  const ctx = await gather(root)
  say(buildReviewPrompt({
    root,
    detected: await detect(root),
    answers: ctx.answers,
    rules: ctx.rules,
    gatesConfig: ctx.gatesConfig,
  }))
  return 0
}

async function cmdDetect(args, root) {
  const report = await detect(root)
  say(JSON.stringify(report, null, 2))
  return 0
}

async function cmdInit(args, root) {
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
    return 1
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
      // A dry run must not persist a single byte — not even the answers. The
      // interview used to write .caselaw/answers.json after every question
      // and then print "--dry-run: nothing written."
      persist: args.dryRun ? null : (d) => answersStore.save(root, d),
      reconfigure: args.reconfigure,
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
      return 1
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
    return 0
  }
  if (plan.summary.willWrite === 0) {
    say('\n  Already up to date.')
    return 0
  }
  if (!args.yes) {
    const ok = await prompt.confirm({ prompt: 'Write these files?', default: false })
    if (ok !== true) {
      say('  Aborted. Nothing written.')
      return 1
    }
  }

  await writePlan({ root, plan, manifest, doc })

  say(`\n  Wrote ${plan.summary.willWrite} file(s).`)
  if (doc.unanswered.length) {
    say(`  ${doc.unanswered.length} question(s) unanswered — they are marked in the output, not guessed.`)
  }
  say('  Read docs/authority-split.md. It is the one your agent should read first.\n')
  return 0
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

/**
 * Argument parsing. Unknown flags are collected, not ignored: the caller turns
 * them into an exit 2, because a flag that silently does nothing is how a
 * documented feature stays undocumented-as-missing for a whole release.
 */
export function parseArgs(list) {
  const out = {
    command: null, sub: null, name: null, dir: null,
    dryRun: false, yes: false, force: false, help: false, json: false, agent: false,
    strict: false, purge: false, reconfigure: false,
    with: [], opt: {}, unknown: [],
  }
  const positional = []
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--yes' || a === '-y') out.yes = true
    else if (a === '--force') out.force = true
    else if (a === '--json') out.json = true
    else if (a === '--agent') out.agent = true
    else if (a === '--strict') out.strict = true
    else if (a === '--purge') out.purge = true
    else if (a === '--reconfigure') out.reconfigure = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq)
      if (!VALUED_FLAGS.includes(key)) {
        out.unknown.push(a)
        continue
      }
      const value = eq === -1 ? list[++i] : a.slice(eq + 1)
      if (value === undefined) {
        out.unknown.push(`${a} (missing its value)`)
        continue
      }
      out.opt[key] = value
    } else if (a.startsWith('-')) out.unknown.push(a)
    else positional.push(a)
  }
  if (typeof out.opt.with === 'string') {
    out.with = out.opt.with.split(',').map((x) => x.trim()).filter(Boolean)
  }

  out.command = positional[0] ?? null
  if (out.command && COMMANDS[out.command]?.subs) {
    out.sub = positional[1] ?? null
    out.name = positional[2] ?? null
    out.dir = positional[3] ?? null
  } else {
    out.dir = positional[1] ?? null
  }
  return out
}

/** A human is present only when both ends of the conversation are a terminal. */
function isInteractive() {
  return Boolean(stdin.isTTY && stdout.isTTY)
}

const say = (s) => stdout.write(s + '\n')

// `import.meta.main` is Node >= 24. The realpath comparison covers 20 and 22,
// and follows the bin symlink npm installs — argv[1] is the link, import.meta.url
// is the real file.
const invokedDirectly = (() => {
  if (typeof import.meta.main === 'boolean') return import.meta.main
  try {
    return Boolean(argv[1]) && pathToFileURL(realpathSync(argv[1])).href === import.meta.url
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code ?? 0
    },
    (err) => {
      say(`\ncaselaw failed: ${err.message}`)
      if (process.env.CASELAW_DEBUG) say(String(err.stack))
      process.exitCode = 1
    },
  )
}
