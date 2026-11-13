# report-incomplete-detection

**Trigger:** Changing a repository detector, bounded scan, or generated setup summary.

**Rule:** When a scan or parser omits possible inputs, report the limit and affected sources in the agent-facing draft and generated handoff. Exercise a limit-exceeding fixture and verify that ordinary complete inputs remain clear of the warning.

**Origin:** 2026-11-13 larger-repository setup trials: Vite and Home Assistant exceeded CI-command reporting limits; FastAPI shell control flow yielded misleading command fragments. See docs/audits/setup-large-repos-2026-11-13.md and the ci-gates-truncated/ci-shell-unread regression in test/unit/detect-project.test.js.

**Enforcement:** memory
