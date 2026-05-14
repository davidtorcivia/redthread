# redthread

> *Pull on the thread.*

A static-site reading layer for connection-rich Obsidian vaults.
Turns a research vault — people, organizations, programs, events,
concepts — into a navigable web with searchable entity pages, a
full-vault network graph, NER-discovered "hidden" connections,
bridge-centrality scoring, BFS path-finding between any two entries,
hover previews, tags, timeline, and full-text search.

Replaces Obsidian Publish for the kind of vaults where the connective
tissue *is* the point. Self-hostable. Source vault stays in Obsidian;
this pipeline reads it as input and emits a static site.

Originally built for [The Info Web](https://git.disinfo.zone/disinfozone/The_Info_Web)
— a parapolitical research vault — but generic: point it at any
markdown vault that uses Obsidian-style `[[wikilinks]]`.

## Architecture

```
┌──────────────┐    parse_vault.py     ┌────────────┐    npm run build   ┌──────────┐
│  vault/*.md  │  ──────────────────▶  │  data/*    │  ───────────────▶  │   dist/  │  ──▶ nginx
│  (Obsidian)  │  parses, NER,         │  JSON      │  Astro + Pagefind  │  static  │
│              │  centrality, layout   │  indices   │                    │  site    │
└──────────────┘                       └────────────┘                    └──────────┘
```

- **Parser** (`build/parse_vault.py`, Python): walks every markdown file
  in the vault, extracts wikilinks + frontmatter + footnotes, computes
  co-occurrence / mention counts, runs NER for implicit links, computes
  betweenness centrality (bridges), and pre-computes a force-directed
  layout via `networkx.spring_layout`. Emits JSON indices to `data/`.
- **Astro site** (`web/`): consumes the JSON at build time. Renders
  entity pages, browse pages, `/network/` (full canvas graph), `/path/`
  (BFS path finder), `/bridges/`, `/tags/`, `/timeline/`, `/changelog/`.
- **Pagefind**: search index built post-Astro, surfaces a Cmd-K modal.
- **nginx in Docker** (`deploy/`): serves the built `dist/` directory.

Everything is static. The only server-side runtime is nginx.

## Pages

| Route | What |
|---|---|
| `/` | Editorial homepage: featured entity, network hubs, type strip |
| `/<type>/` | Browse pages (people / organizations / programs / events / concepts / places) |
| `/<type>/<slug>/` | Entity page: prose, Connected to, Hidden Connections, Local network, Mentioned in |
| `/network/` | Full vault as one canvas graph |
| `/path/` | BFS between any two entities |
| `/bridges/` | Top-50 bridge entities by betweenness centrality |
| `/tags/`, `/tag/<slug>/` | Tag index + per-tag entry list |
| `/timeline/` | Entries grouped by decade (consumes future date-backfill) |
| `/changelog/` | Most-recently-edited entries from vault mtime |
| `/random/` | Redirects to a random entry |
| `/404`, `/5xx` | Styled error pages, wired in nginx |

## Local development

### Requirements
- **Python 3.11+** — parser
- **Node 22+** — Astro build
- **Docker + Docker Compose** — nginx runtime (optional, you can also run `astro dev`)
- A markdown vault in Obsidian format

### One-time setup
```bash
# From _web/:
pip install -r build/requirements.txt   # parser deps
npm --prefix web install                # Astro deps
```

### Build the site
```bash
./build.sh                              # Linux / macOS / Git Bash
./build.ps1                             # PowerShell on Windows
```
Both scripts parse the vault, copy generated JSON into Astro's
`public/`, then run `npm run build`. Result lands in `web/dist/`.

By default the vault is the parent directory of `_web/`. Override:
```bash
VAULT_PATH=/path/to/your/vault ./build.sh
```

### Run with nginx in Docker
```bash
docker compose up -d --build
# Open http://localhost:8080
```

### Astro dev server (hot reload of UI; vault data is still pre-built)
```bash
cd web
npm run dev
# Open http://localhost:4321
```

## Production deployment

The recommended setup uses two git repos on the server: the **vault**
(content source) and **this repo** (build pipeline). A cron job pulls
the vault every few minutes and rebuilds the site if anything changed.

### Server layout

```
/srv/info-web/
├── vault/                 # clone of your vault repo
├── redthread/             # clone of this repo
│   ├── build.sh
│   ├── docker-compose.yml
│   └── ...
└── (rebuild.sh lives in redthread/deploy/)
```

### Initial server setup

```bash
sudo mkdir -p /srv/info-web && cd /srv/info-web

# Clone the vault (your private repo)
git clone https://git.disinfo.zone/you/your-vault.git vault

# Clone this pipeline
git clone https://github.com/davidtorcivia/redthread.git

# Install dependencies (system-wide or in a venv)
pip install -r redthread/build/requirements.txt
# Node + Docker installed separately via your package manager

# First build — verifies everything wires up
cd redthread
SITE_URL=https://your.domain.com VAULT_PATH=/srv/info-web/vault ./build.sh

# Production compose: localhost-only binding + Cloudflare Tunnel sidecar
echo 'CLOUDFLARE_TUNNEL_TOKEN=eyJh...' > .env
chmod 600 .env
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# Verify locally (the web container; Cloudflare routes the public domain)
docker compose exec cloudflared cloudflared tunnel info
```

`SITE_URL` matters: it's baked into the canonical URLs, Open Graph
tags, sitemap.xml, and robots.txt.

### Exposing via Cloudflare Tunnel

`docker-compose.prod.yml` runs a `cloudflared` sidecar that holds an
outbound connection to Cloudflare's edge. **No host port is exposed.**

Setup:

1. **Zero Trust dashboard → Access → Tunnels → Create a tunnel.** Name
   it whatever you like. Copy the tunnel token Cloudflare gives you.
2. In the same tunnel config, add a **public hostname**:
   `your.domain.com → http://web:80` (yes, the literal Docker service
   name — cloudflared resolves it via the internal compose network).
3. On the server, drop the token in `_web/.env`:

   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJhbGciOiJIUzI1NiI...
   ```

   `.env` is gitignored; treat the token like a password.
4. Start with both compose files:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```

5. Verify in the Cloudflare dashboard that the tunnel shows as
   **Healthy**. Hit your domain — should land on the homepage.

The base `docker-compose.yml` is still the dev/local mode (binds
`0.0.0.0:8080`). The prod overlay drops the host port binding entirely
so the only path in is through Cloudflare. Restart-on-failure is set
on both containers.

### Auto-rebuild on vault push

The vault syncs via the **obsidian-git** community plugin (auto-commit
and push on a schedule from inside Obsidian). The server polls every
few minutes and rebuilds only when the vault has changed.

1. In Obsidian, install **obsidian-git** from Community Plugins
2. Configure it to auto-push every 5–10 min, on save, or whatever
   cadence you prefer
3. On the server, set up the rebuild cron (see `deploy/rebuild.sh`):

   ```bash
   crontab -e
   # Pull vault every 5 minutes, rebuild if anything changed
   */5 * * * * /srv/info-web/deploy/rebuild.sh >> /var/log/info-web.log 2>&1
   ```

`rebuild.sh` is a small wrapper provided in `deploy/`. It exits cheaply
when there's nothing to do; full rebuilds take ~35s.

### Webhook alternative (faster than polling)

If 5-minute lag bothers you, replace the cron with a Gitea webhook
pointing at a tiny rebuild endpoint. Gitea fires on push; the server
runs the same `rebuild.sh`. Worth ~50 lines of glue (Flask, Fastify,
or [adnanh/webhook](https://github.com/adnanh/webhook)) and an HTTPS
reverse-proxy route. Not necessary for v1.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `VAULT_PATH` | parent of `_web/` | Where to find the markdown vault |
| `SITE_URL` | `http://localhost:8080` | Canonical site URL (SEO, sitemap, OG tags) |
| `PORT` | `8080` | Host port for the nginx Docker container |

`build/parse_vault.py` accepts the same overrides via `--vault` and
`--out` flags. See `--help`.

### Files / paths excluded from the parse

Defined in `parse_vault.py` `DEFAULT_CONFIG.skipPathPatterns`. Out of
the box, these never become entities:

- `CLAUDE.md`, `DATAVIEW - *.md`, `DATAVIEW *.md`, `MOC - *.md`, `KEY *.md`
- `00 - META/CHANGELOG.md`, `00 - META/THE INFO WEB.md`
- `TEMP/**`, `.obsidian/**`, `.obsidian-*/**`, `.claude/**`, `.git/**`
- `IMAGES/**`, `_web/**`

Override with a `config.json` next to `parse_vault.py` (template in
`config.example.json`).

## Layout of this repo

```
redthread/
├── build/
│   ├── parse_vault.py         # The whole parser + NER + centrality + layout
│   └── requirements.txt
├── web/                       # Astro site
│   ├── astro.config.mjs
│   ├── package.json
│   └── src/
│       ├── layouts/Base.astro
│       ├── components/
│       │   ├── NetworkGraph.astro    # Canvas-based per-entity graph
│       │   ├── PathWidget.astro
│       │   ├── RelatedGrid.astro
│       │   ├── HiddenConnections.astro
│       │   ├── Backlinks.astro
│       │   └── TableOfContents.astro
│       ├── lib/
│       │   ├── data.ts                # Loads data/*.json at build time
│       │   └── types.ts
│       ├── pages/
│       │   ├── index.astro
│       │   ├── [type]/[slug].astro
│       │   ├── [type]/index.astro
│       │   ├── network.astro          # Full vault canvas
│       │   ├── path.astro
│       │   ├── bridges.astro
│       │   ├── tags.astro, tag/[slug].astro
│       │   ├── timeline.astro
│       │   ├── changelog.astro
│       │   ├── random.astro
│       │   ├── 404.astro, 5xx.astro
│       │   ├── sitemap.xml.ts, robots.txt.ts
│       └── styles/global.css
├── deploy/
│   ├── Dockerfile
│   ├── nginx.conf
│   └── rebuild.sh             # Pull vault → rebuild if changed (server use)
├── docker-compose.yml
├── build.sh, build.ps1        # Local build entry points
└── config.example.json
```

## License

MIT — see [LICENSE](LICENSE). The build pipeline is open; the vault
content it consumes lives in its own repo and is governed by whatever
license that repo uses (it's not part of this distribution).
