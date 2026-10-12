# QuoxCORE Researcher Container
# Isolated environment for web research and data gathering

FROM python:3.11-slim

# Install browser dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-driver \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages for research
RUN pip install --no-cache-dir \
    requests \
    beautifulsoup4 \
    lxml \
    selenium \
    playwright \
    httpx \
    aiohttp \
    feedparser \
    newspaper3k \
    trafilatura \
    pyyaml \
    rich

# Install playwright browsers
RUN playwright install chromium

# Create research directory
WORKDIR /research

# Copy entrypoint script
COPY entrypoint.py /research/

# Create non-root user
RUN useradd -m -s /bin/bash researcher
RUN chown -R researcher:researcher /research

# Switch to non-root user
USER researcher

# Default command
CMD ["python", "/research/entrypoint.py"]
