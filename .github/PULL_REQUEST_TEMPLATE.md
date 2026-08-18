## What & why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## How it was verified

- [ ] `npm run verify` passes (lint + typecheck + tests + build)
- [ ] Tested against `npm run demo` (or a real account) where the change is visible
- [ ] If this changes `/api/*` behaviour: the API regression tests in `tests/api.test.mjs` were updated **deliberately**, and the change is called out below
- [ ] If this changes what the cache stores: `PROJECTION_VERSION` in `server/sync.mjs` was bumped

## Breaking changes / notes for reviewers

<!-- "None" is a fine answer. -->
