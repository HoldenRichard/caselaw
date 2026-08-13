# Known issues

Tracked debt. The point of this file is the opposite of a to-do list: it exists
so that nobody — human or agent — "fixes" something that is already known,
already understood, and deliberately not being fixed yet.

Check here before repairing anything that looks wrong.

## Rules

- **No "verify" entries.** An entry that says "verify whether X" has no owner
  and lingers forever. Verify first, then log what you found.
- Every entry names a location, what it does now, what it should do, and a
  severity.
- Resolved entries move to the bottom rather than being deleted — the record of
  what was wrong is worth keeping.

## Severity

`blocker` · `pre-release` · `later` · `cosmetic`

## Open

<!-- Example of the shape. Replace it. -->

### 1. <Short title>
- **Where:** `path/to/file.ext:123`
- **Now:** <what the code currently does>
- **Should:** <what it should do>
- **Severity:** later
- **Why not yet:** <the honest reason — this is the field people skip and the
  one that stops the same argument happening twice>

## Resolved

<!-- Move entries here with the commit that closed them. -->
