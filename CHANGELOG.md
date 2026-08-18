# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Full test suite (96 tests): unit tests for every metric library, in-process
  sync-engine regression tests, and black-box API regression tests that boot
  the real server over HTTP against a synthetic upstream.
- `npm run demo` — the whole dashboard running on deterministic synthetic data
  (`scripts/mock-upstream.mjs`), no Prefactor account required.
- ESLint (type-aware) + Prettier, wired into `npm run verify` and CI.
- GitHub Actions CI: lint, format check, typecheck, tests, and build across
  Node 18.17/20/22 on Linux and Windows.
- Community health files: CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue and
  PR templates, Dependabot config.
- `Dockerfile` — two-stage build shipping a runtime image with no
  `node_modules` at all, running as a non-root user with a `/data` volume;
  CI builds it on every push, and a release publishes it to GHCR
  (linux/amd64 + arm64).
- Playwright browser smoke suite (`e2e/`) — every tab rendered in a real
  browser against demo mode, wired into CI with failure traces uploaded.
- Coverage gate in CI: thresholds on the metric libraries (95% lines) and the
  sync engine, enforced by `npm run test:coverage`.
- Release automation via release-please (conventional commits → release PR →
  tagged release → Docker publish).
- Per-tab README screenshots regenerated deterministically from demo mode by
  `npm run shots`.

### Fixed

- Environment variables set to the empty string (common in CI/containers) are
  now treated as unset — previously `PORT=""` bound a random port and
  `BIND_HOST=""` tripped the exposure refusal.
- A non-string model id in a span payload is now reported as `unknown` instead
  of the literal model name `[object Object]`.

## [0.1.0] — 2026-08-09

### Added

- Initial release: Risk, Quality (Prefactor + external evals), and Cost tabs
  over a zero-dependency local server with background sync, SSE live updates,
  and a write-only admin token flow.
