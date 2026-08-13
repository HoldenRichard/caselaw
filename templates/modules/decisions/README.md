# Decision records

One record per locked architectural or product decision. Records are
**immutable once Accepted** — a decision that quietly rewrites itself when it
turns out badly destroys the only thing this directory is for, which is being
able to reconstruct what you knew at the time.

To supersede a decision, write a new record that references the old one.

## Status

- **Proposed** — under consideration
- **Accepted** — locked, in effect
- **Superseded** — replaced by a later record, which is linked
- **Deprecated** — no longer in effect, no replacement

## Two section headings, used deliberately

- **Alternatives considered** — when real alternatives were weighed at decision
  time. Name them and say why each lost.
- **Design space** — when the choice was locked without enumerating
  alternatives, and the record is framing it after the fact against the obvious
  poles.

Keeping these distinct is the honest part. Writing "alternatives considered"
over a decision nobody actually deliberated invents a rigour that was not there,
and future-you will trust it.

## Index

<!-- Add each record here. A decision nobody can find is a decision that gets made again. -->

- [0001 — Adopt the harness](0001-adopt-the-harness.md)
