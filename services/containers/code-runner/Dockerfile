# QuoxCORE Code Runner Container
# Isolated environment for executing untrusted code

FROM python:3.11-slim
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000

# Install common tools
# REL-424: package sources over https before the first update (some networks drop TCP 80 to the distro CDNs).
RUN find /etc/apt -maxdepth 2 \( -name sources.list -o -name '*.sources' -o -name '*.list' \) -exec sed -i 's#http://#https://#g' {} + \
    && ! grep -rqs 'http://' /etc/apt/sources.list /etc/apt/sources.list.d
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    npm \
    git \
    curl \
    jq \
    shellcheck \
    && rm -rf /var/lib/apt/lists/*

# Install common Python packages
RUN pip install --no-cache-dir \
    requests \
    pyyaml \
    python-dotenv \
    rich \
    pytest

# Install common Node.js tools
RUN npm install -g \
    eslint \
    prettier \
    typescript

# Create workspace directory
WORKDIR /workspace

# Create non-root user
RUN useradd -m -s /bin/bash runner
RUN chown -R runner:runner /workspace

# Switch to non-root user
USER runner

# Default command - can be overridden
CMD ["bash"]
