# outward-actions-wait

**Trigger:** an action that leaves the project or cannot be undone: a push, a publish, a release, a store submission, a message or an email, a deletion, a payment or a paid API run.

**Rule:** prepare it, show exactly what will happen (what, where, and what it costs), and wait for the human to say yes. Words sent in the human's voice are the human's to write: say what the message must cover, and let them write it.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-325 (Reprompt, 2026-09-09): a failing test was pushed to the public repository. DEF-069 (Kabu's marketing pipeline, 2026-08-02): paid credits were spent animating the wrong source image, which was picked without being opened. DEF-216 (Kabu, 2026-08-16): a false claim reached an outside reviewer. The study's correspondence ruling (2026-09-23): after a professor asked how much of the author's emails were AI-written, no agent writes messages the author sends as their own words.

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_A caselaw default ({{ id }}), in force from install on the precedent above, which is another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
