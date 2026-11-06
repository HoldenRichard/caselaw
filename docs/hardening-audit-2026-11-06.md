# CaseLaw hardening and adversarial audit

This audit covers local uncommitted changes based on `4440a2b` on `0.3-adaptive-harness`. It combines the original F1–F13 reproductions, new regression tests, two independent medium-effort Codex reviews, and package lifecycle smoke testing. This is evidence for the tested behaviors, not a guarantee that arbitrary inputs or future changes are safe. No source changes were committed or pushed in this work.

Audit completed locally: 2026-11-06 10:29:01 PST. Agent: Codex, GPT-6.

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 922 passed; 228 suites; zero failures, skips or cancellations |
| Claims / safeguards | 5 / 66 passed (overlap the full suite) |
| Static source census | 916 test definitions; 416 named POSITIVE CONTROL definitions |
| `check`, `audit`, `doctor`, `optimize` | Exit 0; audit zero findings; doctor warns that no machine gates are configured |
| Fresh package lifecycle | Local tarball: init, check, upgrade, doctor, eject passed; doctrine retained |
| Native gitleaks working tree | Exit 0, no leaks found |
| Native gitleaks history | Exit 1, one historical synthetic test fixture; see limits |
| Diff whitespace | Passed |

Counts are not additive across overlapping runs. Concrete regression coverage lives in `test/unit/adversarial-hardening.test.js`, `governance-transitions.test.js`, `rule-transition-races.test.js`, `snapshot-replay-security.test.js` and the updated existing tests.

## Original findings and resulting behavior

| Finding | Resulting behavior |
| --- | --- |
| F1: evolution bypassed ratification | Evolution stages a versioned proposal. Activation needs explicit human ratification and a matching active-base digest. Existing pending drafts are preserved. |
| F2: evaluator supplied its own expected verdict | The LLM callback receives no control label or fixture answer. Empty, malformed, and failed evaluation cannot count as successful verification. An explicit runner is required. |
| F3: synthesis overwrote stronger gates | Synthesis refuses existing IDs, including force requests; registration follows replay through the installed runtime. |
| F4: Markdown injection altered immutable metadata | Mutable fields reject section delimiters; reconstitution compares the complete immutable AST and rejects forged AST state. |
| F5: incident evidence overwritten or omitted | Conflicting writes fail; identical writes are idempotent. Malformed incident artifacts block population loading. |
| F6: synthesis and production evaluated different inputs | Exact-case literals are tested on complete recorded snapshots through the actual installed evaluator. Missing combined target scope blocks certification. Accuracy is fixture-local. |
| F7: governance files excluded from close-out | Dot-directory names survive normalization, and Git scope failures are errors rather than an empty change set. |
| F8: word count masqueraded as edit distance | Ordered token edit distance counts replacements, including case changes. Fixture-qualified compression remains a proposal requiring human review. |
| F9: zero fixtures counted as perfect verification | Empty populations cannot justify evolution or optimizer compression. |
| F10: close-out phrasing and scope gaps | Nonzero exit phrasings, structured failed observations, checked human boundaries, ambiguous basenames and real Git rename/root-commit scope have regression coverage. Prose classification remains bounded. |
| F11: routing mishandled globs, enforcement and budgets | Runtime glob semantics are shared, machine representations are normalized, and oversized matches do not prevent later rules fitting the budget. |
| F12: optimizer merge bypassed evidence-preserving consolidation | Shared consolidation retains extras; ratification validates parents, archives originals and refuses archive conflicts. |
| F13: rejected variants evaded normalization | Whitespace and blank-line variants share rejection hashes. |

Two early audit fixtures used six-character SHA placeholders and stopped at reference validation. Earlier descriptions implying those variants completed ratification were too strong. Their corrected seven-character fixtures now exercise replacement and merge activation and archival.

## Additional failures found and hardened

- Snapshot replay accepted Git metadata capable of invoking `core.fsmonitor`. Metadata paths are rejected; replay runs in a child with isolated Git configuration and explicit target files.
- Multi-incident replay omitted other eventual target paths. Every control must include every gate path explicitly, including null for absence; incomplete captures must be recaptured or supplied with the full scope.
- Missing installed runtime fell back to package code while claiming machine enforcement. CLI certification now requires the installed evaluator.
- Concurrent demotion could remove a newly ratified revision; active transitions now share a mutation lock.
- A proposal could change during human confirmation. Ratification now checks the digest of the displayed proposal.
- Partial exclusive writes could expose truncated active law. Exclusive publication now writes a temporary file fully before atomically linking it into place without replacing an existing destination.
- Historical merge instructions could run again when evolving an already merged rule. Evolution retains provenance without executing the old merge transition.
- Precedent archival could overwrite existing history and race active-law updates. It now uses exclusive archival, the shared mutation lock, revision checks and atomic active-file replacement.
- Aborting upgrade could still write trigger proposals and answers. Persistence now follows confirmation; cancellation has a subprocess regression.
- CI command detection split continued shell commands into fragments. It joins continuations and generated checklists retain complete commands and shell-significant spacing.

## Scope limits

Execution is local on Node 26. Node 20/22 CI combinations were not run. `npm run typecheck` exits 127 because `tsc` is unavailable. The pinned Docker CI scans were not run because the Docker daemon was unavailable. Native gitleaks 8.30.1 scanned the working tree clean. A separate history scan exited 1 on one historical synthetic SECRET constant in a path-containment positive-control test (`test/unit/gate-hook.test.js:104`, commit `f19befb5`); its temporary-file test context was inspected. No allowlist or history rewrite was applied. TruffleHog live credential verification was not run. No real external model runner, production datastore, or rendered UI was verified. The repository currently has no configured machine gates; doctor reports that honestly as a warning.

Snapshot certification supports explicitly enumerated banned-content gate paths. Older diff-only incidents remain readable but cannot certify a gate. Git capture includes changed paths for each pair; combining incidents can therefore require supplying additional complete snapshots. Tests do not prove semantic equivalence of arbitrary natural-language rules. Human ratification is an explicit caller/UI boundary, not a sandbox against a malicious process with filesystem access. Locks coordinate participating rule-transition and precedent-archival writers, not arbitrary editors; generated install/upgrade/eject operations still require a single writer. They are not covered by a global transaction lock; interrupted locks require inspection. Atomic publication does not claim power-loss durability or a journaled multi-file transaction.

Draft rules remain proposals. No new rule was ratified, and the constitution was unchanged.


## Astra follow-up fixes

The first bounded GPT-6 Astra review found five gaps even though its 53 targeted tests passed. The next change set fixes shared gate-promotion/config locking, digest-bound demotion and rejection, repeated merges (including evolved parents), raw preservation of malformed drafts on rejection/overwrite, and literal shell continuation bytes. `test/unit/astra-regressions.test.js` adds seven direct regressions. Parent verification: 917 runtime tests passed, zero failures/skips; 46 targeted tests passed before the final full run. Generated CI instructions were refreshed. Draft rules remain unratified.

The fresh Astra review reproduced additional merge-parent, readoption, generated-selection, shell-comment and encoding failures. These are now fixed: merge source hashes are pinned and checked before any archival; machine parents require separate migration; adoption converts completed transitions to history; generated selections update under the retirement lock; comment boundaries are preserved; non-round-trippable UTF-8 input is refused without changing its bytes.

Final parent verification: **922 tests passed**, zero failures/skips/cancellations. `check`, `audit`, `doctor` and `optimize` exit 0. A new final tarball passed init/check/upgrade/doctor/eject with doctrine retained. Static census: 916 definitions, 416 named positive controls. Astra's bounded acceptance recheck passed all 12 direct regressions and three independent scratch scenarios, closing all ten reported cases. It inspected the parent full-suite summary but did not rerun that suite.

Reports: [first findings](audits/astra-first-2026-11-06.md), [second findings](audits/astra-second-2026-11-06.md), [independent acceptance](audits/astra-acceptance-2026-11-06.md).

Legacy pending merges without parent hashes must be restaged. Non-UTF-8 files require explicit human conversion or preservation. CI extraction has regression coverage for the reported literal shell forms; it is not a general shell/YAML parser. Single-writer lifecycle, platform, type-checking, external verification and crash-durability limits above still apply.

Final acceptance recorded locally: 2026-11-06 10:50:08 PST. Codex parent; independent reviewer GPT-6 Astra at medium effort. No commit, push or ratification.
