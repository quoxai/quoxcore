# QuoxCORE AI Agent Container
# Isolated environment for running LLM-powered agents

FROM python:3.11-slim

# Install dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install AI SDK packages
RUN pip install --no-cache-dir \
    anthropic \
    google-generativeai \
    openai \
    langchain \
    langchain-community \
    tiktoken \
    pyyaml \
    requests \
    aiohttp \
    rich

# Create agent directory
WORKDIR /agent

# Copy entrypoint script
COPY entrypoint.py /agent/

# Create non-root user
RUN useradd -m -s /bin/bash agent
RUN chown -R agent:agent /agent

# Switch to non-root user
USER agent

# Default command
CMD ["python", "/agent/entrypoint.py"]
