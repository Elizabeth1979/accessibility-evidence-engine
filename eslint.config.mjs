// `npm run lint` runs Oxlint, then ESLint. Oxlint checks every file with the rules in
// `.oxlintrc.json`: ESLint's recommended rules and typescript-eslint's, as `@oxlint/migrate` wrote
// them. ESLint then checks the JavaScript files (`.js`, `.mjs`) with the recommended rules Oxlint
// does not have, `no-undef` among them, which TypeScript covers in the `.ts` files.
// `eslint-plugin-oxlint` turns off every rule Oxlint already runs, so no rule runs twice.
// ESLint reads no TypeScript, so the `.ts` files are left to Oxlint and `tsc`: without that, the
// plugin's copy of Oxlint's `.ts` override would have ESLint parse them as JavaScript.
import eslint from "@eslint/js";
import oxlint from "eslint-plugin-oxlint";
import globals from "globals";

export default [
  {
    ignores: [
      "**/*.ts",
      "**/dist/**",
      "**/node_modules/**",
      "aee-output/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**"
    ]
  },
  eslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ["site/**/*.js"],
    languageOptions: {
      globals: globals.browser
    }
  },
  ...(await oxlint.buildFromConfigFile(".oxlintrc.json"))
];
