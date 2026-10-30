# stop-the-chain-on-failure

**Trigger:** running steps where one depends on the one before: build then test, test then commit, check then push, `cd` then anything.

**Rule:** never let a step run after the step it depends on failed. Chain with `&&` or `set -e`, never `;` or a pipe that hides the exit status, and read a check's exit status before acting on its verdict.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-202 (Kabu, 2026-08-12): a `;`-chained archive reported success and produced nothing, hours before a submission. DEF-325 (Reprompt, 2026-09-09): a failing test was pushed because the push was chained after it. DEF-337 (the study's record, 2026-09-10): an integrity check printed FAIL, and the chain committed and pushed anyway. DEF-224 (the record, 2026-08-14): a failed `cd` left the rest of a compound command running in the wrong repository.

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_A caselaw default ({{ id }}), in force from install on the precedent above, which is another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
