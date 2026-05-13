// Single repo-root flat config. `eslint .` from any package dir walks up and
// finds this. Mirrors v1 constraints: no `as any`, no @ts-ignore/@ts-expect-error,
// no empty catch, unused vars must be _-prefixed.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/.mongo-dev/**", // scratch dir for scripts/dev-mongo + ad-hoc verify scripts
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    // config files & Next route handlers may legitimately have unused params
    files: ["**/*.config.{js,mjs,ts}", "apps/web/**/route.ts", "apps/web/**/page.tsx"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
);
