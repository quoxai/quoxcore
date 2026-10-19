# QuoxCORE Memory Service
# TRUST-PROOF audit cycle 1: digest-pinned base (provenance over mutable
# tags). Roll deliberately: update tag AND digest together; no auto-roller
# yet, so a bump is a reviewed commit, which is the point.
FROM node:20-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000

# Install build dependencies for better-sqlite3
# REL-424: package sources over https before the first update (some networks drop TCP 80 to the distro CDNs).
# This base ships no CA bundle, so apt's https needs one first: taken from a digest-pinned alpine image.
COPY --from=alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN find /etc/apt -maxdepth 2 \( -name sources.list -o -name '*.sources' -o -name '*.list' \) -exec sed -i 's#http://#https://#g' {} + \
    && ! grep -rqs 'http://' /etc/apt/sources.list /etc/apt/sources.list.d
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    curl \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source
COPY . .

# Create data directory
RUN mkdir -p /var/lib/quox

# Non-root user for security
RUN useradd -r -s /bin/false quox && \
    chown -R quox:quox /app /var/lib/quox

USER quox

EXPOSE 3103

# Version tracking
# NOTE: this service's build context is ./services/memory (see docker-compose.yml),
# so the repo-root VERSION file is NOT in context and cannot be COPY'd here. The
# runtime resolver in server.js reads /app/VERSION when present and otherwise
# falls back to this build arg / '0.0.0'. To make the VERSION-file fallback active
# for this service, widen its compose build context to the repo root.
ARG QUOXCORE_VERSION=0.0.0
ENV QUOXCORE_VERSION=${QUOXCORE_VERSION}

ENV NODE_ENV=production
ENV PORT=3103
ENV DB_PATH=/var/lib/quox/memory.db

CMD ["node", "server.js"]
