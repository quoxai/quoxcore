# Quox Auth Service

Authentication and authorization service for Quox Enterprise Workspace.

## Features

- JWT-based authentication with refresh tokens
- Email/password signup and login
- MFA (TOTP) with backup codes
- Organization and team management
- Role-based access control (RBAC)
- Rate limiting
- Audit logging
- Dev mode for local development

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Start the service
npm run dev
```

The service runs on port 3101 by default.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_PORT` | No | 3101 | Server port |
| `AUTH_HOST` | No | 0.0.0.0 | Bind address |
| `NODE_ENV` | No | development | Environment mode |
| `AUTH_DB_PATH` | No | ./data/auth.db | SQLite database path |
| `JWT_SECRET` | **Yes** | - | JWT signing secret (generate with `npm run generate-secret`) |
| `JWT_ACCESS_EXPIRY` | No | 15m | Access token lifetime |
| `JWT_REFRESH_EXPIRY` | No | 7d | Refresh token lifetime |
| `CORS_ORIGINS` | No | localhost | Comma-separated allowed origins |

## Scripts

```bash
npm start              # Start production server
npm run dev            # Start with file watching
npm run generate-secret # Generate secure JWT_SECRET
npm run init-db        # Initialize database
npm test               # Run tests
```

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/signup` | Create account |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| POST | `/api/auth/refresh` | Refresh token |
| GET | `/api/auth/me` | Get current user |
| POST | `/api/auth/verify-email` | Verify email |
| POST | `/api/auth/forgot-password` | Request password reset |
| POST | `/api/auth/reset-password` | Complete password reset |

### Setup (First-run)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/setup/status` | Check setup status |
| POST | `/api/setup/admin` | Create first admin |
| POST | `/api/setup/dev-login` | Dev mode auto-login |
| POST | `/api/setup/config` | Save configuration |

### Organizations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/orgs` | List user's organizations |
| POST | `/api/orgs` | Create organization |
| GET | `/api/orgs/:id` | Get organization |
| PATCH | `/api/orgs/:id` | Update organization |
| GET | `/api/orgs/:id/members` | List members |
| POST | `/api/orgs/:id/members` | Invite member |

### MFA

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/mfa/setup` | Start MFA setup |
| POST | `/api/mfa/verify-setup` | Complete MFA setup |
| POST | `/api/mfa/verify` | Verify MFA code |
| POST | `/api/mfa/disable` | Disable MFA |

## Dev Mode

For local development, the service provides a dev mode that:

1. Creates a real user (`dev@quox.local`) in the database
2. Returns valid JWT tokens
3. Maintains full persistence (unlike mock users)

**To use dev mode:**
- Click "Enter as Dev User" on the login page (local environments only)
- Or call `POST /api/setup/dev-login`

**To hide dev mode:**
- Go to Settings > General > Development Mode
- Toggle "Hide Dev Mode on Login"

## Production Deployment

1. **Generate a secure JWT secret:**
   ```bash
   npm run generate-secret
   # Add the output to your .env file
   ```

2. **Set NODE_ENV:**
   ```bash
   NODE_ENV=production
   ```

3. **Configure SMTP** for email verification (optional)

4. **Set up reverse proxy** (nginx) for HTTPS

The service will refuse to start in production mode with the default JWT secret.

## Security Features

- Argon2id password hashing (64MB memory, 3 iterations)
- JWT with 15-minute access tokens
- HTTPOnly, Secure cookies (in production)
- Rate limiting on auth endpoints
- Full audit trail
- MFA with TOTP and backup codes

## Database

Uses SQLite with WAL mode. Schema files:
- `db/schema.sql` - Core tables
- `db/schema-a5.sql` - Instance admin, API keys
- `db/schema-b1.sql` - Organization model
- `db/schema-c1.sql` - HITL (runs, inbox)
- `db/schema-b2-tools.sql` - Tool library

Migrations run automatically on startup.
