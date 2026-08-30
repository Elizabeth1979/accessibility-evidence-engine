import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "aee-output/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
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
  {
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off"
    }
  }
);
