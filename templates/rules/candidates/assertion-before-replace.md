# assertion-before-replace

**Trigger:** any scripted find/replace (sed, a codemod, an apply script) or hand-edit
against a file a formatter may have touched.

**Rule:** assert the old string occurs EXACTLY ONCE before replacing. Abort on zero
matches and abort on more than one — zero means your premise is stale, and more than
one means you are about to change something you have not looked at. For files a
formatter may have reflowed since you last read them, re-read the exact region before
authoring the edit.

**Origin (upstream):** an edit failed because its target string read "76-char item
budget" while the formatter had earlier reflowed the comment to "76-char budget". The
same batch's apply scripts made uniqueness-assertion standard, after which 25 file
rewrites landed with zero misplaced edits.

**Enforcement:** memory

---
_Candidate, not in force. `caselaw rule adopt assertion-before-replace --origin "<your incident>"`._
