#!/usr/bin/env bash
# End-to-end build for The Info Web (Linux/macOS/Git Bash).
#
# Usage:
#   ./_web/build.sh
#   VAULT_PATH=/path/to/vault ./_web/build.sh

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"

# Auto-load env vars from .env next to this script (same file docker compose
# already auto-loads — keeps local and docker builds consistent).
if [[ -f "$script_dir/.env" ]]; then
  set -a; source "$script_dir/.env"; set +a
fi

vault_path="${VAULT_PATH:-$project_root}"

echo "[build] vault: $vault_path"
echo "[build] output: $script_dir/web/dist"

# 1. Parse vault → JSON indices. Prefer py launcher on Windows (where
# python3 is often shadowed by the "install from store" stub).
echo "[build] (1/2) parsing vault..."
if command -v py >/dev/null 2>&1; then
  py "$script_dir/build/parse_vault.py" --vault "$vault_path" --out "$script_dir/data"
else
  python3 "$script_dir/build/parse_vault.py" --vault "$vault_path" --out "$script_dir/data"
fi

# Copy runtime-fetched data into Astro public/. previews.json drives the
# wikilink hover-preview popovers; adjacency.json is the shared dataset
# for /network/, /path/, and every entity page's NetworkGraph widget.
mkdir -p "$script_dir/web/public"
cp -f "$script_dir/data/previews.json" "$script_dir/web/public/previews.json"
cp -f "$script_dir/data/adjacency.json" "$script_dir/web/public/adjacency.json"

# Clean up any stale per-entity neighborhood JSONs from older builds.
rm -rf "$script_dir/web/public/api/neighborhood"

# Cache-buster for the shared JSON payloads. We hash their content and
# stamp the result into ?v=… on every fetch + preload. Same content →
# same hash → browsers reuse their cached copy; vault change → new hash
# → fresh download. Without this, browsers serve stale adjacency.json
# after a rebuild and entity pages report "not in the network".
PUBLIC_BUILD_ID="$(cat "$script_dir/web/public/adjacency.json" "$script_dir/web/public/previews.json" | sha1sum | cut -c1-8)"
export PUBLIC_BUILD_ID
echo "[build] cache version: $PUBLIC_BUILD_ID"

# 2. Build Astro + Pagefind
cd "$script_dir/web"
if [[ ! -d node_modules ]]; then
  echo "[build] installing npm deps..."
  npm install
fi
echo "[build] (2/2) building site..."
npm run build

echo "[build] done -> $script_dir/web/dist"
