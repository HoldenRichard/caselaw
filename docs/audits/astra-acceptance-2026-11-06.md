# Acceptance recheck — CaseLaw working tree at base 4440a2b

**Accept closure for all ten reported failure cases.** The single-file run and three independent scratch replays completed successfully.

## Five neighboring findings

1. **Stale merge approval — closed.** In the first replay, the rule command handler successfully promoted beta during the alpha+beta ratification prompt. Ratification then returned 1 and asked for restaging. Both parents remained active, the gate origin resolved, the proposal remained pending and zero archive entries were created. The optimizer pins the source revisions when staging (src/core/optimizer.js:244–253). Locked ratification verifies each digest and checks machine enforcement before the archive loop (src/core/rules.js:818,883–901,926–935). This replay exercised the stale-digest refusal; the separate machine-parent guard was inspected.
2. **Readoption replayed retired parents — closed.** Continuing the same scratch history with two eligible parents, I merged alpha+gamma, evolved the result, demoted it, adopted it with a new Origin and ratified it. The evolved text survived, the archive listing stayed the same through readoption, and the four transition fields returned only as history. Adoption transforms the fields at src/core/rules.js:1058 onward.
3. **Concurrent generated demotions lost an answer update — closed for the two-handler interleaving.** The targeted test paused one demotion after reading answers. The second met the lock, succeeded on retry, and the final default selection was empty. Source inspection confirmed the CLI passes the retirement callback into the locked demotion and merge paths. It reloads answers and atomically writes the changed selection before source removal (src/commands/rule.js:188,245–263,324; src/core/rules.js:603,631–632,818,935–951). This used the regression test and source trace, without a fourth scratch replay.
4. **Shell comment hid the next CI gate — closed for the reported literal block.** In the independent shell replay, a full-line comment ending in one backslash was followed by printf "%s" checked. The detector returned exactly the printf command. Both the original block and the detected command printed checked under /bin/sh. The targeted test also covered an inline comment.
5. **Latin-1 draft bytes changed on rejection — closed.** The third scratch scenario invoked the reject command handler on a draft ending in 63 61 66 e9 0d 0a. It returned 1 with a UTF-8 diagnostic. A full-buffer comparison matched and no archive directory was created. The targeted test also confirmed overwrite refusal; readRuleFile checks the round trip before returning text (src/core/rules.js:1226–1228).

## Original five

| Failure | Acceptance status |
|---|---|
| Gate promotion erased a concurrent registration | Closed for the inspected writers. Promotion uses the common lock, and synthesis, manual promotion and direct trigger insertion reload config under it. The contention/retry regression passed. |
| Confirmation demoted or rejected a newer revision | Closed for the two reported swaps. Both prompt regressions passed. The comparisons use the project's normalized-text digest. |
| A second optimizer merge executed old parents | Closed. The repeated-merge regression ratified the second merge after evolving the first, retaining the earlier parent list as history. Older pending merges lacking required base hashes must be restaged. |
| Reject/overwrite discarded duplicate Markdown sections | Closed. Both UTF-8 prefix-preservation tests passed. Non-round-trippable input was refused before the destructive operations tested above. |
| A literal continuation inserted a space inside a token | Closed for the reported split token. The joined-token, indentation and doubled-backslash controls passed. |

## Verification boundary

Ran once: TMPDIR=/private/tmp node --require ./test/setup.cjs --test test/unit/astra-regressions.test.js. Result: 12 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo, 159.1365 ms. Log: /private/tmp/caselaw-astra-final-targeted.log. The parent’s full-run log at /private/tmp/caselaw-astra-final-full.log records 922 passed, 0 failed, 0 skipped and 0 cancelled. I inspected its summary only.

The scratch work used temporary fixtures, shipped command handlers and an injected confirmation callback. Acceptance covers the specified transitions and interleavings. Arbitrary concurrent filesystem writers, multi-file crash recovery, broader lifecycle concurrency and general shell grammar were outside this recheck. No repository writes, network, subagents or additional suite runs.
