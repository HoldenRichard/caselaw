# scope-includes-owned-artifacts

**Trigger:** Changing a file inventory, managed adapter, or scope-completeness check.

**Rule:** Include shipped enforcement/runtime and template paths, the package manifest, and the configured doctrine directory in validation scope. Exercise a nondefault directory and a secondary batch path, and reject omitted or fabricated file claims.

**Origin:** bdd52ca; post-0.4.1 audit on 2026-11-13, F1/F2/F8/F11. See docs/audits/post-041-hardening-2026-11-13.md and the finding-specific positive controls.

**Enforcement:** memory
