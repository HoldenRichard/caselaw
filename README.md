# caselaw

**Case law for your codebase.** An interview that generates your project's own
rules, gates that earn their teeth, and an audit that keeps both honest.

```
npx caselaw init
```

About six minutes. It reads your repo first, asks only what it cannot detect, and
shows you every file before it writes anything.

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

## The question nobody else asks

The interview's first real question is:

> **What can your agent NOT do or observe in this project without you?**

And then, for each thing you name:

> Is that boundary **physical** (no process could), **chosen** (possible, but it
> must not), or **untested** (you assume so, and never checked)?

That third option is the one that matters. A silent misconfiguration reads
exactly like a permanent boundary, and boundaries do not get re-tested. Anything
you mark untested is written into `docs/authority-split.md` with a one-command
way to settle it and a date — and the audit fails when that date passes.

This came from a real incident: a months-long belief that an agent "could not
read the database" turned out to be a wrong `--dir` flag. Two long-open defects
closed the day someone tried it.

## The ladder

A rule starts as prose and earns enforcement:

| Rung | Form | How it still fails |
|---|---|---|
| memory | prose in `active/` | the agent forgets — silently, and only sometimes |
| checklist | a line in the close-out | a human has to actually run it |
| `machine:<id>` | a gate in `.caselaw/gates.json` | only catches what is expressible |

`caselaw rule promote <name>` walks a rule up. Gates are **born as warnings** and
earn `block` by demonstrably catching real violations — a gate that blocks work
which already existed gets disabled on day one.

## What lands in your repo

```
docs/
  authority-split.md      what you and your agent can each verify, and what a human still has to do
  close-out.md            the session template that asks for rules
  rules/                  README, template, the defaults and triggered rules you chose, 2 candidates
.caselaw/
  answers.json            your answers — edit this, not the docs
  gates.json              empty until a rule earns one
  bin/gate.mjs            vendored, zero-dependency
CLAUDE.md / AGENTS.md     a pointer block, not a copy of the doctrine
```

Only for the agent tools you already use. A Cursor project gets a `.mdc` rule
file and no `.claude/` directory.

## Commands

| | |
|---|---|
| `caselaw init` | interview and generate |
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

**Re-runs are byte-identical.** Run `init` twice and the second is a no-op.

**Runtime checker failures report degraded coverage.** The hook runner avoids blocking
the workflow on its own failure. Governance mutations and certification instead refuse
missing evidence, conflicting artifacts, and unavailable evaluators. A degraded run
does not establish that a check passed.

**`eject` keeps your docs.** The doctrine is your own answers as prose and does
not need this tool to be useful. Only the machinery goes.

**It is not Claude-only.** Claude Code, AGENTS.md, Cursor and Copilot, each with
a golden-render test. A tool counts as supported when a test renders it — this
list is generated from the test suite, not from optimism.

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
