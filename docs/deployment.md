# Deployment

## Docker

The compose file runs two containers:

- **builder** (`ghcr.io/davidtorcivia/redthread`) watches your vault and rebuilds the site into a shared volume.
- **web** (`nginx:alpine`) serves that volume on `127.0.0.1:$PORT`.

```sh
cp .env.example .env
cp config.example.json config.json
docker compose up -d
docker compose logs -f builder
```

The compose file mounts `config.json`, so it has to exist even if it's just `{}`.

To rebuild right away: `docker compose exec builder deploy/rebuild.sh --force`.

To update, pull the new image and restart:

```sh
git pull
docker compose pull && docker compose up -d
```

To build the image yourself, run `docker compose build`.

If the vault is a git clone that you push to from elsewhere, set `VAULT_PULL=1` and the builder pulls before each check. Pulls are fast-forward only, so local edits are never overwritten.

## Without Docker

You need Python 3.11+, Node 22+, and rsync.

```sh
python3 -m venv .venv
.venv/bin/pip install -r build/requirements.txt
cp .env.example .env
cp config.example.json config.json
./build.sh
```

The site lands in `web/dist/`. Serve it with any static server. For nginx, use `deploy/nginx.conf`. It's a template for the official nginx image, so outside Docker replace `${ANALYTICS_ORIGIN}` yourself.

`build.sh` builds into a staging directory and only publishes on success, so a failed build never takes the site down.

### Rebuild automatically

`deploy/rebuild.sh` rebuilds when a note, `config.json`, or the checked-out code changes:

```sh
deploy/rebuild.sh            # build if anything changed
deploy/rebuild.sh --force    # build now
deploy/rebuild.sh --watch    # keep checking every $REBUILD_INTERVAL seconds
```

From cron:

```
*/5 * * * * /srv/redthread/deploy/rebuild.sh >> /var/log/redthread.log 2>&1
```

The full output of the last build is in `.last-build.log`.

## Going public

nginx binds to `127.0.0.1`, so put something in front of it: Cloudflare Tunnel, Caddy, Traefik, or another nginx. Point it at `http://127.0.0.1:$PORT` and let it handle TLS.

With Cloudflare Tunnel, add a public hostname that routes `your.domain` to `http://localhost:8080`.

Set `SITE_URL` to the public address before you build. Canonical links, social cards, and the sitemap all use it.

## Cloudflare Workers

`deploy/cloudflare.sh` publishes a built site to a Cloudflare Worker (Workers Paid). The Worker in `worker/` serves the static pages as assets and adds:

- `/mcp`: an MCP server (streamable HTTP, stateless, no auth) with the tools `search`, `get_entry`, `neighbors`, `find_path` and `similar`.
- `/api/search`, `/api/entry`, `/api/neighbors`, `/api/path`, `/api/similar`: the same tools over GET, returning JSON.
- OG images and the `.md` twins, read from R2 instead of the asset upload. That keeps the asset count near one file per page, under the 100,000-file limit per Worker version.

Search needs the semantic index, so set `CLOUDFLARE_ACCOUNT_ID` and `WORKERS_AI_API_TOKEN` for the build (see [configuration](configuration.md)). Without it, `search` answers that the index is not built and the other tools still work.

Setup:

1. Create an R2 bucket: `npx wrangler r2 bucket create <name>`.
2. Copy `worker/wrangler.example.jsonc` somewhere outside the repo, then set the Worker name, your domain, the bucket name, and the paths: `main` points at `worker/index.ts`, and `assets.directory` must match `ASSETS_DIR`.
3. After each build, run:

   ```sh
   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... R2_BUCKET=<name> \
     ASSETS_DIR=<assets.directory> deploy/cloudflare.sh path/to/wrangler.jsonc
   ```

   The token needs Workers Scripts Edit and R2 read and write. To port the nginx security headers, write a [`_headers`](https://developers.cloudflare.com/workers/static-assets/headers/) file and pass it as `HEADERS_FILE`.
4. Set `AGENT_API=1` in `.env` so `llms.txt` lists the endpoints.
5. Add a zone rate-limiting rule (Security > WAF > Rate limiting rules; one is included on the Free plan) on your domain: match `starts_with(http.request.uri.path, "/api/") or http.request.uri.path eq "/mcp"`, count per IP, for example 20 requests per 10 seconds, action Block. The Worker's own limiter binding is only a best-effort second layer: its counters are per location and permissive.

Uploads go through the Cloudflare REST API at 3 requests a second, and only files whose MD5 changed are sent. The first deploy of a large site takes a while (about 40 minutes for 7,000 files); later ones send a few dozen. Each search embeds the query with Workers AI (about $0.01 per 40,000 queries at current prices), and the Worker caches tool results for an hour. The rate limit is the zone rule from step 5.
