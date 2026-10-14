# QuoxCORE Dashboard Dockerfile
# Multi-stage build: builder -> production

# ============================================
# Stage 1: Builder
# Install dependencies and build the React app
# ============================================
FROM node:20-alpine@sha256:afdf98210b07b586eb71fa22ba2e432e058e4cd1304d31ed60888755b8c865fb AS builder
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000

# Install build tools (may be needed for optional native modules)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build arguments for build-time configuration
ARG VITE_API_URL
ARG VITE_DEMO_MODE=false
ARG VITE_QDRANT_URL=http://localhost:6333
ARG VITE_DEMO_BANNER=false
ARG VITE_DEMO_EMAIL=
ARG VITE_DEMO_PASSWORD=
ENV VITE_DEMO_BANNER=$VITE_DEMO_BANNER
ENV VITE_DEMO_EMAIL=$VITE_DEMO_EMAIL
ENV VITE_DEMO_PASSWORD=$VITE_DEMO_PASSWORD

# Build the application
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

# ============================================
# Stage 2: Production
# Serve with nginx + HTTPS
# ============================================
FROM nginx:alpine@sha256:62ff2089abf5a9ed33bd232895bef5e22f7bb4b200675cec49a5ebc48e3d4ac8 AS production
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000

# Install curl for healthcheck and openssl for self-signed cert fallback
RUN apk add --no-cache curl openssl

# Create directories
RUN mkdir -p /etc/nginx/ssl /var/www/acme-challenge /var/log/nginx

# Copy nginx configuration (processed by envsubst at runtime)
COPY nginx.conf /etc/nginx/nginx.conf.template

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose HTTPS and HTTP ports
EXPOSE 443 80

# Health check via HTTP port 80 (avoids self-signed cert issues)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://127.0.0.1:80/health || exit 1

# Process nginx template (replace env vars) and start nginx
# Only substitutes QDRANT_API_KEY and DASHBOARD_PORT — leaves nginx $variables intact
# Auto-generates a self-signed cert if none is mounted via docker compose volume
# quox#553: the fallback used to silence openssl and print success
# unconditionally, so generation into a read-only mount produced a false
# 'Self-signed cert generated.' straight into an nginx crash loop. It now
# fails LOUDLY (real stderr, non-empty file check, exit 1 with the probable
# cause) so the container log names the fault instead of lying.
CMD ["/bin/sh", "-c", "\
  if [ ! -f /etc/nginx/ssl/quox.crt ] || [ ! -f /etc/nginx/ssl/quox.key ]; then \
    echo 'No SSL cert found — generating self-signed certificate...'; \
    if ! openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
      -keyout /etc/nginx/ssl/quox.key \
      -out /etc/nginx/ssl/quox.crt \
      -subj '/CN=quox.local/O=QuoxCORE/C=US' \
      -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'; then \
      echo 'ERROR: self-signed cert generation FAILED (is /etc/nginx/ssl a read-only mount without certs?)' >&2; exit 1; \
    fi; \
    if [ ! -s /etc/nginx/ssl/quox.crt ] || [ ! -s /etc/nginx/ssl/quox.key ]; then \
      echo 'ERROR: cert files missing/empty after generation.' >&2; exit 1; \
    fi; \
    echo 'Self-signed cert generated.'; \
  fi; \
  envsubst '${QDRANT_API_KEY} ${DASHBOARD_PORT} ${INTERNAL_SERVICE_KEY} ${BASTION_URL} ${GRAFANA_URL}' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf && \
  exec nginx -g 'daemon off;'"]
