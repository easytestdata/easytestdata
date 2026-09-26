import js from "@eslint/js";

const nodeGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly"
};

const browserGlobals = {
  AbortController: "readonly",
  Blob: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  console: "readonly",
  document: "readonly",
  history: "readonly",
  fetch: "readonly",
  localStorage: "readonly",
  navigator: "readonly",
  performance: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  window: "readonly"
};

export default [
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.turbo/**", "**/coverage/**"]
  },
  js.configs.recommended,
  {
    files: ["packages/*/src/**/*.js", "packages/*/bin/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["packages/*/tests/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...nodeGlobals,
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        vi: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["packages/*/build.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
    }
  },
  {
    // Marketing playground: browser ES modules bundled by packages/marketing/build.js
    // (render.js and core-adapter.js are also imported by build.js in Node).
    files: ["packages/marketing/src/playground/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...browserGlobals, FormData: "readonly" }
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
    }
  }
];
