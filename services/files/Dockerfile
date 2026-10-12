# Quox File Storage Service
# Handles file uploads, downloads, and metadata for the dashboard

# TRUST-PROOF audit cycle 1: digest-pinned base (provenance over mutable
# tags). Roll deliberately: update tag AND digest together; no auto-roller
# yet, so a bump is a reviewed commit, which is the point.
FROM node:20-alpine@sha256:afdf98210b07b586eb71fa22ba2e432e058e4cd1304d31ed60888755b8c865fb

# Create app directory
WORKDIR /app

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Create storage directories
RUN mkdir -p /var/lib/quox/files /var/lib/quox/metadata

# Non-root user for security
RUN addgroup -g 1001 -S quox && \
    adduser -u 1001 -S quox -G quox && \
    chown -R quox:quox /app /var/lib/quox

# Version tracking
# NOTE: this service's build context is ./services/files (see docker-compose.yml),
# so the repo-root VERSION file is NOT in context and cannot be COPY'd here. The
# runtime resolver in server.js reads /app/VERSION when present and otherwise
# falls back to this build arg / '0.0.0'. To make the VERSION-file fallback active
# for this service, widen its compose build context to the repo root.
ARG QUOXCORE_VERSION=0.0.0
ENV QUOXCORE_VERSION=${QUOXCORE_VERSION}

USER quox

EXPOSE 3102

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3102/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
