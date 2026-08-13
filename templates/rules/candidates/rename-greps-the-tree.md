# rename-greps-the-tree

**Trigger:** renaming any user-visible string (display names, titles, labels) or any
identifier that also appears somewhere as a bare literal.

**Rule:** before scoping the rename, grep the FULL tree for the exact literal —
including docs, tests, fixtures, and config, not just the source directory. Every hit
is either renamed in the same commit or explicitly exempted in writing. A rename scoped
to the files you happen to know about ships split-brain copy.

**Origin (upstream):** a badge rename was scoped to the model file that declared the
names, but a separate evaluator constructed those same badges from its own hardcoded
strings at three sites. The pre-edit grep caught it before the earn notification and
the gallery could disagree with each other in production.

**Enforcement:** memory

---
_Candidate, not in force. `caselaw rule adopt rename-greps-the-tree --origin "<your incident>"`._
