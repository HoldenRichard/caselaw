# Post-0.4.1 audit remediation

Recorded 2026-11-13 17:20:41 EST by Codex GPT-6.

Baseline: branch `0.3-adaptive-harness`, commit `bdd52ca6f1e406125a4f082989543b77e8661607`, package 0.4.1.
The unmodified baseline suite passed 932 tests. The supplied forensic assertions
were run against a clean Git archive of that commit and failed on F1; they pass
against the remediation. Each confirmed failure was exercised before its fix.
Eleven finding-specific `POSITIVE CONTROL:` tests cover F1–F11, with neighboring
clean cases. The test census is 937 static cases and 427 named positive controls;
the runner executes 943 cases, including generated adapter cases.

## Finding dispositions

| Finding | Baseline evidence and resulting behavior |
| --- | --- |
| F1 | Confirmed: runtime, templates, package and custom rules could be omitted. Scope now includes those paths and the configured doctrine directory. Answers take precedence; a manifest can recover the installed directory when answers are missing. |
| F2 | Partial: ordinary backticks already worked; Markdown-linked and leading-dot paths failed. One canonical claimed-path set now drives omission and fabrication checks. Versions and prose are not treated as scoped files. Spaces, hashes, colons and stars in code-formatted paths are preserved. |
| F3 | Confirmed: fixed indentation lost step/default context. Mapping and sequence indentation is measured. Conditions consume all more-indented continuation lines, including deeper folds. Workflow/job defaults and step overrides retain precedence. |
| F4 | Confirmed: heredoc bodies became checks and numeric shifts could be misclassified. Quoted arguments are excluded from structural matching; identifier heredocs and chained/env-prefixed control flow are reported unread. A whole run block is consumed, so a body containing `run:` is not parsed as another workflow step. No heredoc fragment is advertised as an executable check. |
| F5 | Confirmed for Changesets, semantic-release, Bun and the extra Python publishers; `gh release create` was already supported. Release-named tests/lints/checks and dry-run script names are excluded. Known tools are named without inventing a custom registry destination; unmatched publishing wrappers retain source-review warnings. Labels and semantic-release test filenames/echo arguments do not become publishers. |
| F6 | Confirmed: outer-quote and comment handling could corrupt scalars. A shared quote-aware decoder strips comments outside quotes only, decodes whole quoted scalars and preserves separately quoted shell arguments. |
| F7 | Superseded in part: 0.4.1 already retained expression delimiters. Guidance now additionally labels directory/shell expressions as resolved by the CI runner, with their delimiters intact. |
| F8 | Confirmed/extended: managed pointer isolation was limited to root files, and mixed Markdown links could be parsed twice. Managed adapters and manifest pointer paths are gathered; pointer/caselaw interiors are isolated regardless of filename. Links are consumed once before inline-code extraction; real missing managed references still fail. Manifest paths must remain repository-relative. |
| F9 | Partial: Sphinx `docs/source/conf.py` already worked. Added VitePress CJS, nested Docusaurus/Astro configurations, and Mintlify configurations. All listed layouts are tested without executing their config. |
| F10 | Confirmed: a filename list above 1 MiB failed. Git operations use 16 MiB bounds and synchronous spawn errors are surfaced. The fixture tests 4,200 long paths before/after commit, missing-cwd errors, and a merge whose scope is explicitly compared against its first parent. |
| F11 | Confirmed for secondary/batch paths; the tested single-file path spellings already enforced. Legacy MultiEdit, multiple tool calls and portable write batches preserve each path/text association. Canonicalized paths are grouped by their owning install and all groups are evaluated. Invalid/outside paths are reported without suppressing valid sibling checks; traversal is not read. Clean sibling writes remain allowed. Pre/post subprocess fixtures cover nested installations and outside-root inputs. Legacy MultiEdit hooks are wired in the generated adapter. |
| F12 | The fetched default branch was `main` at `2515d56`, with its release link already updated but implementation still 0.2.0. Its history is merged with the tested harness branch; README keeps the current release pointer and identifies the subsequent audit changes as unreleased. Advancing both branches to the resulting merge preserves history. |

## Verification and invariants

The full suite passes 943 tests with zero failures. The claims census check,
self-audit, strict generated-file check and close-out verification are run through
their normal CLI entry points; results are recorded in the companion close-out.
A separately packed/installed CLI passed preparation, resume, preview, approval,
apply, repeat setup, audit, optimize, generic hook, upgrade, eject and symlink
refusal. The vendored runner matches `runtime/gate.mjs` byte for byte.

There are no runtime dependencies; Node remains `>=20`. Constitution A1–A5 is
unchanged. No rule was ratified by the agent. The scope-inventory lesson is an
unratified proposal at `docs/rules/proposed/scope-includes-owned-artifacts.md`.

## Limits and release state

This is a bounded source/execution audit, not a complete YAML or shell interpreter.
Unresolved shell structure is reported for source review instead of interpreted.
Git output remains bounded at 16 MiB; exceeding that bound is an error or recorded
audit gap, never proof of a complete scan. Hardware, production datastores and
live third-party agent-host execution are outside this verification.

The npm 0.4.1 artifact and its immutable tag are unchanged. These are subsequent
source fixes; a new npm release is a separate outward-facing action. The default
branch alignment is verified by Git refs and CI at close-out.

Scratch reproduction sources and command output: `/private/tmp/caselaw-post041.1Ah8X7`.
Temporary evidence can be cleaned by the OS. The companion report is
[post-041-closeout-2026-11-13.md](post-041-closeout-2026-11-13.md).
