# QuoxFlow Dockerfile
# Multi-stage: build TypeScript → run with node:18-slim
# Uses node:18-slim (Debian) instead of Alpine — isolated-vm native bindings require glibc

# ============================================
# Stage 1: Builder
# Install deps, compile TypeScript
# ============================================
# TRUST-PROOF audit cycle 1: digest-pinned base (provenance over mutable
# tags). Roll deliberately: update tag AND digest together.
FROM node:18-slim@sha256:f9ab18e354e6855ae56ef2b290dd225c1e51a564f87584b9bd21dd651838830e AS builder

# Build tools for native modules (isolated-vm)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files for layer caching
COPY package*.json ./

# Install all dependencies (including dev for tsc)
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ============================================
# Stage 2: Production
# Minimal runtime with compiled dist/
# ============================================
FROM node:18-slim@sha256:f9ab18e354e6855ae56ef2b290dd225c1e51a564f87584b9bd21dd651838830e AS production

# Runtime deps: ca-certificates + build tools for isolated-vm native rebuild
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd -g 1001 quox && \
    useradd -u 1001 -g quox -d /app -s /sbin/nologin quox

WORKDIR /app

# Install production deps only (strips dev tooling like tsc, vitest, tsx)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output
COPY --from=builder /app/dist ./dist

# QSKL-FIX slice 1B: migrations are runtime assets (not compiled).
# run-migrations.ts resolves /app/migrations at container boot.
COPY migrations/ ./migrations/

# Evidence storage directory
RUN mkdir -p /var/lib/quoxflow/evidence && \
    chown -R quox:quox /var/lib/quoxflow /app

USER quox

ENV NODE_ENV=production \
    PORT=3200 \
    EVIDENCE_PATH=/var/lib/quoxflow/evidence

EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3200/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
