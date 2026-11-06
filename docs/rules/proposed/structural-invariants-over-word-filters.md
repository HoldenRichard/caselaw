# structural-invariants-over-word-filters

**Trigger:** Writing or reviewing validators, security gates, or safety checks that classify text or code

**Rule:** Enforce invariants structurally through AST parsing, exact token grammars, or isolated execution rather than keyword blacklists. When inspecting text claims or authority boundaries, normalize Unicode (NFKC), strip zero-width characters, and resolve homoglyphs before regex evaluation.

**Origin:** commit cb73ebb: adversarial audit demonstrated word blacklists break valid rules while homoglyphs and zero-width spaces evade unnormalized regex

**Enforcement:** memory
