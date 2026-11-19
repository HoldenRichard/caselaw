/**
 * Per-command help, flag aliases, and the one-line mistakes an agent can fix
 * without reading the whole manual.
 *
 * In the 0.4.2 field test `caselaw rule propose --help` printed only the global
 * help, `rule promote` revealed its missing flags one error at a time
 * (`--paths`, then `--patterns`), and a singular `--pattern` dumped the entire
 * usage text. An agent drives this CLI by trial, so each trial has to teach it
 * the whole shape: every subcommand prints its own flags (required ones
 * marked) and a copy-pasteable example, missing flags are reported together,
 * and a near-miss names the flag it was close to.
 *
 * Every flag named here is checked against the parser by test/unit/cli-help.test.js.
 */

/** Spellings an agent will reach for, mapped to the flag the parser takes. */
export const FLAG_ALIASES = { pattern: 'patterns', path: 'paths', arg: 'args' }

/** The flag as the parser knows it: `_` as `-`, a singular spelled as its plural. */
export function canonicalFlag(key) {
  const k = String(key).replace(/_/g, '-')
  return FLAG_ALIASES[k] ?? k
}

/**
 * Flags a gate kind cannot be built without, in the order they are asked for.
 * `rule promote` reports every missing one together.
 */
export const REQUIRED_PROMOTE_FLAGS = {
  'banned-content': ['paths', 'patterns'],
  'required-content': ['paths', 'patterns'],
  'path-scope': ['paths'],
  'paired-edit': ['when', 'require'],
  shell: ['paths', 'command'],
  'cross-file': ['extract', 'assert'],
}

const PROMOTE_EXAMPLES = {
  'banned-content': 'caselaw rule promote <name> --kind banned-content --paths "src/**/*.js" --patterns "console.log" --message "Remove the debug logging" --yes',
  'required-content': 'caselaw rule promote <name> --kind required-content --paths "src/**/*.js" --patterns "re:^// Copyright" --message "Add the license header" --yes',
  'path-scope': 'caselaw rule promote <name> --kind path-scope --paths "generated/**" --message "Edit the generator, not its output" --yes',
  'paired-edit': 'caselaw rule promote <name> --kind paired-edit --when "db/schema.sql" --require "db/migrations/**" --message "A schema change needs a migration" --yes',
  shell: 'caselaw rule promote <name> --kind shell --paths "src/**" --command eslint --args "--max-warnings=0" --message "Fix the lint errors" --yes',
  'cross-file': 'caselaw rule promote <name> --kind cross-file --extract \'[...]\' --assert \'[...]\' --paths "src/**" --yes   (see runtime/schema/gates.schema.json)',
}

/** A complete `rule promote` command for this kind, ready to paste once its placeholders are replaced. */
export function promoteExample(kind, name) {
  return (PROMOTE_EXAMPLES[kind] || '').replace('<name>', name)
}

/** Every flag a promote of this kind is missing, with a command that supplies them all. */
export function missingPromoteFlags(kind, opt, name) {
  const missing = (REQUIRED_PROMOTE_FLAGS[kind] || []).filter((k) => !opt[k])
  if (!missing.length) return null
  const example = promoteExample(kind, name)
  return [
    `  caselaw rule promote ${name} --kind ${kind} still needs ${missing.map((k) => `--${k}`).join(' and ')} (not at a terminal, so nothing can ask).`,
    `  Pass them together, for example:`,
    `    ${example}`,
  ].join('\n')
}

const PROMOTE_FLAGS = [
  ['--kind <kind>', 'banned-content | required-content | cross-file | path-scope | paired-edit | shell', 'required without a terminal'],
  ['--paths <a,b>', 'globs the gate applies to', 'required by banned-content, required-content, path-scope, shell'],
  ['--patterns <a,b>', 'literals to ban or require; prefix a regex with re: (--pattern also works)', 'required by banned-content, required-content'],
  ['--message <text>', 'what the person the gate fires on should do', 'optional'],
  ['--command <exe> [--args <a,b>]', 'the executable and its arguments', 'required by shell'],
  ['--when <a,b> --require <a,b>', 'editing the first set needs a change to the second', 'required by paired-edit'],
  ['--extract <json> --assert <json>', 'see runtime/schema/gates.schema.json', 'required by cross-file'],
  ['--id <id>', 'the gate id (default: the rule name)', 'optional'],
  ['--yes', 'write it without asking', 'required without a terminal'],
  ['--dry-run', 'build and show the gate, write nothing', 'optional'],
]

/**
 * Each command and subcommand: usage, what it does, its flags as
 * [flag, meaning, 'required ...' | 'optional'], and examples. `{dir}` is the
 * repository's actual doctrine directory.
 */
const HELP = {
  init: {
    usage: 'caselaw init [dir]',
    about: 'Prepare setup for your coding agent. `--draft` writes .caselaw/draft.json for the agent to fill from the repository; `--from-draft` previews or applies it.',
    flags: [
      ['--draft', 'write or resume the agent\'s setup draft', 'optional'],
      ['--from-draft', 'preview or apply the filled draft (add --yes after the user approves in chat)', 'optional'],
      ['--dry-run', 'build and show the plan, write nothing', 'optional'],
      ['--yes', 'accept without the final confirmation', 'optional'],
      ['--interview', 'answer the questions at a terminal instead', 'optional'],
      ['--reconfigure', 'ask every question again, including answered ones', 'optional'],
      ['--with <a,b,c>', 'optional modules: decisions, glossary, known-issues', 'optional'],
      ['--doctrine-dir <dir>', 'where the doctrine goes (default docs/; governance/ when a tool owns docs/)', 'optional'],
      ['--force', 'overwrite content you edited (read the diff first)', 'optional'],
    ],
    examples: ['caselaw init --draft', 'caselaw init --from-draft --dry-run', 'caselaw init --from-draft --yes'],
  },
  check: { usage: 'caselaw check [dir]', about: 'CI: are the committed docs still what the answers produce?', flags: [['--strict', 'fail on files you edited too', 'optional']], examples: ['caselaw check --strict'] },
  upgrade: { usage: 'caselaw upgrade [dir]', about: 'Re-render from your answers at the current template.', flags: [['--dry-run', 'show the plan, write nothing', 'optional'], ['--yes', 'apply without asking', 'optional'], ['--force', 'overwrite content you edited', 'optional']], examples: ['caselaw upgrade --dry-run'] },
  doctor: { usage: 'caselaw doctor [dir]', about: 'Is any of this actually wired up?', flags: [], examples: ['caselaw doctor'] },
  eject: { usage: 'caselaw eject [dir]', about: 'Remove the tooling, keep everything you wrote.', flags: [['--purge', 'remove the generated docs too', 'optional'], ['--dry-run', 'show the plan, write nothing', 'optional'], ['--yes', 'apply without asking', 'optional']], examples: ['caselaw eject --dry-run'] },
  audit: { usage: 'caselaw audit [dir]', about: 'Is the governance in this repo still true?', flags: [['--json', 'machine-readable report', 'optional'], ['--agent', 'print a model-agnostic prompt for a second opinion', 'optional']], examples: ['caselaw audit', 'caselaw audit --json'] },
  review: {
    usage: 'caselaw review [dir]',
    about: 'Print a review prompt for a DIFFERENT model to run. With --role, the prompt for one role on one change.',
    flags: [
      ['--role <role>', 'refuter | verifier | judge', 'optional'],
      ['--claim <text>', 'what the change should do (the reviewer gets this, never the reasoning)', 'required with --role'],
      ['--base <ref>', 'review base...HEAD (default: the working tree against HEAD)', 'optional'],
      ['--builder <model>', 'who built it, so the reviewer can be someone else', 'optional'],
      ['--refuter <file> --verifier <file>', 'their answers, for --role judge', 'required with --role judge'],
    ],
    examples: ['caselaw review', 'caselaw review --role refuter --claim "the parser rejects empty input" --base main'],
  },
  optimize: { usage: 'caselaw optimize [dir]', about: 'Measure what a session loads, and propose what to compact or trim.', flags: [['--apply <id>', 'apply one proposal it printed (a human, at a terminal)', 'optional'], ['--dry-run', 'show, write nothing', 'optional'], ['--yes', 'apply without asking', 'optional']], examples: ['caselaw optimize'] },
  detect: { usage: 'caselaw detect [dir]', about: 'Print what Stage 0 sees (stack, commands, CI gates, local gates, publishing) as JSON, and ask nothing.', flags: [], examples: ['caselaw detect'] },
  rules: { usage: 'caselaw rules [dir]', about: 'List the active rules in {dir}/rules/active/, optionally only those whose trigger matches paths.', flags: [['--for <a,b>', 'only rules triggered by these paths', 'optional']], examples: ['caselaw rules --for src/api/handler.js'] },

  'rule propose': {
    usage: 'caselaw rule propose <name>',
    about: 'Draft a rule into {dir}/rules/proposed/<name>.md. An agent may do this; only a human ratifies it into {dir}/rules/active/.',
    flags: [
      ['--trigger <text>', 'the kind of work the rule fires on, never "always"', 'required without a terminal'],
      ['--rule <text>', 'one imperative sentence, and what to do when its check fails', 'required without a terminal'],
      ['--origin <text>', 'the incident in THIS project that proved it: a commit, a dated session, an issue ("unverified" says so honestly)', 'required without a terminal'],
      ['--enforcement <text>', 'how it is enforced (default: memory)', 'optional'],
    ],
    examples: ['caselaw rule propose lock-order --trigger "any change to the migration runner" --rule "Locate the quoted premise in the code first; if absent, stop and flag it" --origin "commit 3c6979d, the double-write incident"'],
  },
  'rule ratify': { usage: 'caselaw rule ratify <name>', about: 'Move a proposal from {dir}/rules/proposed/ into {dir}/rules/active/. A human, at a terminal; an agent cannot ratify its own proposal.', flags: [['--by <name>', 'who is ratifying (default: git user.name)', 'optional'], ['--yes', 'skip the final confirmation', 'optional']], examples: ['caselaw rule ratify lock-order'] },
  'rule reject': { usage: 'caselaw rule reject <name>', about: 'Drop a proposal from {dir}/rules/proposed/. A human, at a terminal.', flags: [['--reason <text>', 'why', 'optional'], ['--yes', 'skip the confirmation', 'optional']], examples: ['caselaw rule reject lock-order --reason "too broad"'] },
  'rule adopt': { usage: 'caselaw rule adopt <name>', about: 'Take a shipped candidate from {dir}/rules/candidates/ as a proposal, with your own Origin.', flags: [['--origin <text>', 'the incident in THIS project that proved it', 'required']], examples: ['caselaw rule adopt rename-greps-the-tree --origin "PR #418: a rename missed two call sites"'] },
  'rule promote': {
    usage: 'caselaw rule promote <name>',
    about: 'Turn the checkable part of an active rule in {dir}/rules/active/ into a gate that is born as a warning. The flags it needs depend on --kind; missing ones are reported together.',
    flags: PROMOTE_FLAGS,
    examples: Object.values(PROMOTE_EXAMPLES).slice(0, 3).map((e) => e.replace('<name>', 'no-console-log')),
  },
  'rule catch': {
    usage: 'caselaw rule catch <name>',
    about: 'Record that an active rule caught something. Evidence, not authority: an agent may.',
    flags: [['--what <text>', 'what it caught, with a commit, a date or an issue', 'required unless --commit'], ['--commit <sha>', 'the commit that violated the rule; also captures an incident fixture', 'optional'], ['--fix <sha>', 'the clean commit (default HEAD)', 'optional'], ['--by <name>', 'who (default: git user.name)', 'optional']],
    examples: ['caselaw rule catch lock-order --what "commit 9a1f2c3: a second writer, caught in review"'],
  },
  'rule demote': { usage: 'caselaw rule demote <name>', about: 'Move an active rule back to {dir}/rules/candidates/. A human, at a terminal.', flags: [['--reason <text>', 'why', 'optional'], ['--yes', 'skip the confirmation', 'optional']], examples: ['caselaw rule demote lock-order --reason "no longer applies"'] },
  'rule evolve': {
    usage: 'caselaw rule evolve <name>',
    about: 'Improve an active rule against its recorded incidents. Stages the result to {dir}/rules/proposed/ for a human to ratify.',
    flags: [['--candidate <path>', 'a rewritten rule to check against the incidents', 'optional'], ['--compress', 'optimize for the word budget', 'optional'], ['--llm', 'run model-driven proposal and verification', 'optional'], ['--runner <cmd>', 'command line for LLM completions', 'optional']],
    examples: ['caselaw rule evolve lock-order --candidate .caselaw/candidate.md'],
  },
  'rule incident': {
    usage: 'caselaw rule incident <name>',
    about: 'Record a contrastive incident: the commit that violated the rule and the clean fix, as test fixtures for the rule.',
    flags: [['--positive <commit>', 'the commit that violated the rule', 'required'], ['--negative <commit>', 'the clean fix commit on the same files', 'required'], ['--positive-desc <text>', 'what the bad commit did', 'optional'], ['--id <id>', 'fixture id', 'optional'], ['--by <name>', 'author', 'optional']],
    examples: ['caselaw rule incident lock-order --positive 3c6979d --negative 8be2f10'],
  },
  'rule list': { usage: 'caselaw rule list', about: 'List the active rules in {dir}/rules/active/.', flags: [['--for <a,b>', 'only rules triggered by these paths', 'optional']], examples: ['caselaw rule list'] },

  'gate test': { usage: 'caselaw gate test <id>', about: 'Run one gate over the whole tree and show what it would catch.', flags: [['--json', 'machine-readable output', 'optional']], examples: ['caselaw gate test no-console-log'] },
  'gate baseline': { usage: 'caselaw gate baseline', about: 'Run every gate over the whole tree.', flags: [['--json', 'machine-readable output', 'optional']], examples: ['caselaw gate baseline'] },
  'gate promote': { usage: 'caselaw gate promote <id>', about: 'Warn -> block, once the gate has earned it with recorded fires.', flags: [['--force', 'promote before it earned it', 'optional']], examples: ['caselaw gate promote no-console-log'] },
  'gate synthesize': { usage: 'caselaw gate synthesize <rule>', about: 'Build a machine gate for a rule from its recorded incidents and certify it against them.', flags: [['--yes', 'register the gate (or --apply)', 'optional']], examples: ['caselaw gate synthesize lock-order --yes'] },

  'harness propose': {
    usage: 'caselaw harness propose',
    about: 'A change to the harness itself, with evidence. An agent may propose; a human applies.',
    flags: [
      ['--set <key>=<n>', 'a setting: harness.load_budget, harness.demotion_days, authority.retest_days', 'one of --set --enable --disable --autonomy --note'],
      ['--enable <id>', 'put a default (D1-D6) or a trigger (T1-T7) in force', 'one of the five'],
      ['--disable <id>', 'take one out of force (always a human\'s)', 'one of the five'],
      ['--autonomy <preset>', 'ask-first | custom | tune-itself', 'one of the five'],
      ['--note <text>', 'a change made by hand, recorded', 'one of the five'],
      ['--why <text>', 'the local evidence, with a commit, a date or an issue', 'required'],
      ['--signal <name>', 'load-words | compactions | idle-borrowed', 'optional'],
      ['--window <days>', 'when to ask whether it helped (default 30)', 'optional'],
    ],
    examples: ['caselaw harness propose --set harness.load_budget=2500 --why "session load hit the budget on 2026-11-02" --signal load-words'],
  },
  'harness apply': { usage: 'caselaw harness apply <id>', about: 'Apply a proposed change. A human, at a terminal.', flags: [['--yes', 'skip the confirmation', 'optional']], examples: ['caselaw harness apply H-1'] },
  'harness reject': { usage: 'caselaw harness reject <id>', about: 'Reject a proposed change. A human, at a terminal.', flags: [], examples: ['caselaw harness reject H-1'] },
  'harness revert': { usage: 'caselaw harness revert <id>', about: 'Propose undoing an applied change.', flags: [['--why <text>', 'the evidence', 'optional']], examples: ['caselaw harness revert H-1'] },
  'harness log': { usage: 'caselaw harness log', about: 'Every change, and whether it helped.', flags: [], examples: ['caselaw harness log'] },

  'personal list': { usage: 'caselaw personal list', about: 'Your rules that caught something, across your repositories (this machine only).', flags: [], examples: ['caselaw personal list'] },
  'personal export': { usage: 'caselaw personal export <file>', about: 'The same, for sharing by hand: no paths, no repository names.', flags: [], examples: ['caselaw personal export my-rules.json'] },
  'closeout verify': { usage: 'caselaw closeout verify <file>', about: 'Verify a close-out report against git status and the authority split.', flags: [], examples: ['caselaw closeout verify close-out.md'] },
}

export const HELP_KEYS = Object.keys(HELP)

/** The help entry for a command (and subcommand), or null. */
export function helpEntry(command, sub = null) {
  return HELP[sub ? `${command} ${sub}` : command] ?? null
}

/** Every flag named in any help entry, as the parser spells it (for the parity test). */
export function helpFlagNames() {
  const names = new Set()
  for (const e of Object.values(HELP)) {
    for (const [flag] of e.flags) for (const m of flag.matchAll(/--([a-z][a-z-]*)/g)) names.add(m[1])
    for (const ex of e.examples) for (const m of ex.matchAll(/\s--([a-z][a-z-]*)/g)) names.add(m[1])
  }
  return [...names]
}

/**
 * The help text for one command or subcommand, or for a command with
 * subcommands when none is named. `dir` is the repository's doctrine directory.
 *
 * @param {string} command
 * @param {string|null} sub
 * @param {{dir: string, subs?: string[]}} opts
 * @returns {string|null} null when there is no such command or subcommand
 */
export function renderHelp(command, sub, { dir, subs = null } = {}) {
  const fill = (s) => s.replaceAll('{dir}', dir)
  if (subs && !sub) {
    const rows = subs.map((s) => `    caselaw ${command} ${s}`.padEnd(32) + fill(HELP[`${command} ${s}`]?.about.split('. ')[0].replace(/\.$/, '') ?? ''))
    return [`caselaw ${command} <subcommand>`, '', ...rows, '', `  caselaw ${command} <subcommand> --help prints that subcommand's flags and an example.`].join('\n')
  }
  const e = helpEntry(command, sub)
  if (!e) return null
  const out = [e.usage, '', `  ${fill(e.about)}`]
  if (e.flags.length) {
    out.push('', '  Flags')
    const width = Math.max(...e.flags.map(([f]) => f.length)) + 2
    for (const [flag, meaning, need] of e.flags) {
      out.push(`    ${flag.padEnd(width)}${meaning}${need === 'optional' ? '' : `  [${need}]`}`)
    }
  }
  out.push('', e.examples.length > 1 ? '  Examples' : '  Example', ...e.examples.map((x) => `    ${x}`))
  return out.join('\n')
}

/** Edit distance, for naming the flag a typo was nearest to. */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = keep
    }
  }
  return row[b.length]
}

/** The flag nearest to a mistyped one, preferring flags this command takes; null when nothing is close. */
export function closestFlag(typed, known, preferred = []) {
  const t = String(typed).replace(/^--/, '').replace(/_/g, '-').toLowerCase()
  let best = null
  for (const [rank, list] of [[0, preferred], [1, known]]) {
    for (const k of list) {
      const d = distance(t, k)
      const near = d <= Math.max(2, Math.floor(k.length / 3)) || (t.length >= 4 && (k.startsWith(t) || t.startsWith(k)))
      if (near && (!best || rank < best.rank || (rank === best.rank && d < best.d))) best = { k, d, rank }
    }
  }
  return best?.k ?? null
}

/** One line for the parser's rejects: what was wrong, the nearest valid flag, and where the flags are listed. */
export function unknownOptionLine(unknown, { known, command = null, sub = null }) {
  const preferred = [...(helpEntry(command, sub)?.flags ?? [])].flatMap(([f]) => [...f.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]))
  const parts = unknown.map((u) => {
    const missing = /^(--[^\s]+) \(missing its value\)$/.exec(u)
    if (missing) return `"${missing[1]}" needs a value`
    const near = closestFlag(u.split('=')[0], known, preferred)
    return `Unknown option "${u}"${near ? ` (did you mean --${near}?)` : ''}`
  })
  const where = command && helpEntry(command, sub) ? `caselaw ${[command, sub].filter(Boolean).join(' ')} --help` : 'caselaw --help'
  return `${parts.join('; ')}. Flags: ${where}`
}
