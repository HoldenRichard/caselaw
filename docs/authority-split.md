# Authority split — caselaw

Generated 2026-08-13 from the install interview.

This file says who can verify what. It is the difference between "the agent said it works" and
"someone checked". Regenerate it with `caselaw upgrade`; edit `.caselaw/answers.json`, not this file.

## The agent can

- Run what CI runs on a change, in its order (`.github/workflows/ci.yml`, job `test`): `node --test test/unit/*.test.js`; `node bin/cli.mjs audit .`. In its `test` job, CI runs across 2 node; a run here covers one combination.
- Run what CI runs on a change, in its order (`.github/workflows/ci.yml`, job `gitleaks`): `docker run --rm -v "$PWD:/repo"   ghcr.io/gitleaks/gitleaks:v8.30.1   dir /repo --no-banner --no-color --redact` (gitleaks — working tree).
- Run what CI runs on a change, in its order (`.github/workflows/ci.yml`, job `trufflehog`): `docker run --rm -v "$PWD:/repo"   -e GIT_CONFIG_COUNT=1   -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/repo   ghcr.io/trufflesecurity/trufflehog:3.96.0   git file:///repo --results=verified --fail --no-update --no-color` (trufflehog — verified secrets, full history).
- It can run the full suite, the self-audit, gitleaks and trufflehog, and install itself into a scratch repo end to end.

## The agent cannot — physical

No process could do these from this machine. They are not policy; they are facts about the world.

- **see what the UI actually renders**

## The agent cannot — chosen

Technically reachable, deliberately withheld. If one of these ever needs to change, change it
here first and say why — an undocumented loosening is how a boundary quietly stops existing.

- **read production datastore state**

## What a push can publish

Each of these publishes outside the repository, and git starts it. Doing what starts one is an
outward-facing action: the agent may prepare it, and a human does it, or asks for it by name, each
time. Conditions this could not read are quoted, not interpreted.

- **npm** (`.github/workflows/release.yml:56`): when running the workflow by hand. Only if `github.event_name == 'workflow_dispatch' && inputs.target != 'npm'` (line 32).

## What a human still has to do

Run the CLI against a real repo and read the generated docs yourself; a suite cannot judge whether a generated sentence is true.

## Consequence

Code is authoritative for what is committed. Only a human observation is authoritative for what
is live. Never report a write as persisted, a deploy as landed, or a screen as rendered — report
what the code does, and name exactly what a human should look at.
