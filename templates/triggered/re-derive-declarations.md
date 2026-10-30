# re-derive-declarations

**Trigger:** a release, a store submission, or an edit to a surface that makes claims in public: a README's numbers, a privacy policy, a store listing, a website.

**Rule:** before it goes out, re-run the re-derive command of every claim it touches in `docs/declarations.md`, and update that claim's checked date. A claim whose command fails, or that has none, does not go out as true: fix the claim or the product first.

**Precedent:** In the study caselaw came from (ids are rows of its defect ledger): DEF-217 (Kabu, 2026-08-13): a public README claimed 125 quiz questions for two months; there were 85. DEF-184 (Kabu, 2026-08-11): the published privacy label contradicted the app's own manifest and both copies of its privacy policy. DEF-145 (Kabu, 2026-08-10): the published Terms promised a purchase the build could not make. DEF-748 (caselaw, 2026-10-30): this tool's README said its source app had shipped to the App Store.

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Proposed by caselaw trigger {{ id }}, because this repository has what the trigger looks for (above), on another project's evidence, not yours. Its first catch here becomes this project's own Origin: `caselaw rule catch {{ name }} --what "<what it caught, with a commit, a date or an issue>"`. If it has caught nothing after {{ days }} days of commits, `caselaw audit` asks whether this project needs it._
