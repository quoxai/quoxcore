# Stage 1: Builder — Install dependencies and compile native modules
# TRUST-PROOF audit cycle 1: digest-pinned base (provenance over mutable
# tags). Roll deliberately: update tag AND digest together; no auto-roller
# yet, so a bump is a reviewed commit, which is the point.
FROM node:20-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c AS builder
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000
# REL-424: package sources over https before the first update (some networks drop TCP 80 to the distro CDNs).
# This base ships no CA bundle, so apt's https needs one first: taken from a digest-pinned alpine image.
COPY --from=alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN find /etc/apt -maxdepth 2 \( -name sources.list -o -name '*.sources' -o -name '*.list' \) -exec sed -i 's#http://#https://#g' {} + \
    && ! grep -rqs 'http://' /etc/apt/sources.list /etc/apt/sources.list.d
RUN apt-get update && apt-get install -y \
    python3 make g++ gcc \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY . .

# Stage 2: Production — Minimal runtime image
FROM node:20-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c AS production
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000
# REL-424: package sources over https before the first update (some networks drop TCP 80 to the distro CDNs).
# This base ships no CA bundle, so apt's https needs one first: taken from a digest-pinned alpine image.
COPY --from=alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN find /etc/apt -maxdepth 2 \( -name sources.list -o -name '*.sources' -o -name '*.list' \) -exec sed -i 's#http://#https://#g' {} + \
    && ! grep -rqs 'http://' /etc/apt/sources.list /etc/apt/sources.list.d
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 quox && \
    useradd -u 1001 -g quox -d /app -s /sbin/nologin quox

WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /var/lib/quox && \
    chown -R quox:quox /var/lib/quox /app

USER quox

# Version tracking
# NOTE: this service's build context is ./services/tasks (see docker-compose.yml),
# so the repo-root VERSION file is NOT in context and cannot be COPY'd here. The
# runtime resolver in server.js reads /app/VERSION when present and otherwise
# falls back to this build arg / '0.0.0'. To make the VERSION-file fallback active
# for this service, widen its compose build context to the repo root.
ARG QUOXCORE_VERSION=0.0.0
ENV QUOXCORE_VERSION=${QUOXCORE_VERSION}

ENV NODE_ENV=production PORT=3104 DB_PATH=/var/lib/quox/tasks.db
EXPOSE 3104

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3104/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
