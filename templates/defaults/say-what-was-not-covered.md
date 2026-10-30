# say-what-was-not-covered

**Trigger:** reporting the result of any check, test run, audit or review.

**Rule:** say what it did not cover: the inputs it skipped, the files or cases it never reached, the parts that cannot run here. A gap left unsaid reads as a pass.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-447 (Stir, 2026-09-25): a check polled frames 500 to 680 of a recipe that ran to frame 745, so the step it waited for never ran. DEF-279 (Kabu's marketing pipeline, 2026-09-07): stills silently skipped the crop they declared. DEF-591 (the marketing pipeline, 2026-10-01): one agent's failure skipped two others without a word. And in caselaw itself, the DEF-274 re-score, round 4 (2026-10-30, docs/design/def-274-rescore-2026-10-30.md): a second CI system the tool never read was not said to be unread.

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_A caselaw default ({{ id }}), in force from install on the precedent above, which is another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
