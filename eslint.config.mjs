import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import { defineConfig } from "eslint/config";

const prettierOptions = {
  printWidth: 80,
  bracketSpacing: true,
  singleQuote: true,
  semi: false,
  trailingComma: "es5",
  endOfLine: "auto",
};

const lineEndingPrettierOptions = {
  endOfLine: "auto",
};

export default defineConfig(
  {
    ignores: [
      "node_modules/**",
      "build/**",
      "dist/**",
      "artifacts/**",
      "vendors/**",
      "scripts/**",
      "postcss.config.js",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    rules: {
      "linebreak-style": 0,
      "prettier/prettier": ["error", lineEndingPrettierOptions],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      quotes: "off",
      indent: "off",
      "linebreak-style": 0,
      "object-curly-spacing": ["error", "always"],
      semi: "off",
      "@typescript-eslint/no-explicit-any": "off",
      "space-infix-ops": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "prettier/prettier": ["error", prettierOptions],
    },
  },
);
