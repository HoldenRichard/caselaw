# outward-actions-wait

**Trigger:** an action that leaves the project or cannot be undone: a push, a publish, a release, a store submission, a message or an email, a deletion, a payment or a paid API run.

**Rule:** prepare it, show exactly what will happen (what, where, what it costs), and wait for the human's yes. Words sent in the human's voice are theirs to write: say what the message must cover, and let them write it.

**Precedent:** a failing test was pushed to a public repository (2026-09-09). [More](../PRECEDENT.md#outward-actions-wait).

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_Caselaw default {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
