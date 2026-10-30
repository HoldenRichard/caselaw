# secrets-by-last-four

**Trigger:** writing anything that could carry a credential: a log, a report, a commit, a message, a rule's evidence.

**Rule:** name a secret by its last four characters only. Never paste a key, token or password into a file, a commit or a chat; if one lands there, treat it as leaked and rotate it, and confirm the rotation by the new secret's last four, not by having clicked rotate.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-008 (Kabu, 2026-07-06): the API key in the app was byte-identical to a leaked key that internal notes said had been rotated. DEF-310 (Reprompt, 2026-09-09): a redacted key display overlapped its prefix and suffix on short keys and printed more of the key than intended.

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Proposed by caselaw trigger {{ id }}, because this repository has what the trigger looks for (above), on another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
