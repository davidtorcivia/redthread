#!/usr/bin/env bash
# Server rebuild script — meant for a cron job on the deploy box.
#
# Pulls the vault repo. If anything changed (or if forced), runs the
# build pipeline and recreates the nginx container. Exits 0 quickly
# when there's nothing to do, so a 5-minute cron is essentially free.
#
# Configure the paths at the top to match your server layout. Example
# crontab line:
#
#   */5 * * * * /srv/info-web/deploy/rebuild.sh >> /var/log/info-web.log 2>&1
#
# Optional: pass --force to rebuild even when the vault hasn't moved.

set -euo pipefail

# ---------- Configure these ----------
VAULT_DIR="${VAULT_DIR:-/srv/info-web/vault}"
REDTHREAD_DIR="${REDTHREAD_DIR:-/srv/info-web/redthread}"
SITE_URL="${SITE_URL:-https://infoweb.example.com}"
LOCK_FILE="${LOCK_FILE:-/tmp/redthread-rebuild.lock}"
# ------------------------------------

force=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) force=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*"; }

# Single-instance lock so an overlap (long build + cron firing again)
# can't run two builders concurrently against the same data dir.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another rebuild is in progress; exiting"
  exit 0
fi

# Pull the vault. Compare HEAD before/after to decide whether anything
# actually changed; if not, exit without burning CPU.
if [[ ! -d "$VAULT_DIR/.git" ]]; then
  log "ERROR: $VAULT_DIR is not a git repo. Clone the vault there first."
  exit 1
fi

cd "$VAULT_DIR"
old_head="$(git rev-parse HEAD)"
git fetch --quiet origin
git reset --hard --quiet origin/HEAD
new_head="$(git rev-parse HEAD)"

if [[ "$force" -eq 0 && "$old_head" == "$new_head" ]]; then
  log "vault unchanged (HEAD=$new_head); skipping"
  exit 0
fi

log "vault changed: $old_head → $new_head — rebuilding"

# Optional: also pull the build pipeline so server picks up bugfixes /
# new features without manual intervention. Comment out if you'd rather
# pin the pipeline version.
if [[ -d "$REDTHREAD_DIR/.git" ]]; then
  pushd "$REDTHREAD_DIR" > /dev/null
  git fetch --quiet origin
  git reset --hard --quiet origin/HEAD || true
  popd > /dev/null
fi

cd "$REDTHREAD_DIR"

# Run the parse + Astro build. SITE_URL is baked into canonical URLs,
# OG tags, sitemap, robots.txt.
SITE_URL="$SITE_URL" VAULT_PATH="$VAULT_DIR" ./build.sh

# Rebuild and restart the container so it picks up the new dist/.
# In production add the prod overlay to wire in cloudflared:
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

log "rebuild complete"
