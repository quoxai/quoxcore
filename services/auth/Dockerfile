# QuoxCORE Auth Service Dockerfile
# Multi-stage build for optimal image size

# ============================================
# Stage 1: Builder
# Install dependencies and compile native modules
# ============================================
# TRUST-PROOF audit cycle 1: digest-pinned base (provenance over mutable
# tags). Roll deliberately: update tag AND digest together; no auto-roller
# yet, so a bump is a reviewed commit, which is the point.
FROM node:20-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c AS builder
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000

# Install build tools for native modules (argon2, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/services/auth

# Copy package files first for better layer caching
COPY services/auth/package*.json ./

# Install all dependencies (including dev for building)
RUN npm ci --include=dev

# Copy auth source and the shared repo modules it now imports
COPY services/auth ./
COPY services/ward /app/services/ward
# CLI-PARITY WP1.1: server.js dynamically imports '../shared/routeIntrospection.cjs'
# for GET /__routes, which resolves (from WORKDIR /app/services/auth) to
# /app/services/shared — distinct from the repo-root `shared/` copied below.
COPY services/shared /app/services/shared
COPY shared /app/shared
COPY src/config /app/src/config

# ============================================
# Stage 2: Production
# Minimal runtime image
# ============================================
FROM node:20-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c AS production
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000

# Install runtime dependencies
# python3 needed for Claude OAuth token exchange (bypasses Cloudflare TLS fingerprinting)
# git, rsync, openssh-client needed for backup-quox.sh (backup/restore operations)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    python3 \
    ca-certificates \
    sqlite3 \
    git \
    rsync \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI for backup operations (docker exec, docker cp, docker inspect)
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

# Create non-root user for security
RUN groupadd -g 1001 quox && \
    useradd -u 1001 -g quox -d /app -s /sbin/nologin quox

WORKDIR /app

# Preserve repo-relative layout so shared/src imports resolve
WORKDIR /app/services/auth

# Copy package files
COPY services/auth/package*.json ./

# Copy pre-built node_modules from builder (includes compiled native modules)
COPY --from=builder /app/services/auth/node_modules ./node_modules

# Copy application source plus shared repo modules used by auth routes
COPY services/auth ./
COPY services/ward /app/services/ward
# CLI-PARITY WP1.1: server.js dynamically imports '../shared/routeIntrospection.cjs'
# for GET /__routes, which resolves (from WORKDIR /app/services/auth) to
# /app/services/shared — distinct from the repo-root `shared/` copied below.
COPY services/shared /app/services/shared
COPY shared /app/shared
COPY src/config /app/src/config

# Version tracking (passed via build arg from docker-compose)
ARG QUOXCORE_VERSION=0.0.0
ENV QUOXCORE_VERSION=${QUOXCORE_VERSION}
# Canonical VERSION file fallback: if QUOXCORE_VERSION build arg is not passed,
# the service reads /app/VERSION so it never silently reports 0.0.0.
# (build context is repo root — compose `context: .`)
COPY VERSION /app/VERSION

# Create data directories
RUN mkdir -p /var/lib/quox && \
    chown -R quox:quox /var/lib/quox /app

# Switch to non-root user
USER quox

# Environment defaults
ENV NODE_ENV=production \
    AUTH_PORT=3101 \
    AUTH_HOST=0.0.0.0 \
    AUTH_DB_PATH=/var/lib/quox/auth.db

# Expose port
EXPOSE 3101

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3101/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the server
CMD ["node", "server.js"]
