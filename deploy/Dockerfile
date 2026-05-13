# Build context is the vault clone root (parent of _web/).
# Builds in two stages, serves from nginx.
#
#   docker build -t info-web -f _web/deploy/Dockerfile .
#   docker run -p 8080:80 info-web

# ---------- Stage 1: Python parser ----------
FROM python:3.13-slim AS parser

WORKDIR /work
COPY _web/build/requirements.txt /work/_web/build/requirements.txt
RUN pip install --no-cache-dir -r /work/_web/build/requirements.txt

COPY _web/build /work/_web/build
# The entire vault clone gets copied in. .dockerignore should trim
# anything that doesn't belong (IMAGES/, TEMP/, .git, node_modules, etc.)
COPY . /work
RUN python /work/_web/build/parse_vault.py \
    --vault /work \
    --out /work/_web/data

# ---------- Stage 2: Astro + Pagefind build ----------
FROM node:22-alpine AS web

WORKDIR /app/_web/web
COPY _web/web/package.json _web/web/package-lock.json* ./
RUN npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

COPY _web/web ./
COPY --from=parser /work/_web/data /app/_web/data

# Surface previews.json as a static asset (hover-preview data)
RUN mkdir -p /app/_web/web/public && \
    cp /app/_web/data/previews.json /app/_web/web/public/previews.json

RUN npm run build

# ---------- Stage 3: nginx serve ----------
FROM nginx:1-alpine AS runtime

COPY --from=web /app/_web/web/dist /usr/share/nginx/html
COPY _web/deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1
