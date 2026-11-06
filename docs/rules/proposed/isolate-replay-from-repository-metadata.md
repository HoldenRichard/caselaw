# isolate-replay-from-repository-metadata

**Trigger:** Replaying recorded file snapshots or certifying generated gates

**Rule:** Treat fixture paths and bytes as untrusted input. Reject repository control metadata, require complete snapshots of every gate target, and verify with the installed runtime before claiming machine enforcement.

**Origin:** Independent hardening audit at commit 4440a2b reproduced Git configuration execution, missing cross-incident target files, and certification without an installed runner; scratch repros preserved outside the repository.

**Enforcement:** memory
