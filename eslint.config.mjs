// Flat ESLint config covering both halves of the repo:
//   - src/**            TypeScript + React (type-aware rules via the TS project)
//   - server/, scripts/, *.mjs   plain Node ESM, zero dependencies
// Prettier handles formatting; eslint-config-prettier switches off every rule
// that would fight it.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", "data/", "test-results/", "playwright-report/"] },

  // --- Node ESM: server, scripts, config files -----------------------------
  {
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.node },
    },
    rules: {
      // The server intentionally swallows errors in specific, commented places
      // (best-effort persistence, dead SSE clients). Empty catch stays legal;
      // everything else recommended applies.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // --- TypeScript + React frontend -----------------------------------------
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // The API returns loosely-typed JSON; narrow with runtime checks, but
      // allow the established `as` casts at the fetch boundary.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },

  // --- unit tests -----------------------------------------------------------
  // TS tests are linted without type-aware rules (they're outside tsconfig's
  // project); .mjs tests are plain Node.
  {
    files: ["tests/**/*.ts", "e2e/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  prettier,
);
