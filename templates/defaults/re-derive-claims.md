# re-derive-claims

**Trigger:** acting on a claim someone handed you (a brief, a spec line, a remembered fact, an earlier session's note), or sending one out of the project (a README line, a store listing, a reply, a submission).

**Rule:** re-derive the claim from the product before you act on it or send it: find the line in the code, run the command, read the file. If it does not re-derive, stop and say so. Never build against a paraphrase, and never send out a claim you carried rather than checked.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-216 (Kabu, 2026-08-16): an agent's memory said every recent commit was signed, and that was sent to an app reviewer as evidence; 345 of 347 were unsigned. DEF-748 (caselaw, 2026-10-30): this tool's own README said the app it came from had shipped to the App Store; it had been submitted, not accepted. DEF-145 (Kabu, 2026-08-10): the published Terms promised a purchase the build could not make. DEF-158 (Kabu's marketing pipeline, 2026-08-10): two deliverables dated their observations to days they did not happen. DEF-131 (Kabu's website, 2026-07-28): a brief's header and the ratified text it enclosed gave two different effective dates.

**Enforcement:** memory

**Default:** {{ id }}, active since {{ since }} (caselaw 0.3)

---
_A caselaw default ({{ id }}), in force from install on the precedent above, which is another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
