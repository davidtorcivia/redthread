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

# Per-entity .md companions: parse_vault writes them under data/md/<dir>/
# and we lay them down beside the HTML in public/<dir>/<slug>.md. LLM
# tools auto-discover these via the rel="alternate" link in the HTML head.
# Remove the previous set first so renamed/deleted entities don't leave
# orphan .md files behind.
for d in people organizations programs events concepts places sources meta misc pages; do
  find "$script_dir/web/public/$d" -maxdepth 1 -name '*.md' -type f -delete 2>/dev/null || true
done
if [[ -d "$script_dir/data/md" ]]; then
  cp -rf "$script_dir/data/md/." "$script_dir/web/public/"
fi

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

# Pagefind ships several alternate UIs alongside the one we use
# (pagefind-ui.js). The component-ui (~217 KB), modular-ui (~150 KB),
# and highlight (~10 KB) bundles are never loaded by this site, so we
# drop them from dist to keep the deploy lean. The core (pagefind.js,
# pagefind-worker.js, pagefind-entry.json, *.pf_meta) and the index/
# fragment/ filter/ directories must stay — pagefind-ui.js pulls them
# in at runtime.
echo "[build] pruning unused pagefind bundles..."
pf="$script_dir/web/dist/pagefind"
rm -f "$pf/pagefind-component-ui.js" "$pf/pagefind-component-ui.css" \
      "$pf/pagefind-modular-ui.js"   "$pf/pagefind-modular-ui.css"   \
      "$pf/pagefind-highlight.js"

echo "[build] done -> $script_dir/web/dist"
