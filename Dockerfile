# Builder image: watches a mounted vault and rebuilds the site into /site.
# docker-compose.yml pairs it with nginx.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv rsync git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system safe.directory '*'

COPY build/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
RUN mkdir /site && chown node:node /app /site
USER node

COPY --chown=node:node web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund
COPY --chown=node:node . .
RUN mkdir -p web/.og-cache data

ENV PYTHON=/opt/venv/bin/python VAULT_PATH=/vault DIST_DIR=/site
CMD ["deploy/rebuild.sh", "--watch"]
