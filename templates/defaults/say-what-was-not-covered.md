# say-what-was-not-covered

**Trigger:** reporting the result of any check, test run, audit or review.

**Rule:** say what it did not cover: the inputs it skipped, the files or cases it never reached, the parts that cannot run here. A gap left unsaid reads as a pass.

**Precedent:** a check polled only part of a recipe, so the step it waited for never ran, unsaid (2026-09-25). [More](../PRECEDENT.md#say-what-was-not-covered).

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_Caselaw default {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
