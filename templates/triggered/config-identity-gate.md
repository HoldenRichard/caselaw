# config-identity-gate

**Trigger:** swapping, rotating, or verifying any credential or config artifact: API keys, service account files, signing assets, connection strings, one environment's config for another's.

**Rule:** gate every step on the artifact's identity, never on having performed the rotation. Record the identity (its last four characters in anything committed or reported) and compare it. A freshly downloaded artifact that still carries the old identity means the backend association never moved: stop, do not swap it in, and diagnose the association instead. "I clicked rotate" is not evidence that anything rotated.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-018 (Kabu, 2026-07-19): a fresh console download after a key rotation still carried the old key, because the app's config was never re-pointed; the identity check stopped the swap. DEF-008 (Kabu, 2026-07-06): a key believed rotated was byte-identical to the leaked one.

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Proposed by caselaw trigger {{ id }}, because this repository has what the trigger looks for (above), on another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
