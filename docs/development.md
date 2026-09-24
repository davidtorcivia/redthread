# Development

## How it fits together

```
vault/*.md ──▶ build/parse_vault.py ──▶ data/*.json ──▶ Astro + Pagefind ──▶ web/dist/ ──▶ nginx
```

- **`build/parse_vault.py`** reads every note, resolves links and aliases, finds implicit mentions, and computes hubs (PageRank), bridges, clusters (Louvain), related entries, and the network layout. It writes JSON to `data/`.
- **`web/`** is an Astro site that renders pages from that JSON at build time. Pagefind indexes the result for search.
- **`build.sh`** runs both steps and publishes to `web/dist/`.
- **`deploy/`** has the nginx config and `rebuild.sh`.

The browser loads two shared files at runtime: `adjacency.json` powers the network views and path finder, and `previews.json` powers link previews. `build.sh` adds a content hash to their URLs, so browsers only refetch them when the data changes.

## Run it locally

```sh
python3 -m venv .venv && .venv/bin/pip install -r build/requirements.txt
cp .env.example .env && cp config.example.json config.json
./build.sh                  # parse the vault and build once
cd web && npm run dev       # hot reload for UI work at http://localhost:4321
```

The dev server uses the data from the last `./build.sh`. Rerun it after you change the parser or the vault.

## Tests

```sh
python3 -m unittest discover -s build     # parser
cd web && npm test                         # build-time libraries
```

Browser tests run against a built site:

```sh
cd web
npx playwright install chromium
npm run preview &                          # serves web/dist on :4321
BASE_URL=http://127.0.0.1:4321 npm run test:ui
```

## Repo layout

```
build/          vault parser and its tests
web/src/pages/  routes
web/src/lib/    build-time data helpers and site settings (site.ts)
web/src/scripts/  browser code: graph canvas and path finding
web/src/components/, layouts/, styles/
deploy/         nginx template and rebuild script
docs/           these docs
```
