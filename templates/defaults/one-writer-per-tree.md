# one-writer-per-tree

**Trigger:** writing, staging or committing in a working tree that another agent, session or person may also be writing in.

**Rule:** one writer per working tree at a time. Run `git status` before you start, and treat any path you did not touch that changes mid-turn as a reason to stop and ask, not to commit. Stage explicit paths: never `git add -A`, `git add .` or `git commit -a`. Never commit another writer's work under your message, and never claim a verification from a build that compiled their uncommitted edits.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-151 (the study's record, 2026-08-10): `git add -A` committed another writer's in-flight work. DEF-215 (the record, 2026-08-12): a session log was lost to a same-filename collision between two agents. DEF-334 (the record, 2026-09-10): the ninth two-writer collision. DEF-335 (caselaw, 2026-09-10): caselaw's session log and nineteen ledger rows were committed by another stream's tree-wide sweep before they were approved.

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_A caselaw default ({{ id }}), in force from install on the precedent above, which is another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
