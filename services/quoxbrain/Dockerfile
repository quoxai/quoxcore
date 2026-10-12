# QuoxCORE Brain Service
# TRUST-PROOF audit cycle 1: digest-pinned base (provenance over mutable
# tags). Roll deliberately: update tag AND digest together; no auto-roller
# yet, so a bump is a reviewed commit, which is the point.
FROM node:20-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c

# Install build dependencies for better-sqlite3
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

EXPOSE 3106

# Version tracking
# NOTE: this service's build context is ./services/quoxbrain (see
# docker-compose.yml), so the repo-root VERSION file is NOT in context and
# cannot be COPY'd here. The runtime resolver in server.js reads /app/VERSION
# when present and otherwise falls back to this build arg / '0.0.0'. To make
# the VERSION-file fallback active for this service, widen its compose build
# context to the repo root.
ARG QUOXCORE_VERSION=0.0.0
ENV QUOXCORE_VERSION=${QUOXCORE_VERSION}

ENV NODE_ENV=production
ENV PORT=3106
ENV DB_PATH=/var/lib/quox/quoxbrain.db

CMD ["node", "server.js"]
