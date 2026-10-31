#!/usr/bin/env bash
# Tests scripts/auto-update.sh: a throwaway "GitHub" repo and server copy in
# a temp folder, and a fake pm2 that reports crashes when app.js contains
# CRASH_ON_START. Needs git, node and npm (it installs the bot's dependencies
# once). Run: bash test/auto-update.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
G="git -c user.email=test@example.com -c user.name=test"
failures=0
check() { if eval "$2"; then echo "  PASS $1"; else echo "  FAIL $1"; failures=$((failures + 1)); fi; }

mkdir -p "$T/bin"
cat > "$T/bin/pm2" <<'EOF'
#!/usr/bin/env bash
n=$(cat "$FAKE_PM2_STATE" 2>/dev/null || echo 3)
case "$1" in
  restart) n=$((n + 1)); echo $n > "$FAKE_PM2_STATE"; echo "[PM2] restarted $2" ;;
  jlist)
    st=online
    if grep -q CRASH_ON_START "$FAKE_APP_DIR/app.js"; then n=$((n + 7)); echo $n > "$FAKE_PM2_STATE"; st=errored; fi
    echo "[{\"name\":\"hostbot\",\"pm2_env\":{\"status\":\"$st\",\"restart_time\":$n}}]" ;;
esac
EOF
chmod +x "$T/bin/pm2"

# "GitHub" = origin.git; the server copy = app; changes are pushed from dev
mkdir "$T/seed"
(cd "$ROOT" && git ls-files -z | xargs -0 tar -cf - ) | (cd "$T/seed" && tar -xf -)
(cd "$T/seed" && git init -q -b master && git add -A && $G commit -qm v1)
git clone -q --bare "$T/seed" "$T/origin.git"
git clone -q "$T/origin.git" "$T/app"
git clone -q "$T/origin.git" "$T/dev"
(cd "$T/app" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1) || { echo "npm ci failed"; exit 1; }

push() { (cd "$T/dev" && git add -A && $G commit -qm "$1" && git push -q origin master); }
run() {
  PATH="$T/bin:$PATH" FAKE_PM2_STATE="$T/pm2state" FAKE_APP_DIR="$T/app" AUTO_UPDATE_HEALTH_WAIT=1 \
    bash "$T/app/scripts/auto-update.sh"
  echo $? > "$T/exit"
}
on() { git -C "$T/app" log -1 --format=%s; }
logged() { grep -q "$1" "$T/app/auto-update.log"; }

echo "== normal update"
echo "// harmless change" >> "$T/dev/app.js"; push "harmless change"; run
check "updated and restarted, healthy" '[ "$(on)" = "harmless change" ] && logged "healthy after"'

echo "== syntax error"
echo "function (" >> "$T/dev/app.js"; push "broken syntax"; run
check "rolled back before restarting" '[ "$(on)" = "harmless change" ] && logged "FAILED: app.js has a syntax error" && logged "the bot kept running"'
run
check "the same broken version is skipped" '[ "$(cat "$T/exit")" = 0 ] && [ "$(on)" = "harmless change" ]'

echo "== crashes on start"
sed -i '$ d' "$T/dev/app.js"; echo "// CRASH_ON_START" >> "$T/dev/app.js"; push "crashes at startup"; run
check "rolled back and restarted on the old code" '[ "$(on)" = "harmless change" ] && logged "isn.t healthy after the restart" && logged "restarted hostbot on"'

echo "== dependency that can't be installed"
sed -i '/CRASH_ON_START/d' "$T/dev/app.js"
(cd "$T/dev" && node -e 'const p=require("./package.json");p.dependencies["is-number"]="7.0.0";require("fs").writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")')
push "package.json only"; run
check "rolled back, old dependencies back" '[ "$(on)" = "harmless change" ] && logged "installing the dependencies failed" && [ -d "$T/app/node_modules/acorn" ]'

echo "== dependency added with the lockfile"
(cd "$T/dev" && npm install --no-audit --no-fund --package-lock-only >/dev/null 2>&1); push "lockfile for is-number"; run
check "installed and restarted" '[ "$(on)" = "lockfile for is-number" ] && [ -d "$T/app/node_modules/is-number" ]'

echo "== a file the update adds already lies here untracked"
echo '{"left": "by an npm install on the server"}' > "$T/app/server-made.json"
echo '{"from": "github"}' > "$T/dev/server-made.json"; push "adds server-made.json"; run
check "set aside, then updated" '[ "$(on)" = "adds server-made.json" ] && grep -q github "$T/app/server-made.json" && ls "$T/app/.auto-update-aside/" | grep -q "^server-made.json\." && logged "set aside the untracked server-made.json"'

[ "$failures" = 0 ] && echo "auto-update: all passed" || echo "$failures AUTO-UPDATE TEST(S) FAILED"
exit "$failures"
