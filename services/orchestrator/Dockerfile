# TRUST-PROOF audit cycle 1: digest-pinned base (provenance over mutable
# tags). Roll deliberately: update tag AND digest together; no auto-roller
# yet, so a bump is a reviewed commit, which is the point.
FROM node:20-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source
COPY *.js ./

# Version tracking
# NOTE: this service's build context is ./services/orchestrator (see docker-compose.yml),
# so the repo-root VERSION file is NOT in context and cannot be COPY'd here. The
# runtime resolver in server.js reads /app/VERSION when present and otherwise
# falls back to this build arg / '0.0.0'. To make the VERSION-file fallback active
# for this service, widen its compose build context to the repo root.
ARG QUOXCORE_VERSION=0.0.0
ENV QUOXCORE_VERSION=${QUOXCORE_VERSION}

# Create non-root user with access to Docker socket
ARG DOCKER_GID=988
RUN addgroup --gid ${DOCKER_GID} docker && \
    adduser --disabled-password --gecos '' orchestrator && \
    adduser orchestrator docker
USER orchestrator

EXPOSE 3100

CMD ["node", "server.js"]
