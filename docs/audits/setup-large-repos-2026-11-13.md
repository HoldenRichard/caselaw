# Larger-repository setup verification — 0.4.1

Recorded 2026-11-13 11:54:43 EST by Codex GPT-6.

These trials exercise CaseLaw setup in disposable copies of public repositories,
not contributions to those projects. `CASELAW_HOME` was isolated. Repository-owner
responses and approval were simulated test inputs, not decisions from maintainers.

| Repository | Pinned revision | Tracked files | Doctrine directory | Parent trial |
| --- | --- | ---: | --- | --- |
| [vitejs/vite](https://github.com/vitejs/vite/tree/4db98449a802abd67a6975fb4fdf260fa8f82979) | `4db98449a802` | 2,994 | `governance/` | All ten steps passed |
| [fastapi/fastapi](https://github.com/fastapi/fastapi/tree/5add7a458d629b07311d48261f696b5ac2bb9a5f) | `5add7a458d629` | 3,241 | `governance/` | All ten steps passed |
| [home-assistant/core](https://github.com/home-assistant/core/tree/5338d4e8b42c811065922c111c71257ab5b991c0) | `5338d4e8b42c` | 30,484 | `docs/` | All ten steps passed |

## Parent trial

The agent read manifests, instructions and workflows before completing the draft.
One simulated owner response supplied each project's release or device boundary
and human verification step, followed by approval of the setup summary. Optional
triggered rules were tailored to the actual workflow rather than accepted solely
because a file matched detection. Repository facts cited file evidence. Commands
were described as declared verification candidates, not executed checks.

Each packaged trial covered preparation, resume, preview, application,
`check --strict`, `doctor`, audit, upgrade, a second strict check, and eject.
The preview did not install doctrine. Application preserved an unrelated dirty
README edit without `--force`. Resume preserved answers, evidence, declarations,
notes and saved options. FastAPI included a saved optional glossary module.
The audit ran with generated files staged in the disposable repository. Existing
files, including Home Assistant's instructions, were checked for preservation;
eject restored their original bytes, with the deliberate README edit retained.

## Findings fixed before the independent review

| Finding | Fix and regression coverage |
| --- | --- |
| Vite and FastAPI store documentation-site configuration below `docs/`; installing doctrine there would mix governance with published documentation. | Recognize VitePress and nested/localized MkDocs configuration and choose `governance/` automatically. A source fixture covers both layouts. |
| Large workflows exposed setup-only commands, shell assignments and a YAML scalar header as verification commands. | Exclude housekeeping and standalone assignments, recognize comments on multiline scalar headers, retain real inline-environment test commands. |
| Multiline shell control flow yielded invalid fragments, and commands beyond the twelve-command cap disappeared silently. | Mark these portions unread and report explicit source-review warnings; carry warnings into the draft and setup summary. |
| Long command lists were truncated inside the rendered authority narrative. | Use a concise source-backed description and retain detailed commands in their detected fields. |
| Saved module/directory options could disappear between preparation and application. | Preserve them in the draft, validate their shape/path, and retain them during resume and apply. |
| Home Assistant's tracked-file list exceeded Node's default Git-output buffer and made audit report doctrine as untracked. | Increase the tracked-file output buffer to 16 MiB; the complete Home Assistant audit now passes. |
| An existing Home Assistant instruction example referenced an integration-relative path; audit treated it as a broken root-relative doctrine link. | Check references within CaseLaw's managed instruction block, preserving surrounding project prose. Continue checking the bridge's `@AGENTS.md` import. |

The earlier smaller-repository trials and fixes are recorded separately in
[setup-field-test-2026-11-13.md](setup-field-test-2026-11-13.md).

## Scope and limits

Home Assistant deliberately exceeds the 20,000-file detection cap. Its draft
reports partial language/deployment coverage, plus unread or capped CI. Vite also
exceeds CI-command reporting capacity; FastAPI contains shell control flow that
requires source review. These warnings are retained rather than interpreted as
complete detection. Generated commands may need job-specific setup and credentials;
the agent must inspect their cited sources.

These are setup tests. The projects' full application suites, deployments,
accounts, maintainers' decisions and Home Assistant hardware were not exercised.
The one-response setup path does not establish how every agent or user will act.

The full CaseLaw suite passed 929 tests with zero failures. The source self-audit
reported zero findings. The optimizer reported 604 words of session governance and
no proposals. The local staged/all-file gate has zero configured gates; its clean
exit therefore supplies no additional behavioral coverage.

The installed 0.4.1 tarball also passed a separate CLI smoke covering dry-run
immutability, draft resume, approval enforcement, apply, repeated setup,
audit, optimize, the generic pre-tool hook, upgrade, eject and symlink refusal.
The earlier smoke assumed a resumed draft was byte-identical; its assertion was
updated to check retained answers/evidence/source/declarations/notes while allowing
conditional options to refresh. Human fixture answers explicitly clear their
suggested file evidence as required by the draft instructions.

The repeatable detection-limit failures produced the unratified proposal
`docs/rules/proposed/report-incomplete-detection.md`. It changes no active policy.

## Independent review and hardening loop

A fresh medium-effort Codex subagent used its own clones, trial program and
simulated owner inputs, without reading the parent's trial scripts or reports.
It completed all three setup/upgrade/eject lifecycles and preservation checks,
plus unknown-answer, custom-option and edited-document checks. It found three
additional P2 issues despite clean audits:

1. FastAPI's commented job header was missed, attaching the next job's
   `always()` condition to a publishing step and omitting its real step condition.
2. Vite's custom package-release wrapper and pkg-pr-new preview publisher were
   omitted; the preview workflow was also misclassified as verification-only CI.
3. CI guidance omitted working directories/shells and rendered conditional
   prerequisites as unconditional clean-machine requirements.

The fixes retain commented job boundaries, share step execution context between
publishing and CI detection, preserve conditions in generated authority/close-out
guidance, recognize pkg-pr-new, and label custom package-manager publishing
wrappers as destination-unverified with a source-review warning. A wrapper's
implementation is not executed or assumed to have been resolved. Three focused
regressions failed before these fixes and passed afterward.

The reviewer also identified Home Assistant's generic `bin` ignore pattern hiding
the generated gate runner. The managed ignore block now makes that runner and its
parent directory shareable with anchored exceptions, preserving unrelated project
ignore rules. The expanded install/eject regression failed before this change and
passed afterward, including restoration of the original ignore file on eject.

The next independent pass confirmed those original fixes and completed all three
lifecycles, then found two narrower edge cases: expression delimiters were being
removed from a GitHub Actions directory value, and reopening the runtime directory
made ignored sibling files trackable. Context handling now removes expression
delimiters only for `if`; directory/shell expressions retain their source syntax.
The runtime ignore block explicitly ignores siblings between the directory and
runner-file exceptions. Both expanded regressions failed first and passed after
the changes, including preservation of an existing private sibling through eject.

The final independent pass verified candidate SHA256
`f607deb99d51bc0e933ba88c32e812c21a5b04952fcb070d0bd656229c449b87`.
All 11 original/neighboring checks passed against it, as did expression-context
checks and the four ignore-scope assertions. A fresh Home Assistant copy passed
all 13 lifecycle commands; eject restored the original ignore bytes exactly.
Vite and FastAPI had completed their full lifecycles on the preceding candidate;
their original regression cases passed again on the final candidate. No findings
remain within this bounded review. The review history, including superseded
findings, is retained in [setup-independent-2026-11-13.md](setup-independent-2026-11-13.md).

Final local checks: `npm test` passed 932 tests with zero failures;
`caselaw check --strict` and the self-audit passed; the final installed tarball
passed the CLI setup/hook/upgrade/eject smoke again. The repository's generated
ignore block was upgraded through the normal CLI. Its detection-limit rule
remains a proposal, not an agent-ratified policy.

The signed commit is released only after CI succeeds. Registry version, artifact
bytes and provenance contents are checked after publication, followed by an exact
registry-installed CLI smoke; that external result belongs to the release close-out.

Scratch source copies, summaries and per-step output are under
`/private/tmp/caselaw-large-trial.jZ5GJ6`. The parent executable is
`/private/tmp/caselaw-large-parent.py`. Temporary evidence may be cleaned by the OS.
