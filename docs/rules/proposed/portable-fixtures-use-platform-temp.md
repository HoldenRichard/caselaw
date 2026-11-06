# portable-fixtures-use-platform-temp

**Trigger:** Creating temporary fixtures in tests intended for multiple operating systems

**Rule:** Build scratch paths with the platform temp directory and clean fixtures after each test. A successful macOS run does not establish Linux compatibility; require the supported CI matrix before releasing.

**Origin:** commit 7142520: Linux Node 20 and 22 CI failed eleven controls because the fixture helper hardcoded /private/tmp; CI run 42274832895.

**Enforcement:** memory
