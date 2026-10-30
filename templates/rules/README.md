# Case law

Process rules mined from **this project's own verified incidents**. Not best practices, not
advice from the internet — rules that exist because something here broke, each one citing the
incident that proved it.

Three directories:

- **`active/`** — in force. Your agent loads any rule whose Trigger matches the work at hand.
  At install it holds the defaults you chose: rules that recurred across the projects caselaw
  came from, each citing those incidents as its **Precedent** until its first catch here writes
  your own Origin. Everything else in it was ratified from this project's own incidents.
- **`proposed/`** — drafted, awaiting a human. Agents write here; agents never move things out.
- **`candidates/`** — rules extracted from another project, kept as worked examples, and any
  rule demoted from active/. They are not in force until you adopt one and write your own
  Origin for it.

## The flow

- At any catch with a **proven** root cause, draft a candidate:
  `caselaw rule propose "<name>"`, and list it in the session close-out under "Rule proposals".
- A **human** ratifies (`caselaw rule ratify <name>`, moving it to `active/`) or rejects it.
  Only a human moves files between these directories. This is not a formality — a proposal is
  untrusted text that may have been drafted from something an agent read somewhere, and content
  must never be able to promote itself.
- Constraints, all three enforced by `caselaw rule` rather than by good intentions:
  - **Trigger-scoped only.** A rule fires on a describable kind of work, never ambiently. A rule
    that always applies is not a rule, it is a mood.
  - **Verified mechanisms only.** The Origin cites a real incident — a commit, a dated session,
    an issue. If you cannot name the incident, it is not a rule yet; it is a preference, and
    preferences belong in the discipline doc.
  - **One rule per file.**

## File format

Filename is the kebab-case rule name.

```markdown
# rule-name

**Trigger:** <the describable kind of work this fires on. Never "always".>

**Rule:** <one rule. Imperative. What to do, and what to do when it fails.>

**Origin:** <the incident that proved it. A commit SHA, a dated session, an issue.>

**Enforcement:** memory | checklist | machine:<gate-id>
```

## Enforcement is a ladder, and rules should climb it

| Rung | Form | Still fails how? |
|---|---|---|
| `memory` | prose in `active/` | the agent forgets — silently, and only sometimes |
| `checklist` | a line in the close-out | the human has to actually run it |
| `machine:<id>` | a gate in `.caselaw/gates.json` | only catches what is expressible |

A rule enforced by memory degrades without telling you. When one keeps getting violated, promote
it: `caselaw rule promote <name>` walks you through turning the checkable part into a gate. The
prose stays authoritative for the parts a gate cannot reach — promotion is not a claim that the
rule is now fully mechanised.

## Catches

When an active rule stops or catches something, record it:
`caselaw rule catch <name> --what "<what it caught, with a commit, a date or an issue>"`. A rule
counts once it has caught the failure it came from. A default's first catch here becomes this
project's own Origin for it; a default that has caught nothing in 60 days of commits is one the
audit asks about, because it came with another project's evidence. Demoting one is a human's
call: `caselaw rule demote <name>` moves it to candidates/, never deletes it.

## Retiring a rule

A rule is retired when **the thing it guards is gone** — the file, the pattern, the tool it was
about no longer exists. "Nothing has failed lately" is not grounds: a working rule erases its own
evidence, so the rules doing their job look exactly like the rules nobody needs.
