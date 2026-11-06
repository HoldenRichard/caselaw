# history-checks-need-full-checkout

**Trigger:** Configuring CI or publishing jobs that verify historical commit citations

**Rule:** Fetch the complete repository history before checking rule Origins or other historical references. A shallow checkout cannot establish that an older cited commit is absent.

**Origin:** commit 1b77274: Node 20/22 tests passed but self-audit failed because CI run 42275335997 could not resolve the older active-rule Origin in a shallow checkout.

**Enforcement:** memory
