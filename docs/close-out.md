# Session close-out — caselaw

Copy this at the end of a working session. It exists for one reason: **`docs/rules/active/`
only fills up if something asks.** Without a standing prompt for rule proposals, the case-law
system stays empty forever and the rest of this harness is decoration.

Keep it short. A close-out nobody writes is worth less than a rough one they do.

---

## What changed

<!-- One or two lines. What is different in the repo now that wasn't before. -->

## Verified

<!-- One line per check that actually ran. Value — who ran it — what it showed.
     "Tests pass" is not a verification line; "node --test test/unit/*.test.js — agent — 41 passed, 0 failed" is. -->

The gates CI runs on a change, job by job, each job in its own order. Run the ones your change touches before calling the
work done; CI will run the rest.

- [ ] `node --test test/unit/*.test.js`
- [ ] `node bin/cli.mjs audit .`
- [ ] `docker run --rm -v "$PWD:/repo"   ghcr.io/gitleaks/gitleaks:v8.30.1   dir /repo --no-banner --no-color --redact`
- [ ] `docker run --rm -v "$PWD:/repo"   -e GIT_CONFIG_COUNT=1   -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/repo   ghcr.io/trufflesecurity/trufflehog:3.96.0   git file:///repo --results=verified --fail --no-update --no-color`

-

## Not verified — over to you

<!-- The device/console/production remainder. Anything on this list is a claim
     nobody has checked yet, so say so plainly rather than implying it is done. -->
How a human proves a change here: Run the CLI against a real repo and read the generated docs yourself; a suite cannot judge whether a generated sentence is true.

Your project's human-only tier, from `docs/authority-split.md`:

- [ ] see what the UI actually renders
- [ ] read production datastore state

## Published?

Did this session do any of these? Each one publishes outside the repository, so each is a human's
to do, or to ask for by name:

- [ ] running the workflow by hand — publishes to npm (`.github/workflows/release.yml:56`), only if `github.event_name == 'workflow_dispatch' && inputs.target != 'npm'` (line 32)

## Rule proposals

<!-- THE LINE THAT MAKES THIS SYSTEM WORK.
     Did anything go wrong this session with a root cause you can name?
     First occurrence: write it down as an observation.
     Second occurrence: that is a rule — `caselaw rule propose <name>`.
     Nothing to propose is a perfectly good answer, and the common one. -->

- none

## Caught by a rule

<!-- Did an active rule stop or catch something this session? Record it, with the
     commit, date or issue that shows it:
     `caselaw rule catch <name> --what "<what it caught>"`. A rule counts once it
     has caught the failure it came from; a default's first catch here becomes
     this project's own Origin for it. -->

- none

## Still open

<!-- Anything parked, blocked, or deliberately deferred. Future-you reads this first. -->

-
