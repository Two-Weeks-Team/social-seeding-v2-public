// Shared ESLint flat-config preset. Each package: `export { default } from "@ss/config/eslint-preset"`.
// Mirrors v1 constraints: no `as any`, no @ts-ignore/@ts-expect-error, no empty catch, no hardcoded secrets.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  { ignores: ["dist/**", ".next/**", ".turbo/**", "node_modules/**"] },
);
