# seen-to-fail

**Trigger:** adding or changing a test, check, gate or script that decides pass or fail, or reporting that one passed.

**Rule:** a check counts once it has been seen to fail: break the thing it guards, or feed it a known-bad input, watch it fail, then restore. Report the verdict it reached and what it ran on, never "completed": a run that read nothing, or stopped part-way, is not a pass.

**Precedent:** a new test claimed to pin a behaviour it could not fail without (2026-09-25). [More](../PRECEDENT.md#seen-to-fail).

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_Caselaw default {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
