# one-writer-per-repo

**Trigger:** any session that will WRITE to a repository — edits, commits, pushes —
while another agent or person may also be working in it.

**Rule:** one writing agent per repo at a time. Note the working-tree state before
editing; if a file you did not touch changes mid-turn, STOP and flag it rather than
racing. Never commit another writer's in-flight work under your message, and never
claim verification from a build that compiled their uncommitted edits.

**Why the verification half matters:** scoping `git add` protects the *commit* but not
the *evidence*. A suite that went green over a binary containing someone else's
unreviewed changes is not evidence about yours.

**Origin (upstream):** mid-turn, a source file went from clean to substantively edited
while a batch of fixes was being built. Caught by an unexplained entry in
`git diff --stat` plus a modification time inside the turn window. The work was staged
rather than committed, the other session's change landed separately, and the batch
resumed on a clean tree.

**Cheap detector:** `git status -s` at the start of a turn, and treat any unexplained
path in a later `git diff --stat` as stop-and-investigate rather than as your own
formatter's doing.

**Enforcement:** memory

---
_Candidate, not in force. `caselaw rule adopt one-writer-per-repo --origin "<your incident>"`._
