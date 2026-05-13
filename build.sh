#!/usr/bin/env bash
# End-to-end build for The Info Web (Linux/macOS/Git Bash).
#
# Usage:
#   ./_web/build.sh
#   VAULT_PATH=/path/to/vault ./_web/build.sh

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
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

# Copy previews.json + per-entity neighborhood JSONs into Astro public so
# the browser can fetch them at runtime (hover previews + graph widget).
mkdir -p "$script_dir/web/public"
cp -f "$script_dir/data/previews.json" "$script_dir/web/public/previews.json"

ng_dst="$script_dir/web/public/api/neighborhood"
rm -rf "$ng_dst"
if [[ -d "$script_dir/data/api/neighborhood" ]]; then
  mkdir -p "$ng_dst"
  cp -f "$script_dir/data/api/neighborhood"/*.json "$ng_dst"/
fi

# 2. Build Astro + Pagefind
cd "$script_dir/web"
if [[ ! -d node_modules ]]; then
  echo "[build] installing npm deps..."
  npm install
fi
echo "[build] (2/2) building site..."
npm run build

echo "[build] done -> $script_dir/web/dist"
