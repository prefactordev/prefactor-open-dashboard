import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,mjs}"],
    // The API regression suite boots real HTTP servers (the dashboard server
    // as a child process plus a synthetic upstream); give it room on slow CI.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      // server.mjs and server/env.mjs are exercised by tests/api.test.mjs as
      // a CHILD PROCESS over real HTTP — thorough, but invisible to in-process
      // V8 coverage, so measuring them here would only report a false zero.
      include: ["src/lib/**", "server/sync.mjs"],
      reporter: ["text", "lcov"],
      // Gates sit a few points under current reality (lib ≈99% lines,
      // sync ≈74%) so they catch coverage COLLAPSE, not routine edits.
      thresholds: {
        "src/lib/**": { statements: 95, branches: 85, functions: 95, lines: 95 },
        "server/sync.mjs": { statements: 65, branches: 50, functions: 80, lines: 65 },
      },
    },
  },
});
