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
