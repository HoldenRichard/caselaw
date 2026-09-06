# caselaw

**Case law for your codebase.** An interview that generates your project's own
rules, gates that earn their teeth, and an audit that keeps both honest.

```
npx caselaw init
```

About four minutes. It reads your repo first, asks only what it cannot detect, and
shows you every file before it writes anything.

---

## It ships zero rules

That is the whole idea, so it goes first.

Every other tool in this space hands you a curated pack — someone else's rules,
someone else's incidents, arriving with no evidence attached. `caselaw` creates
`docs/rules/active/` **empty**, with a file explaining why.

A rule without an incident behind it is a superstition with a filename. It costs
every future session the attention it takes to read, and nobody enforces a rule
they cannot trace. So rules accumulate here from things that actually went wrong
in *your* repo, each one citing the commit that proved it.

Five universal rules ship as **candidates** — readable, adoptable, and not in
force. Adopting one requires writing your own Origin:

```
caselaw rule adopt trace-the-premise --origin "PR #418: built against a spec line that did not exist"
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
  rules/                  README, template, EMPTY active/, 5 candidates
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
| `caselaw review` | a review prompt for a **different** model |
| `caselaw eject` | remove the tooling, keep everything you wrote |

Every command a file in this repository names is checked against the dispatcher by a test. The
first public release advertised seven that did not exist.

## Properties worth knowing before you install it

**It shows every file before writing.** `--dry-run` writes nothing at all.

**It never overwrites what you edited.** Every generated file carries a content
hash; a hand-edited one is reported and skipped, not clobbered.

**Re-runs are byte-identical.** Run `init` twice and the second is a no-op.

**It degrades rather than blocking.** A missing tool, malformed input, or a
broken config reports loudly and exits zero. A workflow gate that breaks the
workflow gets deleted within a day.

**`eject` keeps your docs.** The doctrine is your own answers as prose and does
not need this tool to be useful. Only the machinery goes.

**It is not Claude-only.** Claude Code, AGENTS.md, Cursor and Copilot, each with
a golden-render test. A tool counts as supported when a test renders it — this
list is generated from the test suite, not from optimism.

## Where it came from

Extracted from a five-month solo build of an iOS app that shipped to the App
Store. The governance was not designed; it accreted, one rule at a time, each
after something broke. This is the portable half.

The name is the mechanism: rules with citations, precedent that accumulates, and
a human who ratifies.

## Requirements

Node 20+. Zero runtime dependencies. The docs layer keeps working if you
uninstall the CLI.

## License

MIT
