# preserve-shell-continuation-bytes

**Trigger:** Extracting shell commands from CI configuration for generated verification instructions

**Rule:** Remove a literal shell backslash-newline without adding a separator; preserve deindented continuation bytes and shell-significant whitespace. Verify token joins against shell execution rather than a visually normalized command.

**Origin:** 2026-11-06 Astra audit identified a split test:unit token becoming test: unit; test/unit/astra-regressions.test.js checks token joins and escaped backslashes.

**Enforcement:** memory
