#!/usr/bin/env bash
# Keeps the bot on the latest code from GitHub.
#
# Every 5 minutes (cron) it checks the branch on GitHub. When there are new
# commits it pulls them, runs npm install if package.json changed, checks
# app.js loads, and restarts the bot with pm2. If the check or the install
# fails it puts the old code back, leaves the bot running, and skips that
# version until a newer commit arrives. Nothing runs when nothing changed.
#
# Set up once on the server:   bash scripts/auto-update.sh --install
# Turn off:                     bash scripts/auto-update.sh --uninstall
# Update right now:             bash scripts/auto-update.sh
# What it did:                  cat auto-update.log
#
# Pausing: check out anything other than the branch (for example
# `git checkout HEAD~1` to roll back) and updates stop until you
# `git checkout master` again.

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${AUTO_UPDATE_BRANCH:-master}"
PM2_NAME="${PM2_NAME:-hostbot}"
LOG="$APP_DIR/auto-update.log"
STATE="$APP_DIR/.auto-update-state"
LOCK="/tmp/firetable-hostbot-auto-update.lock"
CRON_TAG="# firetable-hostbot auto-update"

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$APP_DIR" || exit 1

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# Log a message once, not every 5 minutes while the same thing is true.
log_once() {
  if [ "$(cat "$STATE.msg" 2>/dev/null)" != "$1" ]; then
    log "$1"
    printf '%s' "$1" > "$STATE.msg"
  fi
}

case "${1:-}" in
  --install)
    line="*/5 * * * * flock -n $LOCK bash $APP_DIR/scripts/auto-update.sh $CRON_TAG"
    others="$(crontab -l 2>/dev/null | grep -vF "$CRON_TAG")"
    { [ -n "$others" ] && echo "$others"; echo "$line"; } | crontab -
    echo "Auto-update is on: the bot checks GitHub every 5 minutes."
    echo "See what it did with: cat $LOG"
    exit 0
    ;;
  --uninstall)
    others="$(crontab -l 2>/dev/null | grep -vF "$CRON_TAG")"
    if [ -n "$others" ]; then echo "$others" | crontab -; else crontab -r 2>/dev/null; fi
    echo "Auto-update is off."
    exit 0
    ;;
esac

current_branch="$(git symbolic-ref --short -q HEAD || echo detached)"
if [ "$current_branch" != "$BRANCH" ]; then
  log_once "paused: on '$current_branch', not '$BRANCH' (git checkout $BRANCH to resume)"
  exit 0
fi

if ! git fetch -q origin "$BRANCH" 2>>"$LOG"; then
  log_once "couldn't reach GitHub; will try again"
  exit 1
fi

old="$(git rev-parse HEAD)"
new="$(git rev-parse "origin/$BRANCH")"
[ "$old" = "$new" ] && { rm -f "$STATE.msg"; exit 0; }

if [ "$(cat "$STATE.skip" 2>/dev/null)" = "$new" ]; then
  exit 0 # this version already failed; wait for a newer one
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  log_once "paused: files in the bot folder were edited by hand (git status shows them; git checkout -- <file> to undo)"
  exit 1
fi

if ! git merge-base --is-ancestor "$old" "$new"; then
  log_once "paused: this copy has commits GitHub doesn't; fix by hand"
  exit 1
fi

deps_changed=0
rollback() {
  log "FAILED: $1. Back on ${old:0:7}; the bot kept running. Will retry when a newer commit lands."
  git reset -q --hard "$old"
  if [ "$deps_changed" = 1 ]; then npm install --no-audit --no-fund >> "$LOG" 2>&1; fi
  echo "$new" > "$STATE.skip"
  exit 1
}

log "updating ${old:0:7} -> ${new:0:7}"
git merge -q --ff-only "origin/$BRANCH" >> "$LOG" 2>&1 || rollback "git couldn't apply the update"

if ! git diff --quiet "$old" "$new" -- package.json; then
  deps_changed=1
  npm install --no-audit --no-fund >> "$LOG" 2>&1 || rollback "npm install failed"
fi

node --check app.js >> "$LOG" 2>&1 || rollback "app.js has a syntax error"

if pm2 restart "$PM2_NAME" --update-env >> "$LOG" 2>&1; then
  log "updated to ${new:0:7} and restarted $PM2_NAME: $(git log -1 --format=%s)"
else
  log "updated to ${new:0:7}, but 'pm2 restart $PM2_NAME' failed; start it with: pm2 start app.js --name $PM2_NAME && pm2 save"
fi
rm -f "$STATE.skip" "$STATE.msg"
