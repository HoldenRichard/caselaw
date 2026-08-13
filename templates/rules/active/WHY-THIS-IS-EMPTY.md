# This directory is empty on purpose

`harness` ships **zero ratified rules**.

Every rule in a case-law system exists because something specific went wrong in a
specific codebase. Handing you a starter pack of other people's rules would give
you instructions with no evidence behind them — and "we do it this way because a
tool said so" is exactly the failure mode this whole system exists to prevent.

So this directory fills up as you work, not at install time.

## Getting the first one

When an agent gets something wrong here and you can name the root cause, that is a
rule. Draft it:

```
harness rule propose no-schema-edits-without-a-migration
```

Then ratify it yourself once the Origin is real. Watch one number: **how long
until your first ratified rule.** If it has been two weeks and `active/` is still
empty, either nothing has gone wrong (unlikely) or proposing is too much friction
(likely) — and the second one is worth fixing.

## If you want a head start

`../candidates/` holds five rules extracted from a real five-month build. They are
universal enough to be worth reading, and they are **not in force**. Adopting one
requires writing your own Origin:

```
harness rule adopt trace-the-premise --origin "PR #418: built against a spec line that did not exist"
```

That requirement is the point. If you cannot name a time it bit you, you do not
need the rule yet.
