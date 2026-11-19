# retain-generation-records

**Trigger:** making or changing anything an outside authority may ask about: a shipped asset, a build, a store listing, the code it reviews.

**Rule:** keep the record of how it was made, when it is made: the prompt and tool for a generated asset, the commit and build for a submission, who or what wrote each part. Keep it in the repository, or name where it is kept. A gatekeeper asks after the fact, and an agent-written project cannot reconstruct its provenance on demand.

**Precedent:** an app icon's generation record was missing exactly when a store rejection asked about it (2026-08-16). [More](../PRECEDENT.md#retain-generation-records).

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Caselaw trigger {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
