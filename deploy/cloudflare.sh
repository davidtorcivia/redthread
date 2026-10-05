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

version="$("${sync[@]}" upload)"
mkdir -p "$assets"
rsync -a --delete --exclude='*.gz' --exclude='/og/' --exclude='/*/*.md' "$dist/" "$assets/"
[[ -n "${HEADERS_FILE:-}" ]] && cp "$HEADERS_FILE" "$assets/_headers"
# Without an index (no embedding credentials), /api/search answers that it is not built.
npx --yes wrangler@4 deploy --config "$config" ${version:+--var "SEMANTIC_VERSION:$version"}
"${sync[@]}" prune --keep "$version"
