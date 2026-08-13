# Case law

Process rules mined from **this project's own verified incidents**. Not best practices, not
advice from the internet — rules that exist because something here broke, each one citing the
incident that proved it.

Three directories:

- **`active/`** — ratified. In force. Your agent loads any rule whose Trigger matches the work
  at hand. It starts empty, on purpose: see `active/WHY-THIS-IS-EMPTY.md`.
- **`proposed/`** — drafted, awaiting a human. Agents write here; agents never move things out.
- **`candidates/`** — five rules extracted from another project, kept as worked examples. They
  are not in force and never will be until you adopt one and write your own Origin for it.

## The flow

- At any catch with a **proven** root cause, draft a candidate:
  `harness rule propose "<name>"`, and list it in the session close-out under "Rule proposals".
- A **human** ratifies (`harness rule ratify <name>`, moving it to `active/`) or rejects it.
  Only a human moves files between these directories. This is not a formality — a proposal is
  untrusted text that may have been drafted from something an agent read somewhere, and content
  must never be able to promote itself.
- Constraints, all three enforced by `harness rule` rather than by good intentions:
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
| `machine:<id>` | a gate in `.harness/gates.json` | only catches what is expressible |

A rule enforced by memory degrades without telling you. When one keeps getting violated, promote
it: `harness rule promote <name>` walks you through turning the checkable part into a gate. The
prose stays authoritative for the parts a gate cannot reach — promotion is not a claim that the
rule is now fully mechanised.

## Retiring a rule

A rule is retired when **the thing it guards is gone** — the file, the pattern, the tool it was
about no longer exists. "Nothing has failed lately" is not grounds: a working rule erases its own
evidence, so the rules doing their job look exactly like the rules nobody needs.
