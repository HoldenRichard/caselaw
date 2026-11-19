# re-derive-claims

**Trigger:** acting on a claim handed to you (a brief, a spec line, a remembered fact, an earlier note), or sending one out of the project (a README line, a store listing, a reply).

**Rule:** re-derive the claim from the product before you act on it or send it: find the line in the code, run the command, read the file. If it does not re-derive, stop and say so. Never build against a paraphrase or send a claim you carried rather than checked.

**Precedent:** a remembered claim, that every recent commit was signed, went to an outside reviewer as evidence; 345 of 347 were not (2026-08-16). [More](../PRECEDENT.md#re-derive-claims).

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_Caselaw default {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
