#!/usr/bin/env node
/**
 * harness — bootstrap a governance harness into a project.
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

const CLI_VERSION = '0.1.0'
const TEMPLATE_VERSION = '1.0'

const USAGE = `harness ${CLI_VERSION}

  harness init [dir]     interview this project and generate its governance
  harness detect [dir]   print what Stage 0 sees, and ask nothing
  harness --help

Options
  --dry-run              build and show the plan, write nothing
  --yes                  accept the plan without the final confirmation
  --force                overwrite content you have edited (read the diff first)
`

async function main() {
  const args = parseArgs(argv.slice(2))
  if (args.help || !args.command) return say(USAGE)

  switch (args.command) {
    case 'init': return cmdInit(args)
    case 'detect': return cmdDetect(args)
    default:
      say(`Unknown command "${args.command}".\n`)
      say(USAGE)
      exit(2)
  }
}

async function cmdDetect(args) {
  const root = resolve(args.dir || cwd())
  const report = await detect(root)
  say(JSON.stringify(report, null, 2))
}

async function cmdInit(args) {
  const root = resolve(args.dir || cwd())

  say(`\nharness ${CLI_VERSION} — ${root}`)
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
      say('    Refusing to write it. This is the rule the harness ships, applied to itself.')
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
  await answersStore.save(root, doc)

  say(`\n  Wrote ${plan.summary.willWrite} file(s).`)
  if (doc.unanswered.length) {
    say(`  ${doc.unanswered.length} question(s) unanswered — they are marked in the output, not guessed.`)
  }
  say('  Read docs/authority-split.md. It is the one your agent should read first.\n')
}

/** Everything init would write, as artifacts the plan can classify. */
async function buildArtifacts({ doc, detected }) {
  const out = []

  const { content } = await generateAuthoritySplit({
    answers: doc.answers,
    detected,
    projectName: doc.project?.name,
    now: new Date(doc.generatedAt),
  })
  out.push({ path: 'docs/authority-split.md', kind: 'file', body: content })

  const closeOut = await generateCloseOut({
    answers: doc.answers, detected, projectName: doc.project?.name,
  })
  out.push({ path: 'docs/close-out.md', kind: 'file', body: closeOut.content })

  // The case-law scaffolding ships verbatim: machinery, never content.
  // active/ is created EMPTY on purpose and says so; candidates/ are examples
  // that cannot be adopted without the adopter writing their own Origin.
  for (const rel of await templateFiles('rules')) {
    out.push({
      path: join('docs/rules', rel),
      kind: 'file',
      body: await readFile(join(TEMPLATE_ROOT, 'rules', rel), 'utf8'),
    })
  }

  const pointer = [
    '## How work is done here',
    '',
    'Read these before planning or editing. They are the authority; this block is a pointer.',
    '',
    '- `docs/authority-split.md` — what you can and cannot verify here. Read it first.',
    '- `docs/rules/active/` — case law. At session start, scan it and load every rule whose',
    '  Trigger matches this turn. Rules are trigger-scoped, never ambient.',
    '- `docs/close-out.md` — end a working session with this, including its rule-proposals line.',
    '',
    'At any catch with a proven root cause, draft a rule: `harness rule propose "<name>"`.',
    'You draft; you never ratify. Only a human moves a rule into active/.',
    '',
    'Generated by harness. Edit `.harness/answers.json` and re-run, not this block.',
  ].join('\n')

  for (const target of pointerTargets(detected)) {
    out.push({ path: target, kind: 'block', blockId: 'pointer', body: pointer, version: 1 })
  }

  // Adapter commands, only for the agent tools this project actually uses.
  // Writing a Claude Code command into a repo that has never seen Claude Code
  // is clutter, and clutter is how a harness starts getting deleted.
  if (pointerTargets(detected).includes('CLAUDE.md')) {
    for (const rel of await templateFiles('adapters/claude/commands')) {
      out.push({
        path: join('.claude/commands', rel),
        kind: 'file',
        body: await readFile(join(TEMPLATE_ROOT, 'adapters/claude/commands', rel), 'utf8'),
      })
    }
  }

  out.push({
    path: '.gitignore',
    kind: 'block',
    blockId: 'harness',
    version: 1,
    body: ['# Local gate telemetry — per-machine, never committed.', '.harness/gate-fires.jsonl'].join('\n'),
  })

  return out
}

/** Write to the agent files this project already uses; default to CLAUDE.md. */
function pointerTargets(detected) {
  const a = detected.agentConfig || {}
  const targets = []
  if (a.claudeMd) targets.push('CLAUDE.md')
  if (a.agentsMd) targets.push('AGENTS.md')
  return targets.length ? targets : ['CLAUDE.md']
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
  push('agents', Object.entries(d.agentConfig || {}).filter(([, v]) => v === true).map(([k]) => k).join(', '))
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
  const out = { command: null, dir: null, dryRun: false, yes: false, force: false, help: false }
  for (const a of list) {
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--yes' || a === '-y') out.yes = true
    else if (a === '--force') out.force = true
    else if (a.startsWith('-')) { /* ignore unknown flags rather than dying */ }
    else if (!out.command) out.command = a
    else if (!out.dir) out.dir = a
  }
  return out
}

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../templates')

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
  say(`\nharness failed: ${err.message}`)
  if (process.env.HARNESS_DEBUG) say(String(err.stack))
  exit(1)
})
