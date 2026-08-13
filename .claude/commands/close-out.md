---
description: End this working session — summarise, hand over what only a human can verify, and propose any rule this session earned.
---

Write a session close-out using the template at `docs/close-out.md`.

Fill it in from what actually happened this session. Rules for each section:

**Verified** — one line per check that really ran, in the form
`<what> — <who ran it> — <what it showed>`. "Tests pass" is not a verification line.
If you did not run it, it does not go here.

**Not verified — over to you** — read `docs/authority-split.md` and hand over exactly the
boundaries it lists as physical or chosen. Do not quietly narrow this list because the change
looked safe; that judgement is the human's, and the list is what makes the handoff explicit.

**Rule proposals** — the reason this command exists. Ask yourself plainly: did anything go
wrong this session with a root cause you can actually name?

- Nothing went wrong → write `none`. This is the common answer and a good one.
- First occurrence of something → note it as an observation, not a rule. One event is not
  yet a pattern.
- Second occurrence of the same class → that is a rule. Run
  `caselaw rule propose <kebab-name>` and fill in the Trigger, the Rule, and — mandatory —
  the Origin: the specific commit, session, or issue that proved it.

You draft proposals. You never ratify them. Moving a rule into `docs/rules/active/` is a
human's act, and a proposal cannot authorise its own promotion.

Do not invent a rule to look thorough. A rule with no incident behind it is a superstition
with a filename, and it costs every future session the attention it takes to read.
