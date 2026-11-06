# bind-confirmation-to-reviewed-revision

**Trigger:** Confirming a governance transition while another writer may edit its input

**Rule:** Pass the digest of the displayed revision into the locked operation; reject confirmation if the current input differs. Never transfer human approval to a replacement artifact.

**Origin:** 2026-11-06 Astra audit reproduced demotion of a revision ratified during an earlier revision confirmation; test/unit/astra-regressions.test.js covers demotion and rejection.

**Enforcement:** memory
