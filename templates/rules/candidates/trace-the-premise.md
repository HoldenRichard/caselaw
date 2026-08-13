# trace-the-premise

**Trigger:** implementing against any brief, spec, ticket, or remembered claim that
quotes a mechanism, a spec line, or existing copy.

**Rule:** locate the quoted premise in the shipped code or docs FIRST. If it is
absent, or reads differently, STOP and flag the premise error. Never build against
the paraphrase. For an *interaction* bug specifically, find the handler before
trusting any description of what is clickable — a description of behaviour is not
evidence of behaviour.

**Origin (upstream):** three documented catches in a five-month mobile build. A brief
described "three staged animation blocks at 0/0.25/0.5" that did not exist in the
renderer. A plan asserted "the spec defines weekly rotation" when no document anywhere
contained it. A brief asked to enlarge a chevron's tap target; the chevron carried no
gesture at all — the whole card was tappable, and the real defect was legibility, so
the correct fix was contrast, not hit area.

**Enforcement:** memory

---
_Candidate, not in force. `caselaw rule adopt trace-the-premise --origin "<your incident>"`._
_You must supply your own Origin: inheriting someone else's evidence is the cargo-culting
this system exists to prevent._
