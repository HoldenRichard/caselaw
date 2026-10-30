# Field test, 2026-10-31 (phase 9, the first part)

Recorded 2026-10-31 11:45 NZDT. caselaw 0.3 (branch `0.3-adaptive-harness`) installed into a fresh shallow clone of each of
Holden's six repositories, in a scratch directory: nothing was written to any working tree, nothing was
pushed, and every interview answer was the preselected one (blank: "Ask me first", every default, no
boundaries named), so the triggers that need an interview answer (T1, T2, part of T4 and T6) could not
fire. The install was committed in each clone, then `caselaw audit` and `caselaw optimize` were run.

| repository | triggers fired | words a session loads | audit after commit |
|---|---|---|---|
| Kabu (TradeSim-iOS) | none | 1,811 | 1 error: its CLAUDE.md says `.claude/settings.json` is gitignored; it is tracked |
| Kabu-Marketing | none | 1,772 | 1 error: its CLAUDE.md points at `scripts/_deprecated-build-tiktok-video.mjs`, which does not exist |
| KabuWebsite | none | 1,758 | clean |
| Reprompt (Prompt OS) | T4, after the fix below | 1,765 | clean |
| Stir | none | 1,753 | clean |
| caselaw (dogfood) | none | 2,064 | clean after the fix below; the optimizer is due (78 days since the install) |

Every install loads 1,750 to 2,070 words, under the provisional 3,000-word budget.

## What it found in caselaw, fixed

1. **T4 read only dependency manifests.** Reprompt calls Claude, Gemini and Groq over plain HTTPS from
   Swift, with no SDK in any manifest. Paid API hosts named in source files now count.
2. **T5 counted only file names that start with a date.** Kabu writes them at the end
   (`pre-submission-audit-2026-08-10.md`). A date anywhere in the name now counts; a build number does
   not. Kabu still does not fire T5: two dated files in `docs/` is under the threshold of three.
3. **The audit called caselaw's own citations missing.** `refs-resolve` read
   `.github/workflows/release.yml:60` as a file named with `:60`, so every install whose authority split
   cites a workflow line failed its own audit. A line reference now resolves to the file, and a line past
   the file's end is still reported.

## What it found in Holden's repositories, not changed

Two of his CLAUDE.md files make claims that are not true of the repository: Kabu's says
`.claude/settings.json` is gitignored by the `.claude/*` rule (it is tracked, and not ignored), and
Kabu-Marketing's points at a deleted script. Those files are his; they are reported here, not edited.

## Not done yet

- The three outside repositories, re-scored on the DEF-274 rubric with the 0.3 install: it needs an
  independent scorer run.
- A field test with the interview answered (outside authorities, public claims, boundaries), which is
  where T1, T2 and the content of the authority split are tested.
- One run of the full suite failed `detect() — the full report` while the machine was loaded (trufflehog
  scanning in the secrets tests, and an orphaned earlier run); the file passed alone, and the next full
  run passed 744 of 744. Intermittent and not diagnosed: it is recorded here, not called fixed.
