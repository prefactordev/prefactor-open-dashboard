# Contributing

Thanks for helping make this dashboard better. This is a small, deliberately dependency-light codebase — most changes are a single file plus a test.

## Getting set up

```bash
git clone https://github.com/prefactordev/prefactor-open-dashboard.git
cd prefactor-open-dashboard
npm install
npm run demo     # full dashboard on http://localhost:8788 with synthetic data — no account needed
```

`npm run demo` boots a synthetic Prefactor API (`scripts/mock-upstream.mjs`) and points the dashboard at it, so every tab has data. To develop against a real account instead, use `npm run dev` (Vite with live reload on :5173) with your token in `.env` or the Admin panel.

## Before you open a PR

Run the same gate CI runs:

```bash
npm run verify   # lint + typecheck + tests + build
```

Or piecemeal: `npm run lint`, `npm run typecheck`, `npm test`, `npm run format`.

## What the tests cover — and what your change probably needs

| You changed…                                      | Add or update tests in…                                                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A metric computation (`src/lib/*`)                | `tests/<lib>.test.ts` — these are pure functions; test the edge that motivated your change                                                                      |
| The server's HTTP behaviour (`server.mjs`)        | `tests/api.test.mjs` — black-box tests over real HTTP against the synthetic upstream                                                                            |
| The sync engine or projection (`server/sync.mjs`) | `tests/sync.test.mjs` — in-process engine tests. **If you change what `projectSpan`/`projectInstance` keep, bump `PROJECTION_VERSION`** so stale caches refetch |
| The upstream API shape                            | `scripts/mock-upstream.mjs` — keep the mock faithful to what the live API actually returns                                                                      |
| Tab layout or rendering (`src/tabs/*`, `App.tsx`) | `e2e/dashboard.spec.ts` — Playwright smoke against demo mode (`npm run test:e2e`); rerun `npm run shots` if the visuals changed                                 |

The API regression suite (`tests/api.test.mjs`) is the contract: `/api/data`, `/api/config`, and `/api/events` responses, auth and host-header guards, gzip, and path-traversal behaviour. If your change makes one of those tests fail, that's a breaking API change — call it out in the PR rather than editing the test quietly.

## Code style

- Formatting is Prettier's job (`npm run format`); linting is ESLint's (`npm run lint`). CI enforces both.
- The server (`server.mjs`, `server/`, `scripts/`) is **zero-dependency Node ESM** on purpose — a monitoring tool holding an API token should have no supply chain to audit. Don't add runtime dependencies there; dev-dependencies for the frontend/tooling are fine.
- Comments explain _why_, not _what_ — especially for anything security-relevant or anything that looks removable but isn't. Follow the existing style.

## Commit messages

Releases are cut by release-please from [conventional commits](https://www.conventionalcommits.org/): `fix:` -> patch, `feat:` -> minor, `feat!:` or a `BREAKING CHANGE:` footer -> major. Other prefixes (`docs:`, `test:`, `chore:`) are welcome and ship with the next release.

## Reporting bugs and proposing features

Use the issue templates. For anything security-sensitive (token handling, network exposure), see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Pricing table updates

`src/lib/cost.ts` holds the per-model price table. PRs that update prices to current published list prices are welcome — link the provider's pricing page in the PR description.
