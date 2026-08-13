# config-identity-gate

**Trigger:** swapping, rotating, or verifying any credential or config artifact — API
keys, service account files, signing assets, connection strings.

**Rule:** gate every step on the artifact's IDENTITY, never on having performed the
rotation. Record the identity (last 4 characters in anything committed or reported) and
compare it. A freshly downloaded artifact that still carries the OLD identity means the
backend association never moved: STOP, do not swap it in, and diagnose the association
instead. "I clicked rotate" is not evidence that anything rotated.

**Origin (upstream):** a cloud console's rotate flow created a new key, but the
application config kept serving the previous key in a freshly downloaded file. The
last-4 identity check stopped two would-be swaps before deleting the old key finally
re-pointed the association. Logged as a near-miss with real deployment consequences.

**Enforcement:** memory

---
_Candidate, not in force. `harness rule adopt config-identity-gate --origin "<your incident>"`._
