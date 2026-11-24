# Notes for Claude

## Branches and repos to leave alone
- Only `master` matters. Don't report other branches as outstanding work, and don't offer to merge, review, integrate or delete them, unless they have an open pull request or the user asks about them.
- `dev` is the original bot's 2017–2020 history from Matt's repo (`mxew/firetable-hostbot`). It shares no history with `master`, and everything useful in it is already in `master`. Ignore it.
- Old `claude/*` and `ccr-*` branches are already merged. Ignore them.
- Don't change Matt's original repos (`mxew/firetable`, `mxew/firetable-hostbot`) and don't suggest changes to them. Only change the indiediscotheque repos.

## Pull requests: open them and merge them
- When work is finished and its tests pass locally, open a pull request to `master` without waiting to be asked, and merge it yourself once it's ready: CI is green on its latest commit and it has no merge conflict.
- Don't merge with CI red or a conflict: fix the cause (never skip or disable a test), push, and merge when it's green.
- After merging, say what's needed to put it live (a bot restart, a workflow run, a deploy).

## File size and where code goes
`app.js` is the room itself: its state, the song flow, and the wiring between the parts. Everything else lives in `lib/`, one job a module, each exporting a `create…(deps)` that's handed what it needs from `app.js` as getters (`lib/push.js`, `lib/gts.js`, `lib/commands.js` and the rest show the pattern), with unit tests in `test/`.
- A new feature goes in a `lib/` module of its own, never as a new section of `app.js`. A function that would pass 80 lines is split into named helpers.
- The limit is ESLint's `max-lines`: 500 lines of code a file and 80 a function (comments and blank lines don't count, so keep writing them). The files already over (`app.js`, `lib/swaps.js`, `lib/commands.js`, `tools/history/reconcile.js` and others) keep today's size as their cap, and so does their count of long functions (`test/line-limits.json`; lint shows those functions as warnings). When you're changing one substantially anyway, move a self-contained part out instead of adding to it, with the tests passing. Never in a sweeping rewrite.
- `npm run size` (in `test/`, run by CI) fails when a file or its long-function count grows, and when one shrinks without the record being lowered (`npm run size -- --write`, committed in the same pull request).
- When moving code into a module, rename references with a parser, not text replacement (a plain search and replace also rewrites the same word inside strings and database paths, which lint and the type check can't see).
