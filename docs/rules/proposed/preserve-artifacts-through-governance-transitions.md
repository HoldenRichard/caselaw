# preserve-artifacts-through-governance-transitions

**Trigger:** Creating, evolving, merging, rejecting, or replacing governance artifacts

**Rule:** Before activating or removing a governance artifact, preserve its evidence and pending drafts, validate the current version, and prove the complete transition with a failing control. Never infer ratification from a successful evaluation.

**Origin:** commit 4440a2b; independent re-audit reproduced pending-proposal overwrite and merge evidence loss; regression tests in test/unit/governance-transitions.test.js

**Enforcement:** memory
