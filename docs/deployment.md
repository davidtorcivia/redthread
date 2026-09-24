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
