# times-come-from-the-clock

**Trigger:** writing a date or a time into a record: a changelog, a log, a release note, a file named by date.

**Rule:** take it from the clock in the same step (`date`), never from memory or an estimate. If the time is not known, write "unknown" or an honest bound ("before 22:31").

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-659 (the study's record, 2026-10-22): estimated times were written into a review log as if read from a clock. DEF-664 (the record, 2026-10-23): a "last updated" time was typed ahead of the clock read in the same step. DEF-158 (Kabu's marketing pipeline, 2026-08-10): two deliverables dated their observations to days they did not happen.

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Proposed by caselaw trigger {{ id }}, because this repository has what the trigger looks for (above), on another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
