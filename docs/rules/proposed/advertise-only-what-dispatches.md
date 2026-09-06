# advertise-only-what-dispatches

**Trigger:** Adding, renaming or documenting a CLI command, subcommand or flag; writing any string that tells a user to run one.

**Rule:** A shipped string may name a command only if the dispatcher resolves it. Wire the command first, then advertise it; the test that scans every advertised invocation against the command table is the check, not a reviewer's memory.

**Origin:** 757415c

**Enforcement:** test: test/unit/cli-surface.test.js
