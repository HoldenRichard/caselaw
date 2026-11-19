# stop-the-chain-on-failure

**Trigger:** running steps where one depends on the one before: build then test, test then commit, check then push, `cd` then anything.

**Rule:** never let a step run after the step it depends on failed. Chain with `&&` or `set -e`, never `;` or a pipe that hides the exit status, and read a check's exit status before acting on its verdict.

**Precedent:** a `;`-chained archive reported success and produced nothing (2026-08-12). [More](../PRECEDENT.md#stop-the-chain-on-failure).

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_Caselaw default {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
