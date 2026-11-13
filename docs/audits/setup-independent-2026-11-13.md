# Independent setup review history

Archived 2026-11-13 12:08:24 EST by Codex GPT-6. The reviewer independently wrote the report below.
It records successive packages chronologically; the final **Final2 bounded
disposition** supersedes earlier open findings. All reported findings were
resolved in the final tested candidate. Scratch paths are evidence pointers and
may be cleaned by the OS. No upstream application behavior is certified.

# Independent verification — revised CaseLaw 0.4.1

Candidate: `/private/tmp/caselaw-release-041/caselaw-0.4.1.tgz`
SHA256 independently verified: `4a941c267c2cab72c1c0cd7d7449a82a49e1f222db11e11e6b3dabc1fa7f8322`.
CLI: `/private/tmp/caselaw-release-041/revised-tool/node_modules/.bin/caselaw`.
Evidence directory: `/private/tmp/caselaw-independent-revised.w_vgkg01`.

## Original findings dispositions

1. **F1 fixed.** FastAPI's original pre-commit.yml:83 reproduction now retains its actual step condition from line 71, including the final apostrophe. No `always()` leaks from the commented neighboring job. Both generated authority and close-out documents agree. Removing the neighboring inline comment is a passing clean comparison.
2. **F2 fixed.** Vite preview publishing is named as pkg-pr-new. The ci-publish wrapper is explicitly destination-unverified, with a source-review warning; no invented npm destination. Neither publishing workflow contributes CI checks. Generated authority and close-out guidance carry both routes.
3. **F3 fixed for original cases.** Original Vite package-build steps retain their two working directories in command extraction; because they belong to a publishing workflow, they are now correctly excluded from routine checks. FastAPI's original conditional SQLAlchemy prerequisite keeps its condition. Vite's Unix and Windows setup variants keep distinct OS conditions. Both generated documents replace unconditional clean-machine prerequisite language with instructions to review/adapt source-declared setup steps. One neighboring expression-context defect remains below.

## Remaining finding

**P2 — Directory expressions are changed into literal paths.** Home Assistant `.github/workflows/ci.yaml` declares `working-directory: ${{ runner.temp }}` for the Pylint plugin check outside the checkout. Revised extraction returns `workingDirectory: "runner.temp"`; generated `home-assistant-authority-split.md` and `home-assistant-close-out.md` therefore instruct `working directory runner.temp`, which denotes a different, relative directory. This check explicitly needs to execute outside the checkout, so the altered location changes its meaning.

Root cause: packaged `src/detect/publishing.js`, `stepContext`, applies `.replace(/^\$\{\{\s*|\s*\}\}$/g, '')` to every context field before deciding whether it is an if, directory or shell. Removing the expression delimiters is appropriate for an if expression but changes a directory value's semantics. Preserve directory/shell expression syntax, or label unresolved expressions explicitly instead of presenting their body as a literal directory.

Exact reproduction (no dependencies/builds):

```sh
node /private/tmp/caselaw-independent-revised.w_vgkg01/reproduce-remaining.mjs
```

Observed: assertion exit 1, actual `runner.temp`, expected `${{ runner.temp }}`. Full output: `reproduce-remaining.log`. The original CI context check suite includes passing literal directory/default precedence cases and passing if-expression handling; this is a specific field-dependent failure, not a request for a general parser redesign.

## Per-repo lifecycle

| Repo | Tracked files | Lifecycle | Strict before/after upgrade | Doctor | Audit with generated paths staged | Preservation |
|---|---:|---|---|---|---|---|
| Vite | 2994 | all phases exit 0 | 0 / 0 | 0, hook/gate warnings | 0, no findings | passed |
| FastAPI | 3241 | all phases exit 0 | 0 / 0 | 0, hook/gate warnings | 0, no findings | passed |
| Home Assistant | 30484 | all phases exit 0 | 0 / 0 | 0, hooks answering; zero gates warning | 0, optimizer warning | passed |

Phases: prepare, independently fill with simulated owner answers, resume, unknown-answer preview, normal preview, apply, explicit generated-path staging, check --strict, doctor, audit, upgrade, check --strict, saved-answer resume/preview, eject. All 39 phase commands returned 0 (`results.json`). Read the generated authority and actual shared close-out documents for all three. Home Assistant's saved close-out copy was corrected to use docs/close-out.md rather than its Claude command pointer.

Hash assertions preserve unrelated dirty README and untracked content through the lifecycle, along with the original instruction prefix. After eject, tracked files differ from HEAD only by deliberately introduced README notes and Home Assistant's deliberate AGENTS note. Vite's original Copilot instructions and all original ignores have no remaining diff. Source checkout was not edited, staged, committed or pushed by this reviewer.

## Independent checks and retained caveats

`verify-context.mjs`: **11 independent checks passed**, including exact original source cases, commented/uncommented job boundaries, raw apostrophes, direct vs wrapper publication, benign test scripts, publishing-workflow exclusion, literal directory and shell precedence at workflow/job/step levels, folded conditions, continue-on-error, and no context leakage between steps/jobs. Log: `verify-context.log`.

`edges.py`: custom doctrine directory/modules persist through resume and saved-answer preview; custom untested boundary/reason persists; unknown human-proof answer is visibly unanswered and audit warns; upgrade preserves hand-edited generated prose, while strict check exits 1 as expected. Log: `edges-console.log` and `edge-*.log`. Audit exit 1 in this deliberately unstaged fixture is expected and includes doctrine-tracked errors.

Home Assistant still reports the 20,000-file scan cap and omitted CI coverage; apply warns its gate runner is ignored by existing repo policy. Those limitations remain disclosed; this trial did not change owner ignore policy or certify a fully shareable installation.

Scripts and logs are independent scratch artifacts. Full lifecycle: `trial.py`, `lifecycle-console.log`, `<repo>-<phase>.log`, `results.json`. Generated review evidence: `<repo>-authority-split.md`, `<repo>-close-out.md`, saved answers/drafts. Owner authorization answers were explicitly simulated. No upstream contact/contribution, application builds, dependency installations or hardware tests. Parent full unit/release-smoke/CI/provenance checks were not repeated. Scope remains setup correctness and preservation.


---

## Final frozen candidate — narrow ignore-fix verification

Verified SHA256 of `/private/tmp/caselaw-release-041/final-caselaw-0.4.1.tgz`: `de63d48f0a9eb169f9a033e00946c95c7c990f78f8efe79e498ab28c2eb86fe7`.
Used `/private/tmp/caselaw-release-041/final-tool/node_modules/.bin/caselaw` in a fresh Home Assistant clone (`home-assistant-final2`). All 13 lifecycle phases returned 0, including strict checks before/after upgrade, doctor, staged audit, saved-answer preview, and eject. The generated runner is no longer reported ignored. Exact original `.gitignore` bytes restored after eject; unrelated dirty content and instructions preserved. Script: `final-ha-trial-complete.py`; logs: `final-ha-complete-console.log`, `home-assistant-final2-*.log`, `final-results.json`.

`git check-ignore --no-index -q` verifies:

| Path after install | Ignored? |
|---|---|
| `.caselaw/bin/gate.mjs` | no — intended fix works |
| `bin/unrelated` | yes — original project policy preserved |
| `some-project/bin/unrelated` | yes — nested project policy preserved |
| `.caselaw/bin/unrelated.mjs` | no — see scope nuance below |

**P3 scope nuance:** `!/.caselaw/bin/` reopens that directory, so its other children also become trackable under Home Assistant's original `bin` ignore. The exact claim that only the gate file becomes trackable is therefore too narrow. This does not reopen other project bin directories or the entire .caselaw tree. If sibling contents must stay ignored, the owned block needs an ignore for `/.caselaw/bin/*` between the directory exception and the gate-file exception. The first independent narrow assertion failed specifically on that sibling; the continuation records the observation and verifies the requested outer boundaries. Evidence: `final-ha-console.log`, `final-ignore-checks.json`, `final-installed-gitignore.txt`.

Re-ran all 11 original/neighboring context checks against final-tool: all passed (`final-verify-context.mjs`, `final-verify-context.log`). The directory-expression **P2 remains reproducible** in this final package: `node /private/tmp/caselaw-independent-revised.w_vgkg01/final-reproduce-remaining.mjs` exits 1 because `${{ runner.temp }}` becomes literal `runner.temp`; full output in `final-reproduce-remaining.log`. No claim that this outstanding finding was fixed.

Final-candidate application lifecycle was rerun only for Home Assistant as requested for this narrow ignore change. Vite/FastAPI full lifecycles above used the earlier revised installation; their original regression/context cases were rerun against final-tool. No main-source edits, commits, pushes, unit-suite repetition, builds, dependency installation, or upstream actions.


---

## Final2 bounded disposition — all reported findings resolved

Immutable package `/private/tmp/caselaw-release-041/final2-caselaw-0.4.1.tgz`; independently verified SHA256 `f607deb99d51bc0e933ba88c32e812c21a5b04952fcb070d0bd656229c449b87`. Used `final2-tool/node_modules/.bin/caselaw`.

- **Remaining P2 fixed:** exact Home Assistant reproduction now retains `${{ runner.temp }}`. Read and asserted the actual generated authority and shared close-out documents both render that expression intact. Explicit step, workflow-default, and job-default directory/shell expression cases pass; if-expression delimiters are removed appropriately, terminal apostrophes survive, and adjacent steps do not inherit conditions.
- **Remaining P3 fixed:** generated runner is trackable; `.caselaw/bin/unrelated.mjs`, root `bin/unrelated`, and nested `some-project/bin/unrelated` remain ignored. All four independent assertions pass. Eject restores the original `.gitignore` bytes exactly.
- **Original 11 regressions pass against final2-tool**, covering the original Vite/FastAPI cases and neighboring clean/context cases. No full Vite/FastAPI lifecycle repetition for these two narrow changes, as requested.
- **Fresh Home Assistant lifecycle passes all 13 phases**, including both strict checks, doctor, staged audit, upgrade/resume and eject. Dirty README/untracked content and original instructions preserved. After eject, original tracked-file differences are only the intentionally added README/AGENTS notes. The original scan-cap/omitted-CI and optimizer-budget warnings remain disclosed; ignored-runner warning is gone.

No additional findings in this bounded verification. Original F1/F2/F3 plus later P2/P3 are resolved for the tested cases. This is setup verification, not exhaustive YAML parsing or application-runtime certification. No main-source modifications, commits, pushes, dependency installation, application builds or upstream actions.

Evidence: `final2-verify-context.mjs/.log` (11 pass), `final2-reproduce-remaining.mjs/.log` (exact P2 reproduction now passes), `final2-neighbors.mjs/.log`, `final2-ha-trial.py`, `final2-ha-console.log`, `final2-results.json`, `final2-ignore-checks.json`, `final2-installed-gitignore.txt`, `home-assistant-final3-*.log`. Fresh clone: `home-assistant-final3`; generated retained docs: `home-assistant-final3/docs/authority-split.md` and `docs/close-out.md`.
