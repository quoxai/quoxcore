# Quox Collector Service
# Central hub for chat streaming, fleet management, AI backend routing, and Claude CLI proxy

# ── Stage 1: tester ────────────────────────────────────────────────────────────
# Installs all deps (including devDeps for vitest), runs the AGH-RESP-4
# response-contract gate, writes /tmp/.tester-ok only on gate pass.
# The runtime stage COPY-from-tester forces a build failure if tester did not
# produce the marker — this is the dependency edge that gates the image.

# TRUST-PROOF audit cycle 1: digest-pinned base (provenance over mutable
# tags). Roll deliberately: update tag AND digest together; no auto-roller
# yet, so a bump is a reviewed commit, which is the point.
FROM node:20-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c AS tester
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000

WORKDIR /app

COPY services/collector/package*.json ./
RUN npm ci

COPY services/collector ./
COPY shared /app/shared
COPY services/shared /app/services-shared
COPY src/config /app/src/config
COPY src/services/llmCapabilityPolicy.js /app/src/services/llmCapabilityPolicy.js
COPY src/services/llmService.js /app/src/services/llmService.js
# TOOLSMITH-E-fix-3: sandbox seccomp profiles must be readable by scriptExecutor
# at runtime. Without this, /api/internal/toolsmith/sandbox/run fails in the live
# container even though D-1's host-side tests pass. Per feedback_container_path_resolution_2026_05_14.md.
COPY services/sandbox/seccomp /app/sandbox/seccomp

ARG RESPONSE_CONTRACT_BUILD_GATE=soft
RUN sh scripts/response-contract-gate.sh "$RESPONSE_CONTRACT_BUILD_GATE"

# ── Stage 2: runtime ───────────────────────────────────────────────────────────
# Identical to the original single-stage build. devDeps NOT installed.
# COPY --from=tester forces BuildKit to complete the tester stage first.

FROM node:20-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c AS runtime
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000

# Install build tools for native modules (better-sqlite3 requires glibc + build chain)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    tmux \
    openssh-client \
    gosu \
    sqlite3 \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Gate marker — forces this stage to wait for tester to complete successfully.
# If tester did not write /tmp/.tester-ok the build fails here before runtime
# image is produced.
COPY --from=tester /tmp/.tester-ok /tmp/.tester-ok

# Install dependencies first (cache layer)
COPY services/collector/package*.json ./
RUN npm ci --only=production

# Install Claude CLI globally for /chat/claude endpoint
# This allows the collector to proxy Claude CLI calls without n8n sandbox restrictions
# QUOXTRUST v1.4 T-ART: pin the version (siblings gemini/codex are pinned) so a
# release image build cannot silently pull an unverified newer dependency.
# Z2H-IMAGES: the Claude CLI subscription path is dev-only and the binary is proprietary, so PUBLIC
# images are built with INCLUDE_CLAUDE_CLI=false and never contain it. Default true: dev box unchanged.
# Without it the collector reports claude_cli_missing and the subscription provider as unavailable.
ARG INCLUDE_CLAUDE_CLI=true
RUN if [ "$INCLUDE_CLAUDE_CLI" = "true" ]; then npm install -g @anthropic-ai/claude-code@2.1.197; else echo "INCLUDE_CLAUDE_CLI=false: claude CLI not installed"; fi

# Install Gemini CLI globally for the GEMINI agent's gemini_review/analyze/generate tools
# (services/collector/lib/toolExecutors/geminiCli.js shells out to `gemini`).
# Requires GEMINI_API_KEY in the container env at runtime to authenticate.
RUN npm install -g @google/gemini-cli@0.35.3

# DEVSUITE-DEVMODE 5c: Codex CLI for the Settings web-terminal device-auth
# flow (/terminal/ws?app=codex spawns `codex login --device-auth`) and as the
# second quoxified-loop backend. Auth lands in $HOME/.codex/auth.json.
RUN npm install -g @openai/codex@0.118.0

# CLI-OVER-MCP (owner hard rule 2026-09-21): bake the quox CLI into the image so
# the on-server agent reaches governed tools via `quox tool exec` (the CLI-over-MCP
# tool path) instead of spawning quoxmcp. Baked at an unmounted path (/app/cli is a
# read-only compose mount with no node_modules) and symlinked onto PATH. `npm ci`
# wipes+reinstalls, so a copied host node_modules cannot poison the image.
COPY cli /opt/quox-cli
RUN cd /opt/quox-cli && npm ci --omit=dev \
    && ln -sf /opt/quox-cli/bin/quox.js /usr/local/bin/quox \
    && chmod +x /opt/quox-cli/bin/quox.js

# Copy source (ARG invalidates this layer when code changes)
ARG CACHE_BUST=1
COPY services/collector ./
COPY shared /app/shared
COPY services/shared /app/services-shared
COPY src/config /app/src/config
COPY src/services/llmCapabilityPolicy.js /app/src/services/llmCapabilityPolicy.js
COPY src/services/llmService.js /app/src/services/llmService.js
# WARD-HARDEN: server.js loads ./ward/hooks-cjs.cjs + ./ward/api-cjs.cjs at
# runtime (loadOptionalModule). Previously ward code only existed via the
# docker-compose ./services/ward:/app/ward:ro volume mount, so image-only
# deploys (no compose volume) silently ran with WARD witnessing/routes
# no-op'd. Bake it into the image so it works with or without the mount.
COPY services/ward /app/ward
# VOLT-RETENTION P3: scripts/volt-archive.js re-verifies every exported bundle
# with the SAME verifier the CLI uses (src/lib/volt/volt-verify.js, ESM). The
# collector package is CommonJS, so mark this subtree as ESM explicitly.
COPY src/lib/volt /app/src/lib/volt
COPY src/lib/aee/ulid.js /app/src/lib/aee/ulid.js
RUN printf '{"type":"module"}\n' > /app/src/lib/package.json
# TOOLSMITH-E-fix-3: sandbox seccomp profiles must be readable by scriptExecutor
# at runtime. Without this, /api/internal/toolsmith/sandbox/run fails in the live
# container even though D-1's host-side tests pass. Per feedback_container_path_resolution_2026_05_14.md.
COPY services/sandbox/seccomp /app/sandbox/seccomp

# Copy and set up entrypoint (must be before USER so root owns it)
COPY services/collector/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Non-root user for security with proper home directory
# -G node adds quox to gid 1000 (matches host 'control' group for /opt/quoxcore:ro mount)
RUN groupadd -g 1001 quox && \
    useradd -u 1001 -g quox -G node -d /home/quox -s /sbin/nologin quox && \
    mkdir -p /var/lib/quox /home/quox/.claude /home/quox/.codex /home/quox/.ssh && \
    chmod 700 /home/quox/.ssh && \
    echo '{"hasCompletedOnboarding":true}' > /home/quox/.claude.json && \
    printf '%s\n' \
      '# Colored prompt: blue user, lilac host, white path (Quox brand)' \
      'export PS1='"'"'\[\e[38;5;75m\]\u\[\e[0m\]@\[\e[38;5;141m\]\h\[\e[0m\]:\[\e[1;37m\]\w\[\e[0m\]\$ '"'"'' \
      'export TERM=xterm-256color' \
      'alias ls="ls --color=auto"' \
      'alias grep="grep --color=auto"' \
      > /home/quox/.bashrc && \
    printf '%s\n' \
      '# Source bashrc for login shells' \
      'if [ -f ~/.bashrc ]; then . ~/.bashrc; fi' \
      > /home/quox/.profile && \
    chown quox:quox /app && \
    find /app -mindepth 1 -maxdepth 1 ! -name node_modules -exec chown -R quox:quox {} + && \
    chown -R quox:quox /var/lib/quox /home/quox

# BUILD-TIME FIX 2026-08-18: the line above used to be a flat
# `chown -R quox:quox /app ...`, which walked node_modules (319MB) on every
# build. Measured: a collector build that normally takes ~160s spent 15
# minutes, and the build log showed it sitting on THAT ONE STEP for about 11
# of them. On 2026-08-18 it was bad enough that the compose recreate wedged
# for 35 minutes and took the collector down.
#
# node_modules is EXCLUDED rather than the chown being narrowed, because the
# collector genuinely does write under /app at runtime (monitoring-config.json
# and eval/lenses/findings are both __dirname-relative), so those must stay
# quox-owned. Dependencies only ever need to be READABLE, and they are: npm
# installs them world-readable. Everything else under /app is chowned exactly
# as before.

# Version tracking
ARG QUOXCORE_VERSION=0.0.0
ENV QUOXCORE_VERSION=${QUOXCORE_VERSION}
# Canonical VERSION file fallback: if QUOXCORE_VERSION build arg is not passed,
# the service reads /app/VERSION so it never silently reports 0.0.0.
# (build context is repo root — compose `context: .`)
# REL-423: BUILD_COMMIT (full SHA) is written by the public export, which has no .git; /version reports it.
# The [T] glob makes it optional, so the private tree (no BUILD_COMMIT) still builds.
COPY VERSION BUILD_COMMI[T] /app/

# Set HOME for Claude CLI config storage
ENV HOME=/home/quox

EXPOSE 9848

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:9848/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
