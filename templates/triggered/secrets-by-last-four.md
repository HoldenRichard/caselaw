# secrets-by-last-four

**Trigger:** writing anything that could carry a credential: a log, a report, a commit, a message, a rule's evidence.

**Rule:** name a secret by its last four characters only. Never paste a key, token or password into a file, a commit or a chat; if one lands there, treat it as leaked and rotate it, and confirm the rotation by the new secret's last four, not by having clicked rotate.

**Precedent:** a key believed rotated was byte-identical to the leaked one (2026-07-06). [More](../PRECEDENT.md#secrets-by-last-four).

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Caselaw trigger {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
