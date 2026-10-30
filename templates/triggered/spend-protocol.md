# spend-protocol

**Trigger:** a call to a paid or metered API: a model, a scraper, a media generator, anything billed per call or per unit.

**Rule:** before a run that spends: check the credentials work, and stop and report on an error; read the live limit or balance; project the cost from the actual input (its count, its page size, its length); open the input you are about to pay to process; then show the projection and wait for the human's yes.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-069 (Kabu's marketing pipeline, 2026-08-02): credits were spent animating the wrong source image, picked by its timestamp instead of being opened. DEF-194 (the marketing pipeline, 2026-08-12): a scraper's default page size would have tripled the projected spend. DEF-195 (the marketing pipeline, 2026-08-12): one of two configured connectors had a dead token. DEF-128 (the study's record, 2026-08-10): an audit died on a spend limit at 45 of 71 agents.

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Proposed by caselaw trigger {{ id }}, because this repository has what the trigger looks for (above), on another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
