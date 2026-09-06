/**
 * `caselaw rule …` — the case-law loop, at the command line.
 *
 * The logic has lived in src/core/rules.js and src/core/promote.js since the
 * loop was built; what was missing was the dispatch. Every shipped document —
 * the README, the candidate footers, the close-out template, the pointer block
 * written into CLAUDE.md — told people to run these commands, and every one of
 * them exited 2 with "Unknown command". A tool whose own README example fails
 * is advertising a flywheel it does not have. So this file exists, and
 * test/unit/cli-surface.test.js asserts that every command a shipped string
 * names is one the CLI actually dispatches.
 *
 * Two boundaries survive the wiring intact:
 *   - `propose` and `adopt` run without a terminal — an agent drafts;
 *   - `ratify` and `reject` refuse without one — only a human promotes or drops.
 */

import { writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as rules from '../core/rules.js'
import * as gatesStore from '../core/gates.js'
import { MECHANISABLE, suggestKinds, buildGate, baselineDisposition, enforcementLine } from '../core/promote.js'
import { SKIPPED } from '../core/answers.js'

const pExecFile = promisify(execFile)

export const RULE_SUBCOMMANDS = ['propose', 'ratify', 'reject', 'adopt', 'promote']

const PROMPTS = {
  trigger: {
    id: 'rule.trigger',
    prompt: 'Trigger — what kind of work does this rule fire on?',
    help: 'A describable kind of work, never "always". A rule that always applies is a mood.',
    placeholder: 'e.g. any change to the migration runner',
  },
  rule: {
    id: 'rule.rule',
    prompt: 'Rule — one imperative sentence, and what to do when its check fails.',
    placeholder: 'e.g. locate the quoted premise in the code first; if it is absent, stop and flag it',
  },
  origin: {
    id: 'rule.origin',
    prompt: 'Origin — the incident that proved it: a commit SHA, a dated session, an issue, a URL.',
    help: 'If you cannot name the incident this is not a rule yet. Write "unverified" to say so honestly; it cannot be ratified until the citation is real.',
    placeholder: 'e.g. commit 3c6979d — the double-write incident',
  },
}

/**
 * @param {object} args parsed CLI args: { sub, name, opt, yes, dryRun, force }
 * @param {{root: string, say: (s: string) => void, interactive: boolean, prompt: () => object}} io
 * @returns {Promise<number>} the exit code
 */
export async function cmdRule(args, io) {
  const sub = args.sub
  if (!RULE_SUBCOMMANDS.includes(sub)) {
    io.say(`  caselaw rule needs one of: ${RULE_SUBCOMMANDS.join(', ')}.`)
    return 2
  }
  if (!args.name) {
    io.say(`  caselaw rule ${sub} needs a rule name (kebab-case).`)
    return 2
  }
  try {
    switch (sub) {
      case 'propose': return await propose(args, io)
      case 'ratify': return await ratify(args, io)
      case 'reject': return await reject(args, io)
      case 'adopt': return await adopt(args, io)
      case 'promote': return await promote(args, io)
    }
  } catch (err) {
    if (err instanceof rules.RuleError || err instanceof gatesStore.GateError || err?.code) {
      io.say(`  ${err.message}`)
      for (const p of err.problems ?? []) io.say(`    - ${p.message}`)
      if (err.hint) io.say(`    ${err.hint}`)
      return 1
    }
    throw err
  }
  return 2
}

async function propose(args, { root, say, interactive, prompt }) {
  const o = args.opt
  const fields = {
    name: args.name,
    trigger: o.trigger,
    rule: o.rule,
    origin: o.origin,
    enforcement: o.enforcement || 'memory',
  }
  const missing = ['trigger', 'rule', 'origin'].filter((k) => !fields[k])
  if (missing.length) {
    if (!interactive) {
      say(`  Not at a terminal: pass ${missing.map((k) => `--${k} "<text>"`).join(' ')} to draft "${args.name}".`)
      return 2
    }
    const p = prompt()
    try {
      for (const k of missing) {
        const v = await p.text(PROMPTS[k])
        fields[k] = v === SKIPPED ? '' : v
      }
    } finally {
      await p.close()
    }
  }

  const r = await rules.propose(root, fields)
  say(`  Drafted ${r.path}`)
  const code = reportProblems(say, r.validation.problems)
  say('')
  say(`  A human ratifies it: caselaw rule ratify ${r.name}`)
  return code
}

async function ratify(args, { root, say, interactive, prompt }) {
  if (!interactive) {
    say('  Ratification requires a human at a terminal. Run this yourself; an agent cannot ratify its own proposal.')
    return 1
  }
  const by = args.opt.by || (await gitUserName(root))
  if (!by) {
    say('  Cannot tell who is ratifying. Pass --by "<your name>" or set git user.name.')
    return 1
  }

  const proposal = (await rules.listRules(root)).proposed.find((r) => r.name === args.name)
  if (!proposal) {
    say(`  No proposal named "${args.name}" in ${rules.RULE_DIRS.proposed}/.`)
    return 1
  }
  say('')
  say(proposal.parsed.raw.trimEnd())
  say('')
  const errors = proposal.validation.problems.filter((p) => p.severity === 'error')
  if (errors.length) {
    say('  This cannot be ratified yet:')
    reportProblems(say, errors)
    return 1
  }

  if (!args.yes) {
    const p = prompt()
    try {
      const ok = await p.confirm({
        prompt: `Ratify "${args.name}" into ${rules.RULE_DIRS.active}/ as ${by}?`,
        default: false,
      })
      if (ok !== true) {
        say('  Not ratified. Nothing moved.')
        return 1
      }
    } finally {
      await p.close()
    }
  }

  const r = await rules.ratify(root, args.name, { interactive: true, ratifiedBy: by })
  say(`  ${r.from} -> ${r.to}  (ratified ${r.ratifiedAt} by ${r.ratifiedBy})`)
  for (const w of r.warnings) say(`  warn: ${w.message}`)
  say('')
  say(`  It is in force. When it keeps getting violated: caselaw rule promote ${r.name}`)
  return 0
}

async function reject(args, { root, say, interactive, prompt }) {
  if (!interactive) {
    say('  Rejecting a proposal requires a human at a terminal — deleting a draft on an agent\'s say-so is the mirror image of ratifying on one.')
    return 1
  }
  const proposal = (await rules.listRules(root)).proposed.find((r) => r.name === args.name)
  if (!proposal) {
    say(`  No proposal named "${args.name}" in ${rules.RULE_DIRS.proposed}/.`)
    return 1
  }
  if (!args.yes) {
    const p = prompt()
    try {
      const ok = await p.confirm({ prompt: `Delete ${proposal.path}?`, default: false })
      if (ok !== true) {
        say('  Kept.')
        return 1
      }
    } finally {
      await p.close()
    }
  }
  const r = await rules.reject(root, args.name, { interactive: true, reason: args.opt.reason ?? null })
  say(`  Removed ${r.path}${r.reason ? ` (${r.reason})` : ''}.`)
  return 0
}

async function adopt(args, { root, say }) {
  if (!args.opt.origin) {
    say(`  Adopting "${args.name}" needs your own Origin: --origin "<the incident in THIS project that proved it>"`)
    say("  Inheriting the upstream project's evidence is the cargo-culting this tool exists to prevent.")
    return 2
  }
  const r = await rules.adopt(root, args.name, { origin: args.opt.origin })
  say(`  ${r.from} -> ${r.path}`)
  const code = reportProblems(say, r.validation.problems)
  say('')
  say(`  It is a proposal now, not case law. A human ratifies it: caselaw rule ratify ${r.name}`)
  return code
}

/**
 * The ladder climber. Show-before-write applies to gates too: the gate is
 * built, run over the whole tree, and shown with what it would catch today
 * before anything is saved. It is always born `warn`.
 */
async function promote(args, io) {
  const { root, say, interactive, prompt } = io
  const o = args.opt

  const listed = await rules.listRules(root)
  const active = listed.active.find((r) => r.name === args.name)
  if (!active) {
    const proposed = listed.proposed.some((r) => r.name === args.name)
    say(proposed
      ? `  "${args.name}" is still a proposal. Ratify it first; only rules in force climb the ladder.`
      : `  No active rule named "${args.name}" in ${rules.RULE_DIRS.active}/.`)
    return 1
  }
  const parsed = active.parsed
  const current = String(parsed.enforcement ?? '').trim()
  if (/^machine:/i.test(current)) {
    say(`  "${args.name}" is already ${current}.`)
    return 1
  }

  const ranked = suggestKinds(parsed)
  let kind = o.kind
  if (!kind) {
    if (!interactive) {
      say(`  Not at a terminal: pass --kind <${MECHANISABLE.map((m) => m.kind).join('|')}>. Suggested for this rule: ${ranked[0].kind}.`)
      return 2
    }
    const p = prompt()
    try {
      const v = await p.select({
        id: 'promote.kind',
        prompt: `Which part of "${args.name}" is mechanically checkable?`,
        help: 'The prose stays authoritative for the rest; a gate catches the part that is expressible.',
        options: ranked.map((m) => ({ value: m.kind, label: `${m.kind} — ${m.question} (${m.example})` })),
      })
      if (v === SKIPPED) {
        say('  Nothing chosen. Nothing written.')
        return 1
      }
      kind = v
    } finally {
      await p.close()
    }
  }
  if (!MECHANISABLE.some((m) => m.kind === kind)) {
    say(`  Unknown gate kind "${kind}". One of: ${MECHANISABLE.map((m) => m.kind).join(', ')}.`)
    return 2
  }

  const answers = await collectAnswers(kind, o, io)
  if (!answers) return 2
  if (o.id) answers.id = o.id

  const built = buildGate({
    rule: { name: active.name, file: active.path, rule: parsed.rule, trigger: parsed.trigger },
    kind,
    answers,
  })
  if (!built.ok) {
    say('  This gate would not load, so it will not be written:')
    reportProblems(say, built.problems)
    return 1
  }
  const gate = built.gate

  // The repo's own vendored runner — the copy that will actually execute in
  // its hooks — gets the last word on whether this gate loads. The CLI-side
  // validator and the runtime have disagreed before (a shell command with
  // whitespace passed one and was silently dropped by the other), and a gate
  // that validates, is written, and checks nothing is the failure this whole
  // tool is aimed at.
  const runner = await loadRunner(root)
  const loaded = runner.validateGates({ version: 1, gates: [gate] })
  const dropped = loaded.problems.filter((p) => p.level === 'dropped')
  if (dropped.length || loaded.gates.length === 0) {
    say('  The vendored runner would drop this gate at load, so it will not be written:')
    for (const p of loaded.problems) say(`    - ${p.message}`)
    return 1
  }

  // Baseline: what would this gate catch TODAY?
  const res = await runner.evaluate({ root, mode: 'all', config: { version: 1, gates: [gate] }, telemetry: false })
  const disp = baselineDisposition(res.fires)

  say('')
  say(`  Gate "${gate.id}" (${gate.kind}, born warn):`)
  for (const line of JSON.stringify(gate, null, 2).split('\n')) say(`    ${line}`)
  say('')
  say(`  Baseline over the whole tree: ${disp.note}`)
  for (const f of res.fires.slice(0, 20)) say(`    ${f.path ?? '(no path)'}${f.line ? `:${f.line}` : ''}  ${f.detail}`)
  if (res.fires.length > 20) say(`    … ${res.fires.length - 20} more`)
  for (const r of res.degraded) for (const d of r.degradations) say(`    degraded: ${d.reason}${d.hint ? ` (${d.hint})` : ''}`)
  for (const p of res.config.problems.filter((x) => x.level !== 'defaulted')) say(`    config: ${p.message}`)

  if (disp.count > 0) {
    say('')
    say(`  ${disp.count} existing violation(s). Three choices, and "ignore" is not one of them:`)
    say('    fix them and re-run; or grandfather each one in .caselaw/gates.json with a `context`')
    say(`    (text near the match), a \`reason\` and an \`expires\` (suggested ${disp.suggestedExpiry}); or drop the gate.`)
    say('    Writing it now is also fine — it is a warn gate, and every one above is reported until it is fixed.')
  }

  if (args.dryRun) {
    say('')
    say('  --dry-run: nothing written.')
    return 0
  }
  if (!args.yes) {
    if (!interactive) {
      say('')
      say('  Pass --yes to write it, or run at a terminal.')
      return 2
    }
    const p = prompt()
    try {
      const ok = await p.confirm({ prompt: 'Write this gate and mark the rule machine-enforced?', default: false })
      if (ok !== true) {
        say('  Nothing written.')
        return 1
      }
    } finally {
      await p.close()
    }
  }

  const config = (await gatesStore.load(root)) ?? gatesStore.emptyConfig()
  if (config.gates.some((g) => g.id === gate.id)) {
    say(`  A gate "${gate.id}" already exists in ${gatesStore.GATES_PATH}. Pass --id <other-id> or retire it first.`)
    return 1
  }
  config.gates.push(gate)
  await gatesStore.save(root, config)

  const ruleText = rules.serializeRule({
    ...parsed,
    name: parsed.name || active.name,
    enforcement: enforcementLine(gate.id),
  })
  await writeFile(join(root, active.path), ruleText, 'utf8')

  say('')
  say(`  Wrote ${gatesStore.GATES_PATH} (+${gate.id}) and set ${active.path} to ${enforcementLine(gate.id)}.`)
  say(`  It warns until it has caught ${gatesStore.PROMOTION_THRESHOLD} real violations; then: caselaw gate promote ${gate.id}`)
  return 0
}

/** The fields each kind needs, from flags or from prompts. Returns null after explaining what is missing. */
async function collectAnswers(kind, o, { say, interactive, prompt }) {
  const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const toPattern = (s) => (s.startsWith('re:') ? { regex: s.slice(3), label: s.slice(3) } : { literal: s, label: s })
  const answers = { message: o.message }

  let p = null
  const ask = async (key, q) => {
    if (o[key]) return o[key]
    if (!interactive) {
      say(`  Not at a terminal: pass --${key} ${q.placeholder ? `"${q.placeholder}"` : '<value>'}.`)
      return null
    }
    p ??= prompt()
    const v = await p.text({ id: `promote.${key}`, ...q })
    return v === SKIPPED ? '' : v
  }

  try {
    switch (kind) {
      case 'banned-content':
      case 'required-content': {
        const paths = await ask('paths', { prompt: 'Which files? (comma-separated globs)', placeholder: 'src/**/*.js' })
        if (paths === null) return null
        const patterns = await ask('patterns', {
          prompt: kind === 'banned-content' ? 'What must never appear? (comma-separated literals; prefix a regex with re:)' : 'What must always be present? (comma-separated literals; prefix a regex with re:)',
          placeholder: 'console.log',
        })
        if (patterns === null) return null
        answers.paths = list(paths)
        answers.patterns = list(patterns).map(toPattern)
        break
      }
      case 'path-scope': {
        const paths = await ask('paths', { prompt: 'Which paths must nothing write to? (comma-separated globs)', placeholder: 'generated/**' })
        if (paths === null) return null
        answers.paths = list(paths)
        break
      }
      case 'paired-edit': {
        const when = await ask('when', { prompt: 'Editing files matching which globs…', placeholder: 'db/schema.sql' })
        if (when === null) return null
        const require = await ask('require', { prompt: '…requires a change to files matching which globs, in the same change?', placeholder: 'db/migrations/**' })
        if (require === null) return null
        answers.paths = list(when)
        answers.pairedWith = list(require)
        break
      }
      case 'shell': {
        const paths = await ask('paths', { prompt: 'Which files does the command check? (comma-separated globs)', placeholder: 'src/**' })
        if (paths === null) return null
        const command = await ask('command', { prompt: 'The executable (no arguments here; a bare name or a path)', placeholder: 'eslint' })
        if (command === null) return null
        answers.paths = list(paths)
        answers.command = String(command).trim()
        answers.args = list(o.args)
        break
      }
      case 'cross-file': {
        if (!o.extract || !o.assert) {
          say('  cross-file gates take --extract \'<json array>\' and --assert \'<json array>\' (see runtime/schema/gates.schema.json). The interactive form is not built yet.')
          return null
        }
        try {
          answers.extract = JSON.parse(o.extract)
          answers.assert = JSON.parse(o.assert)
        } catch (err) {
          say(`  --extract / --assert must be JSON: ${err.message}`)
          return null
        }
        answers.paths = list(o.paths)
        break
      }
      default:
        return null
    }
    if (!answers.message) {
      const m = interactive ? await ask('message', { prompt: 'What should the person it fires on DO? (one line; blank for the rule\'s first sentence)' }) : ''
      if (m) answers.message = m
    }
  } finally {
    if (p) await p.close()
  }
  return answers
}

/** Print validation problems; 1 if any is an error, else 0. */
function reportProblems(say, problems = []) {
  for (const p of problems) {
    say(`    ${p.severity === 'error' ? 'error' : 'warn '}: ${p.message}`)
    if (p.hint) say(`           ${p.hint}`)
  }
  return problems.some((p) => p.severity === 'error') ? 1 : 0
}

async function gitUserName(root) {
  try {
    const { stdout } = await pExecFile('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8' })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** The repo's own vendored runner — the copy its hooks execute. */
async function loadRunner(root) {
  const p = join(root, '.caselaw/bin/gate.mjs')
  try {
    await stat(p)
  } catch {
    throw new gatesStore.GateError('No vendored runner at .caselaw/bin/gate.mjs. Run `caselaw upgrade` to restore it.', { code: 'NO_RUNNER' })
  }
  return import(pathToFileURL(p).href)
}
