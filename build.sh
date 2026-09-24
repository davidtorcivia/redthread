#!/usr/bin/env bash
# Parse the vault and build the static site.
#
#   VAULT_PATH=/path/to/vault ./build.sh
#
# Settings come from the environment or from .env next to this script.
# The finished site is published to $DIST_DIR (default: web/dist).

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# .env fills in settings; anything already in the environment wins.
if [[ -f "$root/.env" ]]; then
  env_before="$(export -p)"
  set -a; source "$root/.env"; set +a
  eval "$env_before"
fi

vault="${VAULT_PATH:?Set VAULT_PATH to your vault directory (in .env or the environment)}"
[[ "$vault" = /* ]] || vault="$root/$vault"
dist="${DIST_DIR:-$root/web/dist}"
public="$root/web/public"
python="${PYTHON:-python3}"
[[ -x "$root/.venv/bin/python" && -z "${PYTHON:-}" ]] && python="$root/.venv/bin/python"
command -v rsync >/dev/null || { echo "[build] rsync is required" >&2; exit 1; }

echo "[build] parsing $vault"
"$python" "$root/build/parse_vault.py" --vault "$vault" --out "$root/data"

# Payloads the browser fetches at runtime, plus a markdown twin of every entry.
cp -f "$root/data/previews.json" "$root/data/adjacency.json" "$public/"
find "$public" -mindepth 2 -maxdepth 2 -name '*.md' -type f -delete
[[ -d "$root/data/md" ]] && cp -rf "$root/data/md/." "$public/"

# Content hash appended as ?v= to the JSON fetches, so browsers refetch only when the data changes.
PUBLIC_BUILD_ID="$(cat "$public/adjacency.json" "$public/previews.json" | sha1sum | cut -c1-8)"
export PUBLIC_BUILD_ID

cd "$root/web"
[[ -d node_modules ]] || npm ci --no-audit --no-fund

# Build into a staging dir so a failed build never touches the live one.
out="$root/web/.dist-build"
echo "[build] building site"
npx astro build --outDir "$out"
npx pagefind --site "$out"
rm -f "$out"/search-index/pagefind-{component-ui,modular-ui}.{js,css} "$out/search-index/pagefind-highlight.js"

# Precompressed copies for nginx gzip_static.
find "$out" -type f -size +1024c \
  \( -name '*.html' -o -name '*.css' -o -name '*.js' -o -name '*.json' \
     -o -name '*.xml' -o -name '*.svg' -o -name '*.txt' -o -name '*.md' \) \
  -print0 | xargs -0 -r -P 4 gzip -9 -kf

# --delete-after keeps old hashed assets until every new page has landed.
mkdir -p "$dist"
rsync -a --delete-after --delay-updates "$out/" "$dist/"
echo "[build] done: $dist"
