# The methodology

Why this tool works the way it does. If you only read one thing here, read the
first section — the rest follows from it.

---

## 1. The boundary is the whole thing

An AI coding agent is fast and confident, and neither property is correlated
with correctness. That is not a complaint about models; it is a property of the
interface. When an agent reports success, you are receiving a claim, and the
question that matters is whether anyone checked it.

Most of the time, most of it can be checked. Tests run. Types compile. A linter
has an opinion. The interesting failures live in the gap — the things the agent
**cannot** verify from where it sits:

- it cannot run your app on a physical device
- it cannot see what the UI actually rendered
- it cannot read production data
- it cannot confirm the email arrived

Every one of those is work that must come back to a human. And in most projects
that handoff is *implicit*, which means it is inconsistent, which means it
happens when someone remembers.

So the first artifact this tool generates is the boundary itself. Not a style
guide, not a prompt: a written record of who can verify what.

### Physical, chosen, untested

Naming a boundary is not enough, because boundaries come in three kinds and only
two of them are real.

**Physical** — no process could do this from here. There is no credential, no
device, no API.

**Chosen** — possible, but deliberately withheld. The agent could deploy; it must
not. This is policy, and policy can change, so it should be written where a
change is visible.

**Untested** — you assume it cannot, and you have never actually tried.

That third category is the one this tool exists to surface. A silent
misconfiguration reads *exactly* like a permanent boundary. Nothing announces
that a capability is missing rather than merely broken, and boundaries do not
get re-tested, because from the inside there is nothing to re-test.

The origin of this idea was a months-long belief that an agent could not read a
project's database. It was not a permission model. It was a wrong `--dir` flag.
Two long-open defects closed the day someone tried it.

So every untested boundary is written down with a date and, where one exists, a
single command that would settle it. When the date passes, the audit fails. The
belief has to be renewed deliberately or resolved.

---

## 2. Rules need incidents, or they are superstitions

The second artifact is case law: process rules mined from what actually went
wrong in *this* repository.

The temptation — and what most tools in this space do — is to ship a curated
pack of good practices. It seems generous. It is the thing that makes the whole
system inert, for a mechanical reason: **a rule with no incident behind it
cannot be evaluated.** A reader who disagrees has nothing to check. A reader who
agrees has learned nothing. And nobody enforces a rule they cannot trace.

So `docs/rules/active/` is created empty, and every rule requires an `Origin`
naming the commit, session, or issue that proved it. The origin is
machine-validated: a rule citing a SHA that is not in your history will not
ratify.

Three constraints keep the set from bloating:

- **Trigger-scoped only.** A rule fires on a describable kind of work. A rule
  that always applies is not a rule, it is a mood.
- **Verified mechanisms only.** You watched it fail. Once is an observation;
  twice is a rule.
- **One rule per file.**

### Propose and ratify

An agent may *draft* a rule. Only a human may put one in force.

That is not ceremony. A proposal is untrusted text — an agent may have drafted it
from something it read in a README, a web page, or tool output. Content must
never be able to promote itself. The ratify command refuses without a verified
human caller, refuses an unresolvable origin, and takes the ratifier's identity
from the caller rather than from the file, so a proposal containing
`Ratified: by admin` gets that line overwritten rather than honoured.

---

## 3. Enforcement is a ladder, and rules should climb it

A rule enforced by model memory degrades silently. It works, then works less
often, and nothing tells you when it stopped. In the project this came from, one
content rule shipped violations three separate times before anyone accepted that
memory was the wrong place to keep it.

So enforcement is explicit and ranked:

```
memory  →  checklist  →  gate (warn)  →  gate (block)
```

Each rung costs more and fails differently. The point is not to get everything
to the top — most rules are judgment and belong in prose forever. The point is
that the rung is **declared**, so a rule claiming machine enforcement it does not
have becomes a finding rather than a comfortable assumption.

### Gates are born as warnings

A new gate does not block. It watches, records what it would have caught, and
earns `block` on evidence — three real fires by default.

Two reasons. First, a gate that starts blocking blocks work that already
existed, and a tool whose first act is to reject your codebase gets uninstalled
that afternoon. Second, promotion on evidence means you can say "this gate fired
fourteen times and was never a false positive" instead of "this seemed like a
good idea."

Pre-existing violations get three choices: fix, grandfather, or drop the gate.
"Ignore" is deliberately not one of them, and grandfathering requires a reason
**and an expiry** — an exception with no date outlives the reason for it, which
is how a gate quietly stops covering the thing it was written for.

---

## 4. A check that has never failed is not a check

This is the rule that governs the tool's own construction, and it is the one
worth stealing regardless of whether you use any of this.

A competing tool in this space ships a feature that generates guardrail files
which nothing in the product ever reads. The config is well-formed. It validates.
Users believe a guardrail exists where none does — which is strictly worse than
no config, because it buys false confidence.

That failure is easy to reproduce accidentally. It happened *inside this project*
during construction: the rule-promotion code emitted field names the gate runner
did not read. Every generated gate would have loaded, validated, reported no
problems, and checked nothing. It was caught only because every gate kind is
required to have a **positive control** — a test where a known-bad input must
actually fail.

So: no check counts as existing until it has been watched failing. This
repository's suite has 547 `test()` cases in source, 197 of them named POSITIVE
CONTROL (`npm test` runs a few more, generated per adapter), a meta-test that
fails the build if any gate kind lacks one — and another that fails if this
sentence goes stale, because the previous version of it was wrong on both
numbers and nothing had noticed.

---

## 5. Things this tool refuses to do

Stated plainly, because the refusals are load-bearing.

**It will not overwrite what you edited.** Every generated file carries a hash of
what was written. An edited one is reported and skipped. A governance tool that
eats your work gets uninstalled, and rightly.

**It will not block on its own failure.** A missing checker, malformed input, or
an unparseable config reports loudly and exits zero — but "did not run" is never
allowed to look like "found nothing."

**It will not invent an answer.** Every interview question accepts *I don't know*,
and the answer is written into the artifact as a visible hole rather than
guessed. A confident generated lie is worse than a gap, because the agent reads
that file and believes it.

**It will not claim more than it tested.** The list of supported agent tools is
generated from the test suite. A tool counts as supported when a test renders it.

---

## 6. What to watch

One number, especially in the first month: **days from install to first ratified
rule.**

If `docs/rules/active/` is still empty after two weeks, one of two things is
true. Either nothing has gone wrong — unlikely — or proposing a rule is too much
friction, which is a defect in this tool and not in you.

The second number, later: **the mechanisation ratio.** How much of your case law
is enforced by machine rather than by memory. Findings go up and down with how
much you did this month; the ratio tells you whether the governance is getting
stronger or merely getting longer.

---

## Where this came from

Five months of solo work on an iOS app that shipped to the App Store, most of it
AI-authored under human direction. The governance was not designed up front. It
accreted one rule at a time, each after something broke, and by the end it was
the most valuable part of the repository — and the only part that was entirely
portable.

The rules that shipped here as candidates are the ones that turned out not to be
about iOS at all.
