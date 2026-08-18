# Security policy

This dashboard holds a Prefactor admin API token and displays everything your agents did, so its security posture matters more than its size suggests.

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Email **security@prefactor.tech** with the details, or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository. We aim to acknowledge within 48 hours.

## Supported versions

Only the latest release/`main` is supported. There is no LTS branch — updates are cheap (`git pull && npm install && npm start`).

## The security model, so you know what's a bug

- **The API token never reaches the browser.** It lives server-side (env, `DATA_DIR/config.json` mode 0600, mirrored to `.env`), and no endpoint returns it. Anything that exposes the token to a browser or log is a vulnerability.
- **Loopback by default.** The server binds `127.0.0.1`; binding wider _requires_ `DASHBOARD_PASSWORD` (HTTP Basic, constant-time compare) or the server refuses to start.
- **DNS-rebinding guard.** Non-localhost `Host` headers are rejected (403) unless allow-listed via `ALLOWED_HOSTS`.
- **No CORS headers are sent**, and `POST /api/config` accepts only `application/json`, so cross-origin browser requests can't reach state-changing endpoints.
- **Host changes require re-supplying the token**, so a request can't redirect the stored token to an attacker's server.
- **The cache stores projections, not raw payloads** — sensitive values wrapped `$sensitive` by the SDK are reduced to their labels; contents are never persisted.
- **Zero runtime dependencies** on the server: the attack surface is Node's standard library and this repo's code.

Behaviour contradicting any of the above is a reportable vulnerability, and there are regression tests for most of it in `tests/api.test.mjs`.
