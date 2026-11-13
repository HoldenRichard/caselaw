# Setup trials on public repositories

Recorded 2026-11-13 03:34:27 EST by Codex GPT-6.

The baseline used the published npm package `caselaw@0.4.0`. The rerun used a tarball
packed from the local fixes on top of `deb980f`. Both ran in disposable clones.
`CASELAW_HOME` was isolated. Source checkouts were pinned to the revisions below.

| Repository | Revision | Rule directory | Final result |
| --- | --- | --- | --- |
| [sindresorhus/np](https://github.com/sindresorhus/np/tree/5ca53e9a04158b2fa544fb9523ecb7e6b2db7ddc) | `5ca53e9a0415` | `docs/` | All nine steps passed |
| [psf/requests](https://github.com/psf/requests/tree/3c7baaa05ab4aa49cc819ce3a819d260de19c157) | `3c7baaa05ab4` | `governance/` | All nine steps passed |
| [sveltejs/realworld](https://github.com/sveltejs/realworld/tree/df796708040f5200ec572b28ab7f88ecee5794dd) | `df796708040f` | `docs/` | All nine steps passed |

## Trial method

The agent read the repository manifest, README, CI and deployment configuration, filled
repository facts with file evidence, and completed the setup using one simulated owner
response plus approval of a setup summary. The owner response supplied the release or
deployment boundary and the human verification step. These responses were test inputs.
The trial did not obtain decisions from the public repositories' maintainers.

Each final run covered preparation, resume with refreshed options, preview, application,
`check --strict`, `doctor`, `audit`, upgrade, and another strict check. Application
included an unrelated uncommitted README edit and preserved it without `--force`.
Generated files were staged in the disposable copies so the audit could check tracking.
All pre-existing source files retained their expected bytes, including the intentional edit.

The claims register included one illustrative README claim per project. Source detection
and generated setup were tested. The applications' own tests, accounts and release
processes were outside these setup trials.

## Findings and fixes

| Finding in the baseline | Change |
| --- | --- |
| An unknown optional outside authority crashed Svelte RealWorld setup during trigger validation. | Unknown answers are excluded from the context used to resolve conditional options and remain visible gaps in the installed setup. |
| The draft exposed blank answers for facts and low-impact choices the agent could prepare. | Seed declared verification candidates with source evidence, detected public surfaces, rule recommendations and the default review interval. Keep owner boundaries open. |
| Trigger options were computed before the agent supplied outside-authority and claims answers. | Resuming refreshes detection and dependent options while preserving answers, evidence, declarations and notes. |
| The proposed review interval required file evidence despite being a user preference. | Mark the interval as a preference approved with the setup summary. |
| Requests' CodeQL checkout step became a local verification command. | Treat git checkout and switch operations as CI housekeeping while keeping checks such as git diff --exit-code eligible. |
| Package-manager-only .npmrc files triggered the secrets rule in both Node projects. | Distinguish credential settings from ordinary settings and comments. Authentication placeholders still count as a credential surface. |
| Svelte RealWorld's configured Vercel adapter was missed. | Detect the adapter import in Svelte configuration without executing it. |
| Applying a draft in an active working tree required committing unrelated work or using --force. | Apply chat setup through the existing managed-file ownership plan, preserving unrelated edits. |
| Recommending every triggered rule gave Requests 3,356 words of initial governance and an optimizer warning. | Tell the agent to tailor optional recommendations before the approval summary. The final Requests trial omitted optional changelog and test-fixture rules and its audit reported zero findings. |
| The generic completion hint pointed at docs/ even when Requests used governance/. | Print the installed directory in the hint. |

Declared formatter commands that rewrite files are also excluded from the draft's
verification recommendations.

## Results and limits

All three final packaged trials passed. The np and Requests audits reported zero findings.
Svelte RealWorld retained a warning for its unknown optional external approver and returned
exit 0. This uncertainty did not require another owner question to complete setup.

The agent still needs to read and tailor recommendations before approval. One simulated
response in these trials measures the exercised setup path. It does not establish a user
study result or guarantee every agent will ask the same number of questions.

The regression suite passed 924 tests with zero failures. These fixes are local and
unpublished at the time of this report.

Scratch inputs, per-step output and the executable rerun are under `/private/tmp/caselaw-field-040.9gLqll` and
`/private/tmp/caselaw-field-040-rerun.py`; temporary files may be cleaned by the OS.
