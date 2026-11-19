# times-come-from-the-clock

**Trigger:** writing a date or a time into a record: a changelog, a log, a release note, a file named by date.

**Rule:** take it from the clock in the same step (`date`), never from memory or an estimate. If the time is not known, write "unknown" or an honest bound ("before 22:31").

**Precedent:** estimated times were written into a review log as if read from a clock (2026-10-22). [More](../PRECEDENT.md#times-come-from-the-clock).

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Caselaw trigger {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
