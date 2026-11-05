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

import { writeFile, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as rules from '../core/rules.js'
import { ruleDirsFor, doctrineDirAt } from '../core/doctrine.js'
import * as gatesStore from '../core/gates.js'
import { MECHANISABLE, suggestKinds, buildGate, baselineDisposition, enforcementLine } from '../core/promote.js'
import { SKIPPED } from '../core/answers.js'
import * as answersStore from '../core/answers.js'
import { DEFAULTS } from '../core/defaults.js'
import { TRIGGERS } from '../core/triggers.js'
import { recordPersonalCatch, personalOff, PERSONAL_REPOS } from '../core/personal.js'
import { saveIncident, listIncidents, createIncidentFromGit, IncidentError } from '../core/incidents.js'
import {
  splitRuleAST,
  reconstituteRuleAST,
  calculateEditBudget,
  checkEditBudget,
  evaluatePareto,
  evaluateStage1,
  evaluateStage2,
  optimizeRuleIterative,
  ConstitutionError,
} from '../core/skillopt.js'

const pExecFile = promisify(execFile)

export const RULE_SUBCOMMANDS = ['propose', 'ratify', 'reject', 'adopt', 'promote', 'catch', 'demote', 'evolve', 'incident', 'list']

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
  if (sub !== 'list' && !args.name) {
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
      case 'catch': return await recordCatch(args, io)
      case 'demote': return await demote(args, io)
      case 'evolve': return await evolve(args, io)
      case 'incident': return await recordIncident(args, io)
      case 'list': return await listRulesCmd(args, io)
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
    say(`  No proposal named "${args.name}" in ${ruleDirsFor(doctrineDirAt(root)).proposed}/.`)
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
        prompt: `Ratify "${args.name}" into ${ruleDirsFor(doctrineDirAt(root)).active}/ as ${by}?`,
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
  if (r.merged.length) {
    say(`  Merged: ${r.merged.join(', ')} moved to ${ruleDirsFor(doctrineDirAt(root)).archive}/.`)
    await forgetGenerated(root, r.merged, say)
  }
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
    say(`  No proposal named "${args.name}" in ${ruleDirsFor(doctrineDirAt(root)).proposed}/.`)
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
 * A default or a triggered rule is generated from the answers; once it is
 * demoted or merged away, it comes out of them, or the next upgrade would put
 * it back in active/.
 */
async function forgetGenerated(root, names, say) {
  const doc = await answersStore.load(root).catch(() => null)
  if (!doc) return
  let changed = false
  const drop = (key, id) => {
    if (!Array.isArray(doc.answers[key]) || !doc.answers[key].includes(id)) return
    doc.answers[key] = doc.answers[key].filter((v) => v !== id)
    changed = true
  }
  for (const n of names) {
    const d = DEFAULTS.find((x) => x.name === n)
    const t = TRIGGERS.find((x) => x.rule === n)
    if (d) drop('harness.defaults', d.id)
    if (t) drop('harness.triggers', t.id)
  }
  if (changed) {
    await answersStore.save(root, doc)
    say('  Taken out of .caselaw/answers.json too, so an upgrade does not reinstall it.')
  }
}

/** Evidence, not authority: recording a catch moves nothing and widens nothing, so an agent may. */
async function recordCatch(args, { root, say }) {
  const o = args.opt || {}
  const what = o.what || (o.commit ? `commit ${o.commit.slice(0, 7)}: violation caught` : '')
  const r = await rules.recordCatch(root, args.name, { what, by: o.by || (await gitUserName(root)) || 'unknown' })
  say(`  Recorded in .caselaw/catches.jsonl (${r.at}).`)
  if (r.firstLocal) say(`  Its first catch here: written into ${r.path} as this project's own Origin.`)

  if (o.commit) {
    const badCommit = o.commit
    const goodCommit = o.fix || 'HEAD'
    try {
      const incId = `${args.name}-${badCommit.slice(0, 7)}`
      const inc = createIncidentFromGit(root, {
        id: incId,
        rule: args.name,
        positiveCommit: badCommit,
        negativeCommit: goodCommit,
        positiveDesc: o.what || `Catch recorded at ${r.at}`,
        negativeDesc: 'Clean fix commit',
        metadata: { author: o.by || (await gitUserName(root)) || null },
      })
      await saveIncident(root, inc)
      say(`  Captured contrastive incident fixture to .caselaw/incidents/${inc.id}.json`)
    } catch (err) {
      say(`  Note: could not capture incident fixture from git: ${err.message}`)
    }
  }

  // The owner's own record across their repositories (0.3), on this machine only.
  const active = (await rules.listRules(root)).active.find((x) => x.name === args.name)
  if (active && !personalOff()) {
    const p = await recordPersonalCatch({ root, at: r.at, rule: { name: args.name, trigger: active.parsed.trigger, rule: active.parsed.rule } })
    const repos = new Set((p?.catches || []).map((c) => c.repo)).size
    if (repos >= PERSONAL_REPOS) say(`  It has now caught failures in ${repos} of your repositories: your next \`caselaw init\` offers it as a personal default.`)
  }
  return 0
}

async function demote(args, { root, say, interactive, prompt }) {
  if (!interactive) {
    say('  Demoting a rule weakens enforcement, and that is a human\'s call. Run this yourself at a terminal.')
    return 1
  }
  const active = (await rules.listRules(root)).active.find((r) => r.name === args.name)
  if (!active) {
    say(`  No active rule named "${args.name}" in ${ruleDirsFor(doctrineDirAt(root)).active}/.`)
    return 1
  }
  if (!args.yes) {
    const p = prompt()
    try {
      const ok = await p.confirm({ prompt: `Move "${args.name}" back to ${ruleDirsFor(doctrineDirAt(root)).candidates}/? It stops being in force.`, default: false })
      if (ok !== true) { say('  Kept in force.'); return 1 }
    } finally {
      await p.close()
    }
  }
  const r = await rules.demote(root, args.name, { interactive: true, reason: args.opt.reason ?? null })
  say(`  ${r.from} -> ${r.to}  (demoted ${r.at}: ${r.reason})`)
  await forgetGenerated(root, [args.name], say)
  return 0
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
      : `  No active rule named "${args.name}" in ${ruleDirsFor(doctrineDirAt(root)).active}/.`)
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

async function recordIncident(args, { root, say }) {
  const o = args.opt || {}
  const ruleName = args.name
  const pos = o.positive
  const neg = o.negative
  if (!pos || !neg) {
    say(`  caselaw rule incident ${ruleName} needs both --positive <commit> and --negative <commit>.`)
    say('  - positive: broken commit that violated the rule (Positive Control: must fail)')
    say('  - negative: clean fix commit on the same files (Negative Control: must pass)')
    return 2
  }
  const id = o.id || `${ruleName}-${pos.slice(0, 7)}`
  try {
    const inc = createIncidentFromGit(root, {
      id,
      rule: ruleName,
      positiveCommit: pos,
      negativeCommit: neg,
      positiveDesc: o['positive-desc'] || o.why,
      negativeDesc: o['negative-desc'],
      metadata: { author: o.by },
    })
    const path = await saveIncident(root, inc)
    say(`  Recorded contrastive incident fixture to ${path}`)
    say(`  Positive control (${pos}): must be caught by rule`)
    say(`  Negative control (${neg}): must pass cleanly`)
    return 0
  } catch (err) {
    say(`  Failed to record incident: ${err.message}`)
    return 1
  }
}

async function evolve(args, { root, say, interactive }) {
  const ruleName = args.name
  const dir = doctrineDirAt(root)
  const dirs = ruleDirsFor(dir)
  const path = join(root, dirs.active, `${ruleName}.md`)
  let text = null
  try {
    text = await readFile(path, 'utf8')
  } catch {
    say(`  No active rule named "${ruleName}" at ${dirs.active}/${ruleName}.md.`)
    return 1
  }

  const incidents = await listIncidents(root, { rule: ruleName })
  if (!incidents.length) {
    say(`  No contrastive incidents recorded for "${ruleName}".`)
    say('  Record at least one pair before evolving:')
    say(`    caselaw rule incident ${ruleName} --positive <bad-commit> --negative <fix-commit>`)
    return 1
  }

  const ast = splitRuleAST(text)
  const o = args.opt || {}
  const candidatePath = o.candidate

  if (candidatePath) {
    let candidateText
    try {
      candidateText = await readFile(join(root, candidatePath), 'utf8')
    } catch {
      say(`  Could not read candidate file at ${candidatePath}.`)
      return 1
    }

    const candidateAST = splitRuleAST(candidateText)
    const stage1 = evaluateStage1({ ...candidateAST.mutable, raw: candidateText }, incidents)
    if (!stage1.pass) {
      say(`  Stage 1 Rejection: ${stage1.reason}`)
      return 1
    }

    const budgetRes = checkEditBudget(ast.mutable, candidateAST.mutable, { isCompression: Boolean(o.compress) })
    if (!budgetRes.allowed) {
      say(`  Learning-Rate Budget Rejection: ${budgetRes.reason}`)
      return 1
    }

    // Stage 2 verifier check using built-in verifier
    const stage2 = await evaluateStage2(candidateAST.mutable, incidents, async ({ fixture, control, diff }) => {
      const r = (candidateAST.mutable.rule || '').toLowerCase()
      const d = String(diff ?? '')
      const isPermissive = /\b(?:allow|allowed|permit|permitted|enable|enabled|may\s+use|can\s+use)\b/i.test(r)
      const hasProhibition = /\b(?:never|must\s+not|do\s+not|cannot|prohibit|forbidden|avoid|refuse|prevent)\b/i.test(r)
      const forbidsSweep = !isPermissive && hasProhibition && (r.includes('sweep') || r.includes('git add -a') || r.includes('git add .') || r.includes('stage') || r.includes('explicit'))
      const wouldFlag = forbidsSweep && /\bgit\s+add\s+(?:-A|--all|\.)(?=\s|$|[;&|\n])/.test(d)

      if (control === 'negative') {
        if (wouldFlag) return { verdict: 'FAIL', reason: 'False positive: flags clean negative control diff' }
        return { verdict: 'PASS' }
      }
      if (wouldFlag) return { verdict: 'FAIL', reason: 'violates explicit staging prohibition' }
      return { verdict: 'PASS' }
    })

    const pareto = evaluatePareto(
      { catchRate: stage2.catchRate, falsePositives: stage2.falsePositives, wordCount: candidateAST.totalWords },
      { catchRate: 1.0, falsePositives: 0, wordCount: ast.totalWords }
    )

    if (!pareto.accepted) {
      say(`  Pareto Gate Rejection: ${pareto.reason}`)
      return 1
    }

    // Structural A2 reconstitution: guarantees Origin and Catches remain intact
    const reconstituted = reconstituteRuleAST(ast, candidateAST.mutable)
    await writeFile(path, reconstituted, 'utf8')
    say(`  Evolved ${dirs.active}/${ruleName}.md:`)
    say(`    ${pareto.reason}`)
    return 0
  }

  // Run active iterative SkillOpt optimization loop when no candidate is passed
  const budget = calculateEditBudget(ast.mutableWords)
  const runnerOpt = o.runner || args.runner || null
  const useLLM = Boolean(o.llm || args.llm || runnerOpt)
  let runnerFn = null

  if (typeof runnerOpt === 'function') {
    runnerFn = runnerOpt
  } else if (typeof runnerOpt === 'string' && runnerOpt.trim()) {
    runnerFn = async ({ prompt }) => {
      const { spawnSync } = await import('node:child_process')
      const res = spawnSync(runnerOpt, { shell: true, input: prompt, encoding: 'utf8' })
      if (res.status !== 0) throw new Error(`LLM runner command failed (${res.status}): ${res.stderr || res.stdout}`)
      return res.stdout
    }
  }

  say(`SkillOpt Iterative Evolution Pass for "${ruleName}"`)
  say(`Current words: ${ast.totalWords} (mutable: ${ast.mutableWords}) | Edit budget: ${budget} words`)
  say(`Contrastive incident fixtures: ${incidents.length}`)
  if (useLLM) say(`LLM Runner: ${runnerOpt ? String(runnerOpt) : 'internal prompt bridge'}`)

  const res = await optimizeRuleIterative({
    ruleText: text,
    incidentFixtures: incidents,
    isCompression: Boolean(o.compress),
    useLLM,
    llmRunner: runnerFn,
    maxSteps: 4,
  })

  if (res.acceptedSteps.length > 0) {
    for (const step of res.acceptedSteps) {
      say(`  Step ${step.step}: [${step.mode}] ${step.reason}`)
    }
    await writeFile(path, res.bestRuleText, 'utf8')
    say(`  Evolved ${dirs.active}/${ruleName}.md: ${res.savedWords} words saved (${res.stats.initialWords} -> ${res.stats.finalWords}) across ${res.acceptedSteps.length} accepted step(s).`)
    return 0
  }

  if (res.rejectedBuffer.entries.length > 0) {
    say(`  Iterative optimization completed with 0 accepted edits:`)
    for (const rej of res.rejectedBuffer.entries) {
      say(`    - [Stage ${rej.stage} Rejection]: ${rej.failureReason}`)
    }
    say('')
  }
  say('To evaluate a specific candidate file:')
  say(`  caselaw rule evolve ${ruleName} --candidate <path-to-candidate.md>${o.compress ? ' --compress' : ''}`)
  return 0
}

export async function listRulesCmd(args, { root, say }) {
  const listed = await rules.listRules(root)
  const catches = await rules.readCatches(root)
  const catchesMap = new Map()
  for (const c of catches) {
    catchesMap.set(c.rule, (catchesMap.get(c.rule) || 0) + 1)
  }

  const enrichedActive = (listed.active || []).map((r) => ({
    ...r,
    trigger: r.parsed?.trigger || '',
    rule: r.parsed?.rule || '',
    catches: catchesMap.get(r.name) || 0,
    raw: r.raw || `${r.parsed?.trigger || ''} ${r.parsed?.rule || ''}`,
  }))

  const forOption = args.opt?.for || args.for
  const forPaths = typeof forOption === 'string'
    ? forOption.split(',').map((p) => p.trim()).filter(Boolean)
    : Array.isArray(forOption) ? forOption : null

  let results = enrichedActive
  if (forPaths && forPaths.length > 0) {
    results = rules.selectTriggeredRules(enrichedActive, forPaths)
  }

  if (args.json) {
    say(JSON.stringify(results, null, 2))
    return 0
  }

  if (results.length === 0) {
    say(forPaths ? `  No active rules triggered for: ${forPaths.join(', ')}` : '  No active rules.')
    return 0
  }

  say(forPaths ? `  Active rules triggered for ${forPaths.join(', ')} (${results.length}):` : `  Active rules (${results.length}):`)
  for (const r of results) {
    const c = r.catches ? ` [${r.catches} catch${r.catches === 1 ? '' : 'es'}]` : ''
    say(`    - ${r.name}${c}: ${r.trigger || '(no trigger)'}`)
  }
  return 0
}
