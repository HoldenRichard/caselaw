# Authority split — caselaw

Generated 2026-08-13 from the install interview.

This file says who can verify what. It is the difference between "the agent said it works" and
"someone checked". Regenerate it with `caselaw upgrade`; edit `.caselaw/answers.json`, not this file.

## The agent can

- Run: test (`npm run test`, unverified); typecheck (`npm run typecheck`, unverified).
- It can run the full suite, the self-audit, gitleaks and trufflehog, and install itself into a scratch repo end to end.

## The agent cannot — physical

No process could do these from this machine. They are not policy; they are facts about the world.

- **see what the UI actually renders**

## The agent cannot — chosen

Technically reachable, deliberately withheld. If one of these ever needs to change, change it
here first and say why — an undocumented loosening is how a boundary quietly stops existing.

- **read production datastore state**

## What a human still has to do

Run the CLI against a real repo and read the generated docs yourself; a suite cannot judge whether a generated sentence is true.

## Consequence

Code is authoritative for what is committed. Only a human observation is authoritative for what
is live. Never report a write as persisted, a deploy as landed, or a screen as rendered — report
what the code does, and name exactly what a human should look at.
