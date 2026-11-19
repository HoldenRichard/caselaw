# one-writer-per-tree

**Trigger:** writing, staging or committing in a working tree that another agent, session or person may also be writing in.

**Rule:** one writer per working tree at a time. Run `git status` first; a path you did not touch that changes mid-turn is a reason to stop and ask, not to commit. Stage explicit paths, never `git add -A`, `git add .` or `git commit -a`. Never commit another writer's work under your message, or claim a verification from a build that compiled their uncommitted edits.

**Precedent:** `git add -A` committed another writer's unfinished work (2026-08-10). [More](../PRECEDENT.md#one-writer-per-tree).

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_Caselaw default {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
