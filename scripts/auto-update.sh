#!/usr/bin/env bash
# Keeps the bot on the latest code from GitHub.
#
# Every 5 minutes (cron) it checks the branch on GitHub. When there are new
# commits it pulls them, installs the exact dependency versions in
# package-lock.json if they changed (npm ci), checks app.js and every
# dependency load, restarts the bot with pm2, then watches it for a minute.
# If a check fails, or the restarted bot keeps crashing, it puts the old code
# back (restarting the bot on it if needed) and skips that version until a
# newer commit arrives. Nothing runs when nothing changed.
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

# Everything runs inside main(), so bash has read the whole script before the
# update rewrites this file.
main() {
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  BRANCH="${AUTO_UPDATE_BRANCH:-master}"
  PM2_NAME="${PM2_NAME:-hostbot}"
  HEALTH_WAIT="${AUTO_UPDATE_HEALTH_WAIT:-60}" # seconds the restarted bot must stay up
  LOG="$APP_DIR/auto-update.log"
  STATE="$APP_DIR/.auto-update-state"
  LOCK="/tmp/firetable-hostbot-auto-update.lock"
  CRON_TAG="# firetable-hostbot auto-update"

  export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
  cd "$APP_DIR" || exit 1

  case "${1:-}" in
    --install)
      local line others
      line="*/5 * * * * flock -n $LOCK bash $APP_DIR/scripts/auto-update.sh $CRON_TAG"
      others="$(crontab -l 2>/dev/null | grep -vF "$CRON_TAG")"
      { [ -n "$others" ] && echo "$others"; echo "$line"; } | crontab -
      echo "Auto-update is on: the bot checks GitHub every 5 minutes."
      echo "See what it did with: cat $LOG"
      exit 0
      ;;
    --uninstall)
      local others
      others="$(crontab -l 2>/dev/null | grep -vF "$CRON_TAG")"
      if [ -n "$others" ]; then echo "$others" | crontab -; else crontab -r 2>/dev/null; fi
      echo "Auto-update is off."
      exit 0
      ;;
  esac

  local current_branch
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
  restarted=0

  log "updating ${old:0:7} -> ${new:0:7}"
  git merge -q --ff-only "origin/$BRANCH" >> "$LOG" 2>&1 || rollback "git couldn't apply the update"

  if ! git diff --quiet "$old" "$new" -- package.json package-lock.json; then
    deps_changed=1
    install_deps || rollback "installing the dependencies failed"
  fi

  node --check app.js >> "$LOG" 2>&1 || rollback "app.js has a syntax error"
  deps_load >> "$LOG" 2>&1 || rollback "a dependency is missing or won't load"

  restarts_before="$(pm2_state | cut -d' ' -f2)"
  if ! pm2 restart "$PM2_NAME" --update-env >> "$LOG" 2>&1; then
    log "updated to ${new:0:7}, but 'pm2 restart $PM2_NAME' failed; start it with: pm2 start app.js --name $PM2_NAME && pm2 save"
    rm -f "$STATE.skip" "$STATE.msg"
    exit 1
  fi
  restarted=1

  # The restart itself counts once; any more means pm2 is restarting a crash.
  sleep "$HEALTH_WAIT"
  local state status restarts crashes=""
  state="$(pm2_state)"
  status="${state%% *}"
  restarts="${state##* }"
  if [[ "$restarts_before" =~ ^[0-9]+$ && "$restarts" =~ ^[0-9]+$ ]]; then
    crashes=$((restarts - restarts_before - 1))
  fi
  if [ "$status" = "unknown" ]; then
    log "updated to ${new:0:7} and restarted $PM2_NAME, but couldn't read pm2's status to confirm it's healthy: $(git log -1 --format=%s)"
  elif [ "$status" != "online" ] || [ "${crashes:-0}" -gt 0 ]; then
    rollback "the bot isn't healthy after the restart (pm2 status: $status${crashes:+, crashed $crashes times in ${HEALTH_WAIT}s}; pm2 logs $PM2_NAME shows why)"
  else
    log "updated to ${new:0:7} and restarted $PM2_NAME (healthy after ${HEALTH_WAIT}s): $(git log -1 --format=%s)"
  fi
  rm -f "$STATE.skip" "$STATE.msg"
}

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# Log a message once, not every 5 minutes while the same thing is true.
log_once() {
  if [ "$(cat "$STATE.msg" 2>/dev/null)" != "$1" ]; then
    log "$1"
    printf '%s' "$1" > "$STATE.msg"
  fi
}

# Exactly the versions in package-lock.json (plain npm install for an older
# version without a lockfile).
install_deps() {
  if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund >> "$LOG" 2>&1
  else
    npm install --no-audit --no-fund >> "$LOG" 2>&1
  fi
}

# Every dependency in package.json can be loaded.
deps_load() {
  node -e '
    const deps = Object.keys(require("./package.json").dependencies || {});
    for (const d of deps) require(d);
    console.log("dependencies load: " + deps.join(", "));
  '
}

# "<status> <restart count>" for the bot in pm2, e.g. "online 4"; "unknown ?"
# when pm2 can't be read.
pm2_state() {
  pm2 jlist 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const p = JSON.parse(s.slice(s.indexOf("["))).find((x) => x.name === process.argv[1]);
        console.log(p ? p.pm2_env.status + " " + p.pm2_env.restart_time : "missing ?");
      } catch (e) {
        console.log("unknown ?");
      }
    });
  ' "$PM2_NAME"
}

rollback() {
  log "FAILED: $1. Back on ${old:0:7}. Will retry when a newer commit lands."
  git reset -q --hard "$old"
  if [ "$deps_changed" = 1 ]; then install_deps; fi
  if [ "$restarted" = 1 ]; then
    if pm2 restart "$PM2_NAME" --update-env >> "$LOG" 2>&1; then
      log "restarted $PM2_NAME on ${old:0:7}"
    else
      log "couldn't restart $PM2_NAME on ${old:0:7}; start it with: pm2 restart $PM2_NAME"
    fi
  else
    log "the bot kept running on ${old:0:7}"
  fi
  echo "$new" > "$STATE.skip"
  exit 1
}

main "$@"
exit
