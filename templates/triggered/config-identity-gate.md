# config-identity-gate

**Trigger:** swapping, rotating, or verifying any credential or config artifact: API keys, service account files, signing assets, connection strings, one environment's config for another's.

**Rule:** gate every step on the artifact's identity, never on having performed the rotation. Record its identity (last four characters only, in anything committed or reported) and compare. A fresh download that still carries the old identity means the backend association never moved: do not swap it in; diagnose the association. "I clicked rotate" is not evidence that anything rotated.

**Precedent:** a fresh download after a key rotation still carried the old key (2026-07-19). [More](../PRECEDENT.md#config-identity-gate).

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Caselaw trigger {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
