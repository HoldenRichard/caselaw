# stage-explicit-paths

**Trigger:** staging or committing with a command that takes the whole tree: `git add -A`, `git add .`, `git add -u`, `git commit -a`.

**Rule:** stage the paths you changed, by name, because another agent or person works in this tree too. The gate `stage-explicit-paths` checks each shell command an agent runs in Claude Code and warns on one that sweeps the tree; like every gate, it earns `block` on evidence. Other tools have no hook: there, follow one-writer-per-tree.

**Precedent:** `git add -A` committed another writer's unfinished work (2026-08-10). [More](../PRECEDENT.md#stage-explicit-paths).

**Enforcement:** machine:stage-explicit-paths

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Caselaw trigger {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
