# QuoxCORE Setup Guide

This guide walks you through installing and configuring QuoxCORE. Choose the installation method that works best for your environment.

---

## Quick Start (10 minutes)

### Docker Compose Installation

The safest first-time path is the setup script, because it validates secrets and locates or clones required sibling repos like `quoxflow` and `quoxmcp`:

```bash
# Clone the repository
git clone https://github.com/quoxai/quox.git
cd quox

# Guided first-time setup
./scripts/setup.sh

# Verify the full platform, not just containers
./scripts/post-install-smoke.sh https://127.0.0.1:3000
```

If you prefer the manual compose path, make sure `quoxflow` and `quoxmcp` exist alongside this repo first. The compose stack expects QuoxFlow to be available and workflows will not work without it.

```bash
# Clone required sibling repos first
git clone https://github.com/quoxai/quoxflow.git ../quoxflow
git clone https://github.com/quoxai/quoxmcp.git ../quoxmcp
```

Then:

```bash
# Clone the repository
git clone https://github.com/quoxai/quox.git
cd quox

# Run preflight checks (verifies Docker, ports, disk, RAM)
./scripts/preflight.sh

# Generate secure secrets
./scripts/generate-secrets.sh

# Start all services
docker compose up -d

# Verify services are healthy
docker compose ps
```

This will:

1. ✅ Check system requirements (Docker, disk space, RAM)
2. ✅ Generate secure secrets (JWT, encryption keys)
3. ✅ Start all services with Docker Compose
4. ✅ Start QuoxFlow, tasks, PostgreSQL, and the rest of the platform services
5. ✅ Verify health and print status

**After installation, open** `https://localhost:3000`, **complete the Setup Wizard, then run** `./scripts/post-install-smoke.sh https://localhost:3000`.

### Authenticate Claude CLI (Optional)

QuoxCORE can use Claude CLI with your Anthropic subscription if you want terminal-based OAuth instead of an Anthropic API key:

```bash
# One-time authentication
docker exec -it quox-collector claude login
```

This opens a browser for authentication. Once logged in, Claude CLI uses your subscription quota.
This path is optional and deployment-dependent. Direct OpenAI or Anthropic API keys also support chat.

---

## System Requirements

### Minimum Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| **CPU** | 2 cores | 4+ cores |
| **RAM** | 4 GB | 8+ GB |
| **Disk** | 10 GB | 20+ GB |
| **OS** | Linux (Ubuntu 20.04+, Debian 11+, RHEL 8+) | Ubuntu 22.04 LTS |

### Supported Operating Systems

- Ubuntu 20.04, 22.04, 24.04
- Debian 11, 12
- RHEL 8, 9 / CentOS Stream 8, 9
- Fedora 38+
- Alpine Linux 3.18+
- Arch Linux

### Required Software

| Software | Version | Notes |
|----------|---------|-------|
| Docker | 20.10+ | Installed automatically by installer |
| Docker Compose | v2.0+ | Included with Docker |

### Required Repositories

| Repository | Path | Purpose |
|------------|------|---------|
| quox (this repo) | `/opt/quoxcore` | Main platform |
| [quoxflow](https://github.com/quoxai/quoxflow) | `/opt/quoxcore/quoxflow` or `../quoxflow` | Workflow engine for builder, policies, approvals, and automation |
| [quoxmcp](https://github.com/quoxai/quoxmcp) | `/opt/quoxcore/quoxmcp` | MCP protocol adapter — mounted into collector for AI tool execution |

The collector service volume-mounts `quoxmcp` at `/app/quoxmcp`. If missing, MCP tools will not be available to agents. Set `QUOXMCP_PATH` in `.env` to override the default path.
The compose stack also builds QuoxFlow from `QUOXFLOW_PATH` (default `../quoxflow`). If missing, workflow features will be degraded or unavailable.

---

## Installation Methods

### Method 1: Docker Compose (Recommended)

Before starting services, make sure the `quoxflow` sibling repo exists if you are not using `./scripts/setup.sh`.

```bash
# Clone the repository
git clone https://github.com/quoxai/quox.git
cd quox

# Run preflight checks
./scripts/preflight.sh

# Generate secrets (creates .env from .env.example)
./scripts/generate-secrets.sh

# (Optional) Edit .env to add API keys
# nano .env

# Start services
docker compose up -d
```

#### Manual Secret Generation

If you prefer to generate secrets manually:

```bash
# Copy example environment file
cp .env.example .env

# Generate and set secrets
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 64)
N8N_ENCRYPTION_KEY=$(openssl rand -hex 16)

# Update .env with your generated values
# Then start services
docker compose up -d
```

#### Verify Installation

```bash
# Check service status
docker compose ps

# Expected output:
# NAME             STATUS          PORTS
# quox-auth        Up (healthy)    0.0.0.0:3101->3101/tcp
# quox-dashboard   Up (healthy)    0.0.0.0:3000->3000/tcp
# quox-n8n         Up (healthy)    0.0.0.0:5678->5678/tcp
# quox-qdrant      Up (healthy)    0.0.0.0:6333->6333/tcp

# Check logs if needed
docker compose logs -f

# Verify the real proxy paths the product depends on
./scripts/post-install-smoke.sh https://localhost:3000

# OPTIONAL: Authenticate Claude CLI for terminal-based OAuth
docker exec -it quox-collector claude login
```

> **Optional:** After services are healthy, you can run `docker exec -it quox-collector claude login` to enable Claude terminal OAuth. This is not required if you plan to use direct OpenAI or Anthropic API keys.

### Method 2: Development Mode

For development with hot reloading:

> **Important:** Even in development mode, Docker is required for QuoxFlow, tasks, PostgreSQL, and Qdrant. You also need the collector running locally for chat, terminal OAuth, and provider readiness checks.

```bash
# Clone the repository
git clone https://github.com/quoxai/quox.git
cd quox

# Install dashboard dependencies
npm install

# Install auth service dependencies
cd services/auth
npm install
cd ../..

# Start support services with Docker (REQUIRED for full functionality)
docker compose up -d postgres quoxflow tasks qdrant

# (Optional) Generate SSL certificates for HTTPS
# If you skip this step, the dev server will run on HTTP
npm run generate-certs

# Create environment file for auth service
cp services/auth/.env.example services/auth/.env
# Edit services/auth/.env if needed (defaults work for development)

# Initialize the database
cd services/auth
mkdir -p data
npm run init-db
cd ../..

# Terminal 1: Start auth service
cd services/auth && npm run dev

# Terminal 2: Start collector
cd services/collector
npm install
npm run dev
cd ../..

# Terminal 3: Start dashboard (in project root)
npm run dev
```

Access the development server at:
- `http://localhost:3000` (if no certs)
- `https://localhost:3000` (if certs generated)

**Note:** The setup wizard will block until auth and required backing services are reachable. Direct chat and terminal auth features also require the collector to be running.

### Method 3: Demo Mode

Run QuoxCORE without any API keys for evaluation:

```bash
# With Docker
VITE_DEMO_MODE=true docker compose up -d

# Or in development
VITE_DEMO_MODE=true npm run dev
```

In demo mode:
- AI responses are simulated
- All UI features are functional
- No external API calls are made
- Perfect for evaluation and testing

---

## First-Run Setup Wizard

On first launch, QuoxCORE displays a Setup Wizard to configure essential settings.

### Step 1: Welcome

The wizard performs system health checks for:
- Auth Server connection
- Database availability
- Qdrant vector database (required)

Collector readiness is surfaced later in settings and chat readiness checks. If Docker services aren't running, the wizard shows platform-specific installation help.

### Step 2: Create Admin Account

Create your administrator account:
- **Email**: Your admin email address
- **Password**: Minimum 10 characters
- **Name**: Optional display name

This creates:
- Your admin user with full instance permissions
- A default organization
- Membership as organization owner

### Step 3: Configure API Keys

Add your external service API keys:

| Key | Purpose | Required |
|-----|---------|----------|
| **Anthropic API Key** | Direct Anthropic/Claude API chat | Optional |
| **OpenAI API Key** | GPT chat, semantic search, embeddings | Optional |
| **ElevenLabs API Key** | Text-to-speech voice synthesis | Optional |
| **Perplexity API Key** | Web search capabilities | Optional |
| **Gemini API Key** | Google AI model access | Optional |

At least one direct chat-capable provider is recommended if you want immediate AI chat after setup.

Get your keys at:
- Anthropic: [console.anthropic.com](https://console.anthropic.com/)
- OpenAI: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- ElevenLabs: [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys)
- Perplexity: [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)
- Gemini: [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

### Step 4: Infrastructure Settings

Configure service endpoints. You can use local Docker instances or connect to existing external services.

#### n8n Workflow Engine

| Mode | Description |
|------|-------------|
| **Local (Docker)** | Uses `http://localhost:5678` - start with `docker compose up -d n8n` |
| **External Instance** | Connect to existing n8n (cloud, self-hosted, etc.) |

For external n8n:
- Enter your n8n instance URL (e.g., `https://n8n.example.com`)
- Use the "Test Connection" button to verify connectivity
- Ensure your n8n instance has the required workflows imported

#### Qdrant Vector Database

| Mode | Description |
|------|-------------|
| **Local (Docker)** | Uses `http://localhost:6333` - start with `docker compose up -d qdrant` |
| **External Instance** | Connect to existing Qdrant (cloud, self-hosted, etc.) |

For external Qdrant:
- Enter your Qdrant instance URL (e.g., `https://xyz.qdrant.io:6333`)
- Add your API key if authentication is enabled
- Use the "Test Connection" button to verify connectivity

#### SMTP Settings (Optional)

| Setting | Default | Description |
|---------|---------|-------------|
| **SMTP Host** | - | SMTP server hostname |
| **SMTP Port** | 587 | SMTP port |
| **SMTP User** | - | SMTP username |
| **SMTP Pass** | - | SMTP password |
| **From Address** | - | Email sender address |

### Step 5: Verify & Complete

The wizard verifies your configuration and creates necessary database tables.

---

## Services & Ports

| Service | Default Port | Description | Health Check |
|---------|--------------|-------------|--------------|
| **Dashboard** | 3000 | React frontend with nginx | `/health` |
| **Auth** | 3101 | Authentication, RBAC, API | `/health` |
| **Files** | 3102 | File storage service | `/health` |
| **Collector** | 9848 | Chat streaming & fleet management | `/health` |
| **n8n** | 5678 | Workflow automation (auto-configured) | `/healthz` |
| **Qdrant** | 6333 | Vector database | `/` |

> **Note:** n8n workflows for chat, voice, and transcription are automatically imported and activated on first start.

### Changing Ports

Edit your `.env` file:

```env
DASHBOARD_PORT=8080
AUTH_PORT=8081
FILES_PORT=8082
COLLECTOR_PORT=8083
N8N_PORT=8084
QDRANT_PORT=8085
```

Then restart:

```bash
docker compose down
docker compose up -d
```

---

## Configuration Reference

### Environment Variables

#### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | JWT signing key (32+ chars) | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Data encryption key (64 chars) | `openssl rand -hex 64` |
| `N8N_ENCRYPTION_KEY` | n8n credential encryption | `openssl rand -hex 16` |

#### Optional - API Keys

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude AI conversations |
| `OPENAI_API_KEY` | Embeddings for semantic search |
| `STRIPE_SECRET_KEY` | Plugin purchases |
| `ELEVENLABS_API_KEY` | Text-to-speech |

#### SMTP (Email)

Not an env var. SMTP for user invitations and password resets is configured per-instance
through QuoxVault, not `docker-compose`/`.env` — set it via the Setup Wizard on first run, or
later at Settings -> Instance -> Email & SMTP (`src/pages/settings/instance/EmailSmtpPanel.jsx`).
Until configured, email verification links are written to console/stdout only.

#### Optional - Features

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_DEMO_MODE` | `false` | Enable demo mode (no API keys needed) |
| `JWT_ACCESS_EXPIRY` | `15m` | Access token lifetime |
| `JWT_REFRESH_EXPIRY` | `7d` | Refresh token lifetime |

### File Locations

| Path | Purpose |
|------|---------|
| `/opt/quox/` | Installation directory (Docker) |
| `/opt/quox/config/.env` | Environment configuration |
| `/opt/quox/data/auth/` | Auth service database |
| `/opt/quox/data/n8n/` | n8n workflows and credentials |
| `/opt/quox/data/qdrant/` | Vector database storage |

---

## Troubleshooting

### Services Won't Start

```bash
# Check Docker is running
sudo systemctl status docker

# View container logs
docker compose logs auth
docker compose logs dashboard
docker compose logs n8n

# Restart services
docker compose restart
```

### Permission Errors

```bash
# Fix ownership (Docker containers run as UID 1000)
sudo chown -R 1000:1000 /opt/quox/data
```

### Port Already in Use

```bash
# Find what's using the port
sudo lsof -i :3000

# Or change ports in .env
DASHBOARD_PORT=8080
```

### Database Connection Issues

```bash
# Verify auth service health
curl http://localhost:3101/health

# Expected: {"status":"ok","db":true,...}
```

### Can't Access Dashboard

1. Check firewall allows port 3000:
   ```bash
   sudo ufw allow 3000/tcp
   ```

2. For remote access, bind to all interfaces (default behavior)

3. Check container is running:
   ```bash
   docker ps | grep quox-dashboard
   ```

### Development Mode: SSL Certificate Errors

If you see `ENOENT: no such file or directory, open 'certs/key.pem'`:

```bash
# Option 1: Generate self-signed certificates
npm run generate-certs

# Option 2: The app now automatically falls back to HTTP
# Just restart: npm run dev
```

### Development Mode: Auth Database Errors

If init-db fails with "directory does not exist":

```bash
cd services/auth
mkdir -p data
npm run init-db
```

### Dashboard Boot Animation Stuck

If the boot animation shows but never completes:

1. Check browser console for JavaScript errors (F12 > Console)
2. Verify auth service is running: `curl http://localhost:3101/health`
3. Check for build errors: `npm run build`

### Package Lock Integrity Errors

If `npm install` fails with EINTEGRITY errors:

```bash
# Delete and regenerate package-lock.json
rm package-lock.json
npm install
```

---

## Upgrading

### Docker Installation

```bash
cd /opt/quox

# Pull latest images
docker compose pull

# Restart with new images
docker compose up -d

# Verify health
docker compose ps
```

### Development Installation

```bash
git pull
npm install
cd services/auth && npm install && cd ../..
npm run build
```

---

## Uninstalling

### Docker Installation

```bash
# Stop and remove containers
cd /opt/quox
docker compose down

# Remove images
docker compose down --rmi all

# Remove data (DESTRUCTIVE!)
sudo rm -rf /opt/quox
```

### Development Installation

```bash
# Remove the directory
rm -rf quox-dashboard
```

---

## Security Checklist

Before going to production:

- [ ] Generate unique `JWT_SECRET` and `ENCRYPTION_KEY`
- [ ] Never commit `.env` files to version control
- [ ] Set up HTTPS with a reverse proxy (nginx, Caddy, Traefik)
- [ ] Configure firewall to only expose port 443
- [ ] Review API key permissions (use minimal scopes)
- [ ] Enable MFA for admin accounts
- [ ] Set up regular database backups
- [ ] Monitor logs for suspicious activity

---

## Next Steps

1. **Optional: authenticate Claude CLI**:
   ```bash
   docker exec -it quox-collector claude login
   ```
   This opens a browser for OAuth authentication with your Anthropic subscription.
   Skip this if you are using direct OpenAI or Anthropic API keys instead.

2. **Log In**: Open `http://localhost:3000/login` with your admin credentials
3. **Explore**: Navigate through Dashboard, Agents, Memory, Workflows
4. **Deploy QuoxAgent**: Install agents on your infrastructure hosts
5. **Read the Docs**: Check [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](AGENTS.md)

> **Note:** n8n workflows are automatically configured on first start - no manual setup required.

---

## Migration

If you're migrating from an existing QuoxCORE installation, see the [Migration Guide](MIGRATION.md) for:

- Backing up and restoring data
- Transferring users and organizations
- Migrating n8n workflows
- Moving Qdrant vector data
- Plugin license transfers

---

## Getting Help

- **Documentation**: [docs/](.)
- **Issues**: [GitHub Issues](https://github.com/quoxai/quox/issues)
- **Community**: [Discord](https://discord.gg/quoxcore) (coming soon)
