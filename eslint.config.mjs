// ESLint for the bot: catches undeclared variables (accidental globals) and
// other mistakes before they reach the server. Runs in CI (test.yml); on your
// computer: cd test && npm ci && npm run lint
// No imports, so it works from test/'s ESLint without installing anything at
// the top level (the bot server never installs it).
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
      "no-unused-vars": ["warn", { vars: "local", args: "none", caughtErrors: "none" }]
    }
  }
];
