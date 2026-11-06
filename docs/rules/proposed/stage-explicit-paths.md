# stage-explicit-paths

**Trigger:** staging or committing with a command that takes the whole tree: `git add -A`, `git add .`, `git add -u`, `git commit -a`.

**Rule:** stage the paths you changed, by name, because another agent or person works in this tree too. The gate `stage-explicit-paths` checks each shell command an agent runs in Claude Code before it runs, and warns on one that sweeps the tree; like every gate, it earns `block` on evidence. Other tools have no hook for it: there, one-writer-per-tree is the rule to follow.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-151 (the study's record, 2026-08-10): `git add -A` committed another writer's in-flight work. DEF-334 (the record, 2026-09-10): the ninth two-writer collision. DEF-335 (caselaw, 2026-09-10): another stream's tree-wide sweep committed caselaw's session log and nineteen ledger rows before they were approved.

**Enforcement:** machine:stage-explicit-paths

**Triggered:** T3, because this repository instructs 2 agent tools (Claude Code, AGENTS.md); proposed 2026-11-06 (caselaw 0.3)

---
_Proposed by caselaw trigger T3, because this repository has what the trigger looks for (above), on another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch stage-explicit-paths --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after 60 days of commits, `caselaw audit` asks whether this project needs it._
