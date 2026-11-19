# spend-protocol

**Trigger:** a call to a paid or metered API: a model, a scraper, a media generator, anything billed per call or per unit.

**Rule:** before a run that spends: check the credentials work (stop and report on an error); read the live limit or balance; project the cost from the actual input (count, page size, length); open the input you are about to pay to process; then show the projection and wait for the human's yes.

**Precedent:** paid credits were spent animating the wrong source image (2026-08-02). [More](../PRECEDENT.md#spend-protocol).

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Caselaw trigger {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
