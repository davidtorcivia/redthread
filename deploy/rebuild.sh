#!/usr/bin/env bash
# Rebuild the site when the vault changes.
#
#   deploy/rebuild.sh           build if anything changed since the last good build
#   deploy/rebuild.sh --force   build now
#   deploy/rebuild.sh --watch   check every $REBUILD_INTERVAL seconds (default 300)
#
# Cron: */5 * * * * /path/to/redthread/deploy/rebuild.sh >> /var/log/redthread.log 2>&1

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# .env fills in settings; anything already in the environment wins.
if [[ -f "$root/.env" ]]; then
  env_before="$(export -p)"
  set -a; source "$root/.env"; set +a
  eval "$env_before"
fi
vault="${VAULT_PATH:?Set VAULT_PATH to your vault directory}"
[[ "$vault" = /* ]] || vault="$root/$vault"
export VAULT_PATH="$vault"
stamp_file="$root/.last-build"
build_log="$root/.last-build.log"

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*"; }

# Healthchecks.io protocol: a plain ping means healthy, /fail means the build broke.
ping() {
  [[ -n "${HEALTHCHECK_URL:-}" ]] || return 0
  curl -fsS -m 10 --retry 2 -o /dev/null "${HEALTHCHECK_URL%/}${1:+/fail}" || true
}

# Everything that should trigger a rebuild: vault notes, config, and the app version.
fingerprint() {
  {
    (cd "$vault" && find . -name '*.md' -not -path './.git/*' -printf '%T@ %s %p\n' | sort)
    cat "$root/config.json" 2>/dev/null || true
    git -C "$root" rev-parse HEAD 2>/dev/null || true
  } | sha1sum | cut -d' ' -f1
}

check() {
  local force="$1" stamp
  # --ff-only never discards local edits; a diverged vault just skips the pull.
  if [[ "${VAULT_PULL:-0}" == 1 ]] && ! git -C "$vault" pull --quiet --ff-only; then
    log "vault pull failed; building what is checked out"
  fi
  stamp="$(fingerprint)"
  if [[ "$force" == 0 && "$stamp" == "$(cat "$stamp_file" 2>/dev/null)" ]]; then
    ping
    return 0
  fi
  log "building"
  if "$root/build.sh" > "$build_log" 2>&1; then
    printf '%s' "$stamp" > "$stamp_file"
    log "built"
    ping
  else
    # build.sh only publishes on success, so the last good site keeps serving.
    log "build failed, last 40 lines:"
    tail -n 40 "$build_log"
    ping fail
    return 1
  fi
}

# The lock covers one check, so --force and cron still run while --watch sleeps.
locked_check() {
  (
    flock -n 9 || { log "another rebuild is running"; exit 0; }
    check "$1"
  ) 9>"$root/.rebuild.lock"
}

case "${1:-}" in
  "")      locked_check 0 ;;
  --force) locked_check 1 ;;
  --watch)
    while true; do
      locked_check 0 || true
      sleep "${REBUILD_INTERVAL:-300}"
    done ;;
  *) echo "usage: $0 [--force|--watch]" >&2; exit 2 ;;
esac
