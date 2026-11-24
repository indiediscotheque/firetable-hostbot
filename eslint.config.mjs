// ESLint for the bot: catches undeclared variables (accidental globals) and
// other mistakes before they reach the server. Runs in CI (test.yml); on your
// computer: cd test && npm ci && npm run lint
// Only Node's own modules are imported, so it works from test/'s ESLint
// without installing anything at the top level (the bot server never installs it).
import { readFileSync } from "fs";

// File and function length (test/line-limits.mjs, CLAUDE.md "File size"): 500
// lines of code a file and 80 a function, comments and blank lines not counted.
// Files already over keep their own cap, which only goes down; their long
// functions show as warnings (to split when they're next changed).
const LIMITS = JSON.parse(readFileSync(new URL("./test/line-limits.json", import.meta.url), "utf8"));
const COUNTED = { skipBlankLines: true, skipComments: true };
const sizeRules = Object.entries(LIMITS).filter(([file]) => file !== "//").map(([file, cap]) => ({
  files: [file],
  rules: {
    "max-lines": ["error", { max: Math.max(500, cap.lines || 0), ...COUNTED }],
    ...(cap.longFunctions ? { "max-lines-per-function": ["warn", { max: 80, ...COUNTED, IIFEs: false }] } : {})
  }
}));
const nodeGlobals = Object.fromEntries([
  "require", "module", "exports", "process", "console", "Buffer", "URL", "URLSearchParams",
  "fetch", "AbortSignal", "AbortController", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "setImmediate", "clearImmediate", "__dirname", "__filename"
].map((n) => [n, "readonly"]));

export default [
  {
    files: ["app.js", "lib/**/*.js", "tools/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: nodeGlobals },
    rules: {
      "no-undef": "error",
      "no-redeclare": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      "no-unused-vars": ["warn", { vars: "local", args: "none", caughtErrors: "none" }],
      "max-lines": ["error", { max: 500, ...COUNTED }],
      "max-lines-per-function": ["error", { max: 80, ...COUNTED, IIFEs: false }]
    }
  },
  ...sizeRules
];
