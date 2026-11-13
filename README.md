# caselaw

[![npm version](https://img.shields.io/npm/v/caselaw.svg?color=24292e&label=npm)](https://www.npmjs.com/package/caselaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Case law for your codebase.** Set up project rules with your coding agent,
turn proven rules into gates, and audit both as the project changes.

In your coding agent's chat, say:

> Set up CaseLaw for this repo. Read the repo and ask me only what you can't
> infer, then show me the proposed setup.

The agent runs `npx caselaw init --draft` to prepare or resume the draft. It reads your repo for
build and test commands, CI, and publishing. If a decision remains, it asks a
short question in chat about the actual project. You approve one setup summary,
and the agent installs and checks the result.

The agent can resume a draft with `caselaw init --draft`, preview it with
`caselaw init --from-draft --dry-run`, then apply it with
`caselaw init --from-draft --yes` after chat approval. To answer the
questionnaire directly, use `npx caselaw init --interview`. About six minutes.

---

## It ships six rules, and earns the rest

That is the whole idea, so it goes first.

Every other tool in this space hands you a curated pack — someone else's rules,
someone else's incidents, arriving with no evidence attached. `caselaw` ships six
defaults and no more: each recurred in at least two of the projects it came from,
and each arrives with those incidents cited as its precedent. You choose which
are in force at install. A default's first catch in your repo becomes your own
Origin for it (`caselaw rule catch`); one that has caught nothing in 60 days of
commits, the audit asks about.

Everything else accumulates from things that actually went wrong in *your* repo,
each rule citing the commit that proved it. A rule without an incident behind it
is a superstition with a filename, and nobody enforces a rule they cannot trace.

Two universal rules ship as **candidates** — readable, adoptable, and not in
force. Adopting one requires writing your own Origin:

```
caselaw rule adopt rename-greps-the-tree --origin "PR #418: a rename missed two call sites"
```

If you cannot name a time it bit you, you do not need the rule yet.

## Define the agent's boundaries

Your agent should ask about the handoff the repo can't establish. For a mobile
app, that might be “CI runs the simulator tests. What still needs a real
iPhone, and what should you check on it?” It records whether each boundary is
**physical** (unreachable from here), **chosen** (reserved for a human), or
**untested** (still uncertain).

That third option is the one that matters. A silent misconfiguration reads
exactly like a permanent boundary, and boundaries do not get re-tested. Anything
you mark untested is written into `docs/authority-split.md` with a one-command
way to settle it and a date, and the audit fails when that date passes.

This came from a real incident: a months-long belief that an agent "could not
read the database" turned out to be a wrong `--dir` flag. Two long-open defects
closed the day someone tried it.

## The ladder

A rule starts as prose and earns enforcement:

| Rung | Form | How it still fails |
|---|---|---|
| memory | prose in `active/` | the agent forgets, silently, and only sometimes |
| checklist | a line in the close-out | a human has to actually run it |
| `machine:<id>` | a gate in `.caselaw/gates.json` | only catches what is expressible |

`caselaw rule promote <name>` walks a rule up. Gates are **born as warnings** and
earn `block` by demonstrably catching real violations; a gate that blocks work
which already existed gets disabled on day one.

## What lands in your repo

```
docs/
  authority-split.md      what you and your agent can each verify, and what a human still has to do
  close-out.md            the session template that asks for rules
  rules/                  README, template, the defaults and triggered rules you chose, 2 candidates
.caselaw/
  answers.json            your answers: edit this, not the docs
  gates.json              empty until a rule earns one
  bin/gate.mjs            vendored, zero-dependency
AGENTS.md                the shared entry point for any agent
```

Point any agent at the repository-root `AGENTS.md` if it doesn't load that file
automatically. It leads to the authority split, active rules, and session
close-out. If CaseLaw detects a tool with a built-in adapter, it also installs
a bridge to those same instructions. `caselaw upgrade` adds the shared entry
point to existing installs and updates unmodified bridges in place.

### Running gates from any agent

Run these commands from the repository root. They require Node.js and the
vendored runner installed by CaseLaw.

```sh
node .caselaw/bin/gate.mjs --mode staged  # check staged changes before committing
node .caselaw/bin/gate.mjs --mode all     # check the working tree, including in CI
```

To connect a tool's live hooks, invoke
`node .caselaw/bin/gate.mjs --host generic --mode pre` or `--mode post` and send
one JSON object on stdin. The caller can set `cwd` to the absolute working
directory of the operation. Relative paths resolve from that directory.

| When | Example stdin |
|---|---|
| Before a whole-file write | `{"path":"notes.md","content":"new file contents"}` |
| Before a partial edit | `{"path":"notes.md","fragments":["replacement text"]}` |
| Before a shell command | `{"command":"npm test"}` |
| After a write | `{"path":"notes.md"}` |

The runner evaluates the command string without executing it. A completed
evaluation returns JSON with `decision` (`allow` or `block`), a `reason` for
blocks, and `result` with findings and coverage. A pre-hook block exits 2.
A post-hook block exits 0 and reports a finding after the write has happened.
If the runner cannot evaluate the event, it may exit 0 without a JSON report.
Treat missing reports and degraded coverage as unchecked. Live hooks need
wiring in the calling tool. Staged and whole-tree checks run independently.

A tool that emits automatic context compaction events can call the same
runner with `--host generic --mode compact` and send
`{"trigger":"auto"}` (with an optional `cwd`). This records local optimizer
telemetry and makes no gate decision.

## Commands

| | |
|---|---|
| `caselaw init` | prepare setup for your coding agent |
| `caselaw check` | CI: are the committed docs still what the answers produce? |
| `caselaw upgrade` | re-render; never touches what you edited |
| `caselaw audit` | is the governance still true? |
| `caselaw doctor` | is any of this actually wired up? |
| `caselaw rule propose` · `caselaw rule ratify` · `caselaw rule reject` | an agent drafts; a human ratifies or rejects |
| `caselaw rule adopt` · `caselaw rule promote` | take a candidate with your own Origin; climb the ladder |
| `caselaw gate test` · `caselaw gate baseline` · `caselaw gate promote` | run one gate, run them all, warn → block on evidence |
| `caselaw review` | a review prompt for a **different** model; `--role refuter`, `verifier` or `judge` reviews one change against its claim, never the builder's reasoning |
| `caselaw optimize` | measure what a session loads; propose what to compact or trim, for a human to apply |
| `caselaw rule evolve` · `caselaw rule incident` | SkillOpt iterative rule evolution against contrastive incident fixtures |
| `caselaw rules` | list active rules triggered for specific paths (`--for <paths>`) |
| `caselaw gate synthesize` | synthesize a machine gate from contrastive incident fixtures |
| `caselaw closeout verify` | verify session close-out report against git status and authority split |
| `caselaw rule catch` · `caselaw rule demote` | record what a rule caught; move one back to candidates |
| `caselaw harness propose` · `caselaw harness apply` · `caselaw harness log` | the harness changing itself: an agent proposes with evidence; the bounds or a human apply; the log says whether it helped |
| `caselaw personal list` · `caselaw personal export` | your rules that caught failures across your repositories, kept on your machine; two or more, and your next install offers them |
| `caselaw eject` | remove the tooling, keep everything you wrote |

Evolution stages a proposal; it does not replace active case law. A human ratifies the
proposal, which checks the original version's hash and archives the superseded text.
An existing pending proposal is preserved rather than overwritten. Merge proposals retain
both parents' evidence and archive both parents when ratified.

Gate synthesis requires complete positive and negative file snapshots. Newly captured Git
incidents include these snapshots; older diff-only fixtures remain readable but cannot
certify a gate. Every control must explicitly cover the complete combined target-path set (use null
for absent files); incomplete cross-incident snapshots are refused. Repository Git metadata
is not valid snapshot input. The candidate runs against both snapshots through the installed
gate runtime before registration; a missing installed runner prevents certification. Existing gate IDs are never replaced by synthesis, including with `--force`.
The reported accuracy applies to recorded fixtures; it is not a guarantee for unseen changes.
Snapshots contain complete changed-file contents; inspect them before committing fixtures.

Rule transitions coordinate through a repository mutation lock. Run install, upgrade,
and eject with a single writer; generated harness lifecycle operations are not a
repository-wide transactional system. An interrupted mutation lock requires inspection
before retrying.

Every command a file in this repository names is checked against the dispatcher by a test. The
first public release advertised seven that did not exist.

## Properties worth knowing before you install it

**It shows every file before writing.** `--dry-run` writes nothing at all.

**It never overwrites what you edited.** Every generated file carries a content
hash; a hand-edited one is reported and skipped, not clobbered.

**Setup can resume.** Re-running draft setup keeps your answers in progress.

**Runtime checker failures report degraded coverage.** The hook runner avoids blocking
the workflow on its own failure. Governance mutations and certification instead refuse
missing evidence, conflicting artifacts, and unavailable evaluators. A degraded run
does not establish that a check passed.

**`eject` keeps your docs.** The doctrine is your own answers as prose and does
not need this tool to be useful. Only the machinery goes.

**One entry point and one gate runner.** The shared instructions and portable
hook interface work independently of editor or model. CaseLaw tests instruction
bridges for Claude Code, Cursor, and GitHub Copilot. Claude Code also has
built-in live hook wiring.

## Where it came from

Extracted from a five-month solo build of an iOS app submitted to the App
Store. The governance was not designed; it accreted, one rule at a time, each
after something broke. This is the portable half.

The name is the mechanism: rules with citations, precedent that accumulates, and
a human who ratifies.

## Requirements

Node 20+. Zero runtime dependencies. The docs layer keeps working if you
uninstall the CLI.

## License

MIT
