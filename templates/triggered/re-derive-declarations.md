# re-derive-declarations

**Trigger:** a release, a store submission, or an edit to a surface that makes claims in public: a README's numbers, a privacy policy, a store listing, a website.

**Rule:** before it goes out, re-run the re-derive command of every claim it touches in `docs/declarations.md`, and update that claim's checked date. A claim whose command fails, or that has none, does not go out as true: fix the claim or the product first.

**Precedent:** a public README claimed 125 quiz questions for two months; there were 85 (2026-08-13). [More](../PRECEDENT.md#re-derive-declarations).

**Enforcement:** memory

**Triggered:** {{ id }}, because {{ fact }}; {{ status }} (caselaw 0.3)

---
_Caselaw trigger {{ id }}, on other projects' evidence until your first catch: `caselaw rule catch {{ name }} --what "<commit, date or issue>"`. No catch after {{ days }} days of commits: `caselaw audit` asks if you need it._
