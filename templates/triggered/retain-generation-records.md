# retain-generation-records

**Trigger:** making or changing anything an outside authority may ask about: a shipped asset, a build, a store listing, the code it reviews.

**Rule:** keep the record of how it was made, at the time it is made: the prompt and the tool for a generated asset, the commit and build for a submission, who or what wrote each part. Keep it in the repository, or name where it is kept. A gatekeeper asks after the fact, and a project an agent wrote cannot reconstruct its own provenance on demand.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-222 (Kabu, 2026-08-16): an app icon and logo made with an image model in March had no generation record, so their origin was unrecoverable exactly when a spam rejection asked about it. DEF-216 (Kabu, 2026-08-16): the commit history offered as evidence of authorship turned out to be unsigned, 345 of 347 commits.

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Proposed by caselaw trigger {{ id }}, because this repository has what the trigger looks for (above), on another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
