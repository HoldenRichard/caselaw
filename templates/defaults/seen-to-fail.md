# seen-to-fail

**Trigger:** adding or changing a test, check, gate or script that decides pass or fail, or reporting that one passed.

**Rule:** a check counts once it has been seen to fail: break the thing it guards, or feed it a known-bad input, watch it fail, then restore. Report the verdict it reached and what it ran on, never "completed": a run that read nothing, or stopped part-way, is not a pass.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-521 (Kabu, 2026-09-25): a new test claimed to pin a behaviour it could not fail without. DEF-056 (Kabu's marketing pipeline, 2026-08-03): a copy check read zero inputs and printed that all its specs passed. DEF-591 (the marketing pipeline, 2026-10-01): a workflow reported "completed" after one agent's failure silently skipped two others. DEF-128 (the study's own record, 2026-08-10): an audit that died on a spend limit at 45 of 71 agents was about to be reported as finished.

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_A caselaw default ({{ id }}), in force from install on the precedent above, which is another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
