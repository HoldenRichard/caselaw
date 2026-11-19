# Precedent for the shipped rules

The evidence behind the default and triggered rules caselaw ships, kept here so no session has to load it. Open it
when you are deciding whether a rule earns its place in your project; the rules themselves hold one plain sentence
each and link to their section.

Every incident comes from the projects caselaw was extracted from. The `DEF-` ids are rows of the defect ledger of
that study, which is not public: they let its author trace each claim, and mean nothing to anyone else. The project
is named only by its kind. None of this is your project's evidence: a rule's first catch here writes your own Origin.

## re-derive-claims

- DEF-216, an iOS app, 2026-08-16: an agent's memory said every recent commit was signed, and that was sent to an app reviewer as evidence; 345 of 347 were unsigned.
- DEF-748, this tool, 2026-10-30: its own README said the app it came from had shipped to the App Store; it had been submitted, not accepted.
- DEF-145, an iOS app, 2026-08-10: the published Terms promised a purchase the build could not make.
- DEF-158, a content pipeline, 2026-08-10: two deliverables dated their observations to days they did not happen.
- DEF-131, a marketing website, 2026-07-28: a brief's header and the ratified text it enclosed gave two different effective dates.

## seen-to-fail

- DEF-521, an iOS app, 2026-09-25: a new test claimed to pin a behaviour it could not fail without.
- DEF-056, a content pipeline, 2026-08-03: a copy check read zero inputs and printed that all its specs passed.
- DEF-591, a content pipeline, 2026-10-01: a workflow reported "completed" after one agent's failure silently skipped two others.
- DEF-128, a research record, 2026-08-10: an audit that died on a spend limit at 45 of 71 agents was about to be reported as finished.

## say-what-was-not-covered

- DEF-447, a video tool, 2026-09-25: a check polled frames 500 to 680 of a recipe that ran to frame 745, so the step it waited for never ran.
- DEF-279, a content pipeline, 2026-09-07: stills silently skipped the crop they declared.
- DEF-591, a content pipeline, 2026-10-01: one agent's failure skipped two others without a word.
- DEF-274, this tool, 2026-10-30: in round 4 of an outside re-score, a second CI system the tool never read was not said to be unread.

## one-writer-per-tree

- DEF-151, a research record, 2026-08-10: `git add -A` committed another writer's in-flight work.
- DEF-215, a research record, 2026-08-12: a session log was lost to a same-filename collision between two agents.
- DEF-334, a research record, 2026-09-10: the ninth two-writer collision.
- DEF-335, this tool, 2026-09-10: its session log and nineteen ledger rows were committed by another stream's tree-wide sweep before they were approved.

## outward-actions-wait

- DEF-325, a prompt-tooling app, 2026-09-09: a failing test was pushed to the public repository.
- DEF-069, a content pipeline, 2026-08-02: paid credits were spent animating the wrong source image, which was picked without being opened.
- DEF-216, an iOS app, 2026-08-16: a false claim reached an outside reviewer.
- ruling, a research record, 2026-09-23: after a recipient asked how much of the author's email was AI-written, no agent writes messages the author sends as their own words.

## stop-the-chain-on-failure

- DEF-202, an iOS app, 2026-08-12: a `;`-chained archive reported success and produced nothing, hours before a submission.
- DEF-325, a prompt-tooling app, 2026-09-09: a failing test was pushed because the push was chained after it.
- DEF-337, a research record, 2026-09-10: an integrity check printed FAIL, and the chain committed and pushed anyway.
- DEF-224, a research record, 2026-08-14: a failed `cd` left the rest of a compound command running in the wrong repository.

## config-identity-gate

- DEF-018, an iOS app, 2026-07-19: a fresh console download after a key rotation still carried the old key, because the app's config was never re-pointed; the identity check stopped the swap.
- DEF-008, an iOS app, 2026-07-06: a key believed rotated was byte-identical to the leaked one.

## re-derive-declarations

- DEF-217, an iOS app, 2026-08-13: a public README claimed 125 quiz questions for two months; there were 85.
- DEF-184, an iOS app, 2026-08-11: the published privacy label contradicted the app's own manifest and both copies of its privacy policy.
- DEF-145, an iOS app, 2026-08-10: the published Terms promised a purchase the build could not make.
- DEF-748, this tool, 2026-10-30: its README said its source app had shipped to the App Store.

## retain-generation-records

- DEF-222, an iOS app, 2026-08-16: an app icon and logo made with an image model in March had no generation record, so their origin was unrecoverable exactly when a spam rejection asked about it.
- DEF-216, an iOS app, 2026-08-16: the commit history offered as evidence of authorship turned out to be unsigned, 345 of 347 commits.

## secrets-by-last-four

- DEF-008, an iOS app, 2026-07-06: the API key in the app was byte-identical to a leaked key that internal notes said had been rotated.
- DEF-310, a prompt-tooling app, 2026-09-09: a redacted key display overlapped its prefix and suffix on short keys and printed more of the key than intended.

## spend-protocol

- DEF-069, a content pipeline, 2026-08-02: credits were spent animating the wrong source image, picked by its timestamp instead of being opened.
- DEF-194, a content pipeline, 2026-08-12: a scraper's default page size would have tripled the projected spend.
- DEF-195, a content pipeline, 2026-08-12: one of two configured connectors had a dead token.
- DEF-128, a research record, 2026-08-10: an audit died on a spend limit at 45 of 71 agents.

## stage-explicit-paths

- DEF-151, a research record, 2026-08-10: `git add -A` committed another writer's in-flight work.
- DEF-334, a research record, 2026-09-10: the ninth two-writer collision.
- DEF-335, this tool, 2026-09-10: another stream's tree-wide sweep committed this tool's session log and nineteen ledger rows before they were approved.

## times-come-from-the-clock

- DEF-659, a research record, 2026-10-22: estimated times were written into a review log as if read from a clock.
- DEF-664, a research record, 2026-10-23: a "last updated" time was typed ahead of the clock read in the same step.
- DEF-158, a content pipeline, 2026-08-10: two deliverables dated their observations to days they did not happen.
