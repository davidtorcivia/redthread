#!/usr/bin/env bash
# Publish a built site (web/dist) to a Cloudflare Worker with static assets.
#
#   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... R2_BUCKET=name \
#     deploy/cloudflare.sh path/to/wrangler.jsonc
#
# OG images and markdown twins go to R2 instead of the asset upload, which keeps the
# asset count near one file per page. The semantic index goes to R2 under a content-hash
# prefix that the Worker reads through SEMANTIC_VERSION, so a deploy never pairs one
# build's index with another's vectors. Order: R2 upload, Worker deploy, then R2 prune.
# The wrangler config's assets.directory must be $ASSETS_DIR (default web/.cf-assets).

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="${1:?usage: deploy/cloudflare.sh path/to/wrangler.jsonc}"
bucket="${R2_BUCKET:?Set R2_BUCKET}"
dist="${DIST_DIR:-$root/web/dist}"
assets="${ASSETS_DIR:-$root/web/.cf-assets}"
python="${PYTHON:-python3}"
[[ -x "$root/.venv/bin/python" && -z "${PYTHON:-}" ]] && python="$root/.venv/bin/python"
sync=("$python" "$root/deploy/r2_sync.py" --bucket "$bucket" --dist "$dist" --semantic "$root/data/semantic")

# A build that is missing or still being written (astro empties dist first) must not
# replace the live site. FORCE_DEPLOY=1 allows an intended shrink.
count() { find "$1" -type f ! -name '*.gz' 2>/dev/null | wc -l; }
if [[ ! -f "$dist/index.html" ]]; then
  echo "[deploy] refusing: $dist has no index.html" >&2; exit 1
fi
if [[ -z "${FORCE_DEPLOY:-}" ]] && (( $(count "$dist") * 2 < $(count "$assets") )); then
  echo "[deploy] refusing: $dist has $(count "$dist") files, under half of the last deploy's $(count "$assets"); set FORCE_DEPLOY=1 if intended" >&2
  exit 1
fi

version="$("${sync[@]}" upload)"
mkdir -p "$assets"
rsync -a --delete --delete-excluded --exclude='*.gz' --exclude='/og/' --exclude='/*/*.md' --exclude='/fulltext.json' "$dist/" "$assets/"
[[ -n "${HEADERS_FILE:-}" ]] && cp "$HEADERS_FILE" "$assets/_headers"
# Without an index (no embedding credentials), /api/search answers that it is not built.
npx --yes wrangler@4 deploy --config "$config" ${version:+--var "SEMANTIC_VERSION:$version"}
"${sync[@]}" prune --keep "$version"
