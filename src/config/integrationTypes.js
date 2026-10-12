/**
 * Integration Types Configuration — GENERATED FILE, do not hand-edit.
 *
 * Regenerate with: node scripts/sync-integration-types.mjs
 * Source of truth: services/auth/config/integrationTypeRegistry.js
 *
 * This is the offline/pre-fetch fallback src/hooks/useIntegrationTypes.js
 * serves when the live /api/orgs/:orgId/vault/types call hasn't landed yet
 * (or fails). It intentionally excludes validateCredentials/testEndpoint
 * function bodies and any live-test wiring — those are backend-only and run
 * against decrypted secrets server-side. `hasLiveTest` records whether the
 * backend registry can run a real network probe for that type at all;
 * `testDepth` (VAULT-INTEG P8) is the same fact as a 3-way enum
 * ('live'|'format-only'|'none') so the UI can render a distinct badge for a
 * format-only pass instead of a bare true/false.
 *
 * src/test/integrationTypesSync.test.js fails the build if this file (or
 * services/auth/config/integration-types.export.json) drifts from the
 * backend registry — see that test before hand-editing this file back out
 * of sync; regenerate instead.
 */

export const INTEGRATION_TYPES = {
    "npm": {
        "id": "npm",
        "name": "npm",
        "description": "npm registry: package metadata, dist-tags, search, and token identity (publishing rides OIDC trusted publishing, not this token)",
        "color": "#CB3837",
        "fields": [
            {
                "key": "token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "npm granular or automation access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://docs.npmjs.com/about-access-tokens"
    },
    "pypi": {
        "id": "pypi",
        "name": "PyPI",
        "description": "PyPI upload token (format check only: PyPI API tokens authorize uploads and have no read endpoint to live-test against)",
        "color": "#3775A9",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "pypi-..."
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "devops",
        "docs": "https://pypi.org/help/#apitoken"
    },
    "ward_webhook": {
        "id": "ward_webhook",
        "name": "WARD Evidence Webhook",
        "description": "Endpoint that receives each witnessed WARD evidence tip as it is published.",
        "color": "#7c3aed",
        "fields": [
            {
                "key": "url",
                "label": "Endpoint URL",
                "type": "url",
                "required": true,
                "placeholder": "https://evidence.example.com/ward"
            },
            {
                "key": "auth_header",
                "label": "Authorization header value",
                "type": "password",
                "required": false,
                "placeholder": "Sent as the Authorization header, e.g. Bearer <token>"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "none",
        "category": "devops",
        "docs": "https://quox.ai/docs"
    },
    "gitea": {
        "id": "gitea",
        "name": "Gitea",
        "description": "Self-hosted Git service",
        "color": "#609926",
        "fields": [
            {
                "key": "token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Gitea personal/project access token"
            },
            {
                "key": "base_url",
                "label": "Gitea URL",
                "type": "url",
                "required": true,
                "placeholder": "https://gitea.example.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://docs.gitea.com/development/api-usage"
    },
    "smtp": {
        "id": "smtp",
        "name": "Email Account (IMAP + SMTP)",
        "description": "Send-only SMTP transport for transactional email, HITL notifications and QuoxChat transcripts, plus optional IMAP fields for the email_read tool executor. Field names match the email_account credential kind used by the instance email panel (EMAIL-UNIFY P2).",
        "color": "#EA580C",
        "fields": [
            {
                "key": "smtp_host",
                "label": "SMTP Host",
                "type": "text",
                "required": true,
                "placeholder": "smtp.example.com"
            },
            {
                "key": "smtp_port",
                "label": "SMTP Port",
                "type": "number",
                "required": true,
                "placeholder": "587",
                "default": "587"
            },
            {
                "key": "smtp_secure",
                "label": "Use TLS (SMTPS)",
                "type": "boolean",
                "required": false,
                "default": false
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": false,
                "placeholder": "Optional — omit for unauthenticated relays"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": false,
                "placeholder": "Optional"
            },
            {
                "key": "from",
                "label": "From Address",
                "type": "text",
                "required": true,
                "placeholder": "notifications@example.com"
            },
            {
                "key": "imap_host",
                "label": "IMAP Host",
                "type": "text",
                "required": false,
                "placeholder": "imap.example.com"
            },
            {
                "key": "imap_port",
                "label": "IMAP Port",
                "type": "number",
                "required": false,
                "placeholder": "993",
                "default": "993"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "notification",
        "docs": "https://nodemailer.com/smtp/"
    },
    "gmail": {
        "id": "gmail",
        "name": "Gmail",
        "description": "Connect a Gmail or Google Workspace mailbox over IMAP using an app-specific password (Google blocks your normal password for third-party IMAP, so 2-Step Verification must be on). Host and ports are pre-filled.",
        "color": "#EA4335",
        "fields": [
            {
                "key": "username",
                "label": "Email Address",
                "type": "text",
                "required": true,
                "placeholder": "you@gmail.com"
            },
            {
                "key": "password",
                "label": "App Password",
                "type": "password",
                "required": true,
                "placeholder": "16-character app password"
            },
            {
                "key": "imap_host",
                "label": "IMAP Host",
                "type": "text",
                "required": false,
                "placeholder": "imap.gmail.com",
                "default": "imap.gmail.com"
            },
            {
                "key": "imap_port",
                "label": "IMAP Port",
                "type": "number",
                "required": false,
                "placeholder": "993",
                "default": "993"
            },
            {
                "key": "smtp_host",
                "label": "SMTP Host",
                "type": "text",
                "required": false,
                "placeholder": "smtp.gmail.com",
                "default": "smtp.gmail.com"
            },
            {
                "key": "smtp_port",
                "label": "SMTP Port",
                "type": "number",
                "required": false,
                "placeholder": "465",
                "default": "465"
            },
            {
                "key": "smtp_secure",
                "label": "Use TLS (SMTPS)",
                "type": "boolean",
                "required": false,
                "default": true
            },
            {
                "key": "from",
                "label": "From Address",
                "type": "text",
                "required": false,
                "placeholder": "Defaults to your email address"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "email",
        "docs": "https://support.google.com/accounts/answer/185833"
    },
    "icloud": {
        "id": "icloud",
        "name": "iCloud Mail",
        "description": "Connect an iCloud (@icloud.com/@me.com/@mac.com) mailbox over IMAP using an Apple app-specific password (requires two-factor auth on the Apple ID). Host and ports are pre-filled.",
        "color": "#3D9BE9",
        "fields": [
            {
                "key": "username",
                "label": "Email Address",
                "type": "text",
                "required": true,
                "placeholder": "you@icloud.com"
            },
            {
                "key": "password",
                "label": "App-Specific Password",
                "type": "password",
                "required": true,
                "placeholder": "app-specific password from appleid.apple.com"
            },
            {
                "key": "imap_host",
                "label": "IMAP Host",
                "type": "text",
                "required": false,
                "placeholder": "imap.mail.me.com",
                "default": "imap.mail.me.com"
            },
            {
                "key": "imap_port",
                "label": "IMAP Port",
                "type": "number",
                "required": false,
                "placeholder": "993",
                "default": "993"
            },
            {
                "key": "smtp_host",
                "label": "SMTP Host",
                "type": "text",
                "required": false,
                "placeholder": "smtp.mail.me.com",
                "default": "smtp.mail.me.com"
            },
            {
                "key": "smtp_port",
                "label": "SMTP Port",
                "type": "number",
                "required": false,
                "placeholder": "587",
                "default": "587"
            },
            {
                "key": "smtp_secure",
                "label": "Use TLS",
                "type": "boolean",
                "required": false,
                "default": true
            },
            {
                "key": "from",
                "label": "From Address",
                "type": "text",
                "required": false,
                "placeholder": "Defaults to your email address"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "email",
        "docs": "https://support.apple.com/en-us/102654"
    },
    "icloud_contacts": {
        "id": "icloud_contacts",
        "name": "iCloud Contacts",
        "description": "Pull your iCloud address book into ContactsQ over CardDAV, one way and read only. Use your Apple ID and an app-specific password (requires two-factor auth on the Apple ID).",
        "color": "#3D9BE9",
        "fields": [
            {
                "key": "username",
                "label": "Apple ID",
                "type": "text",
                "required": true,
                "placeholder": "you@icloud.com"
            },
            {
                "key": "password",
                "label": "App-Specific Password",
                "type": "password",
                "required": true,
                "placeholder": "xxxx-xxxx-xxxx-xxxx"
            },
            {
                "key": "server_url",
                "label": "Server URL",
                "type": "text",
                "required": false,
                "placeholder": "https://contacts.icloud.com",
                "default": "https://contacts.icloud.com"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "productivity",
        "docs": "https://support.apple.com/en-us/102654"
    },
    "carddav": {
        "id": "carddav",
        "name": "CardDAV Address Book",
        "description": "Pull a CardDAV address book (Fastmail, Nextcloud and others) into ContactsQ, one way and read only.",
        "color": "#64748B",
        "fields": [
            {
                "key": "server_url",
                "label": "Server URL",
                "type": "text",
                "required": true,
                "placeholder": "https://carddav.fastmail.com"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "you@example.com"
            },
            {
                "key": "password",
                "label": "Password or App Password",
                "type": "password",
                "required": true,
                "placeholder": "app password"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "productivity",
        "docs": "https://datatracker.ietf.org/doc/html/rfc6352"
    },
    "outlook": {
        "id": "outlook",
        "name": "Outlook / Microsoft 365",
        "description": "Connect an Outlook.com or Microsoft 365 mailbox over IMAP using an app password (requires two-step verification). Host and ports are pre-filled.",
        "color": "#0F6CBD",
        "fields": [
            {
                "key": "username",
                "label": "Email Address",
                "type": "text",
                "required": true,
                "placeholder": "you@outlook.com"
            },
            {
                "key": "password",
                "label": "App Password",
                "type": "password",
                "required": true,
                "placeholder": "app password from account.microsoft.com/security"
            },
            {
                "key": "imap_host",
                "label": "IMAP Host",
                "type": "text",
                "required": false,
                "placeholder": "outlook.office365.com",
                "default": "outlook.office365.com"
            },
            {
                "key": "imap_port",
                "label": "IMAP Port",
                "type": "number",
                "required": false,
                "placeholder": "993",
                "default": "993"
            },
            {
                "key": "smtp_host",
                "label": "SMTP Host",
                "type": "text",
                "required": false,
                "placeholder": "smtp.office365.com",
                "default": "smtp.office365.com"
            },
            {
                "key": "smtp_port",
                "label": "SMTP Port",
                "type": "number",
                "required": false,
                "placeholder": "587",
                "default": "587"
            },
            {
                "key": "smtp_secure",
                "label": "Use TLS",
                "type": "boolean",
                "required": false,
                "default": true
            },
            {
                "key": "from",
                "label": "From Address",
                "type": "text",
                "required": false,
                "placeholder": "Defaults to your email address"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "email",
        "docs": "https://support.microsoft.com/en-us/account-billing/create-app-passwords-d385a87e-9c48-4204-b8ba-d4f57c5b6c0e"
    },
    "webhook": {
        "id": "webhook",
        "name": "Generic Webhook",
        "description": "Outgoing webhook for a custom notification target not covered by a named provider.",
        "color": "#64748B",
        "fields": [
            {
                "key": "url",
                "label": "Webhook URL",
                "type": "url",
                "required": true,
                "placeholder": "https://example.com/hooks/quox"
            },
            {
                "key": "secret",
                "label": "Shared Secret",
                "type": "password",
                "required": false,
                "placeholder": "Optional — sent as a signing header if set"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "notification"
    },
    "mattermost": {
        "id": "mattermost",
        "name": "Mattermost",
        "description": "Mattermost incoming webhook notifications",
        "color": "#0058CC",
        "fields": [
            {
                "key": "webhook_url",
                "label": "Incoming Webhook URL",
                "type": "password",
                "required": true,
                "placeholder": "https://mattermost.example.com/hooks/..."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "notification",
        "docs": "https://developers.mattermost.com/integrate/webhooks/incoming/"
    },
    "google-chat": {
        "id": "google-chat",
        "name": "Google Chat",
        "description": "Google Chat space incoming webhook notifications",
        "color": "#00AC47",
        "fields": [
            {
                "key": "webhook_url",
                "label": "Incoming Webhook URL",
                "type": "password",
                "required": true,
                "placeholder": "https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=..."
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "notification",
        "docs": "https://developers.google.com/workspace/chat/quickstart/webhooks"
    },
    "gotify": {
        "id": "gotify",
        "name": "Gotify",
        "description": "Self-hosted push notification server",
        "color": "#3A4D9F",
        "fields": [
            {
                "key": "server_url",
                "label": "Server URL",
                "type": "url",
                "required": true,
                "placeholder": "https://gotify.example.com"
            },
            {
                "key": "app_token",
                "label": "Application Token",
                "type": "password",
                "required": true,
                "placeholder": "Gotify app token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "notification",
        "docs": "https://gotify.net/api-docs"
    },
    "rocketchat": {
        "id": "rocketchat",
        "name": "Rocket.Chat",
        "description": "Rocket.Chat incoming webhook notifications",
        "color": "#F5455C",
        "fields": [
            {
                "key": "webhook_url",
                "label": "Incoming Webhook URL",
                "type": "password",
                "required": true,
                "placeholder": "https://rocketchat.example.com/hooks/..."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "notification",
        "docs": "https://developer.rocket.chat/docs/webhooks"
    },
    "dataforseo": {
        "id": "dataforseo",
        "name": "DataForSEO",
        "description": "Keyword volume, difficulty and CPC data, plus true SERP rank tracking. Powers the QuoxSEO paid keyword and rank data layer.",
        "color": "#2b6cb0",
        "fields": [
            {
                "key": "login",
                "label": "API Login (account email)",
                "type": "text",
                "required": true,
                "placeholder": "you@example.com"
            },
            {
                "key": "password",
                "label": "API Password",
                "type": "password",
                "required": true,
                "placeholder": "DataForSEO dashboard → API Access"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://docs.dataforseo.com/v3/"
    },
    "openai": {
        "id": "openai",
        "name": "OpenAI",
        "description": "GPT models, embeddings, and DALL-E",
        "color": "#00A67E",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "sk-...",
                "prefix": "sk-"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://platform.openai.com/docs/api-reference"
    },
    "anthropic": {
        "id": "anthropic",
        "name": "Anthropic",
        "description": "Claude models and API",
        "color": "#D4A574",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "sk-ant-...",
                "prefix": "sk-ant-"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.anthropic.com/en/api"
    },
    "gemini": {
        "id": "gemini",
        "name": "Google Gemini",
        "description": "Gemini models and Vertex AI",
        "color": "#4285F4",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "AIza..."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://ai.google.dev/docs"
    },
    "elevenlabs": {
        "id": "elevenlabs",
        "name": "ElevenLabs",
        "description": "Text-to-speech and voice cloning",
        "color": "#000000",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.elevenlabs.io/api-reference"
    },
    "cohere": {
        "id": "cohere",
        "name": "Cohere",
        "description": "Command, Embed, and Rerank models",
        "color": "#39594D",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.cohere.com/"
    },
    "mistral": {
        "id": "mistral",
        "name": "Mistral AI",
        "description": "Mistral and Mixtral models",
        "color": "#FF7000",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.mistral.ai/"
    },
    "groq": {
        "id": "groq",
        "name": "Groq",
        "description": "Ultra-fast LPU inference (Llama, Mixtral)",
        "color": "#F55036",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "gsk_...",
                "prefix": "gsk_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://console.groq.com/docs"
    },
    "xai": {
        "id": "xai",
        "name": "xAI (Grok)",
        "description": "Grok models from xAI",
        "color": "#000000",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "xai-...",
                "prefix": "xai-"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.x.ai/"
    },
    "deepseek": {
        "id": "deepseek",
        "name": "DeepSeek",
        "description": "DeepSeek Coder and Chat models",
        "color": "#4D6BFE",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "sk-...",
                "prefix": "sk-"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://platform.deepseek.com/api-docs"
    },
    "together": {
        "id": "together",
        "name": "Together AI",
        "description": "Open-source model inference (Llama, Mistral, etc.)",
        "color": "#0F6FFF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.together.ai/"
    },
    "replicate": {
        "id": "replicate",
        "name": "Replicate",
        "description": "Run open-source models in the cloud",
        "color": "#000000",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "r8_...",
                "prefix": "r8_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://replicate.com/docs"
    },
    "huggingface": {
        "id": "huggingface",
        "name": "Hugging Face",
        "description": "Inference API and model hub",
        "color": "#FFD21E",
        "fields": [
            {
                "key": "api_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "hf_...",
                "prefix": "hf_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://huggingface.co/docs/api-inference"
    },
    "perplexity": {
        "id": "perplexity",
        "name": "Perplexity",
        "description": "Sonar search-augmented models",
        "color": "#20808D",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "pplx-...",
                "prefix": "pplx-"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.perplexity.ai/"
    },
    "fireworks": {
        "id": "fireworks",
        "name": "Fireworks AI",
        "description": "Fast inference for open models",
        "color": "#FF6B35",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "fw_...",
                "prefix": "fw_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.fireworks.ai/"
    },
    "openrouter": {
        "id": "openrouter",
        "name": "OpenRouter",
        "description": "One key, 300+ LLMs (OpenAI-compatible)",
        "color": "#6467F2",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "sk-or-..."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://openrouter.ai/docs"
    },
    "deepgram": {
        "id": "deepgram",
        "name": "Deepgram",
        "description": "Speech-to-text: streaming/latency-leading transcription",
        "color": "#13EF93",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Deepgram API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.deepgram.com/reference/"
    },
    "exa": {
        "id": "exa",
        "name": "Exa",
        "description": "Neural web search + contents for agent grounding",
        "color": "#1F2937",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Exa API key"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://docs.exa.ai"
    },
    "tavily": {
        "id": "tavily",
        "name": "Tavily",
        "description": "Agent-search default, 1000 free credits/mo",
        "color": "#3B82F6",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "tvly-...",
                "prefix": "tvly-"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://docs.tavily.com"
    },
    "fal": {
        "id": "fal",
        "name": "fal.ai",
        "description": "1000+ image/video/audio models, one key",
        "color": "#EC4899",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your fal API key"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://docs.fal.ai"
    },
    "stability": {
        "id": "stability",
        "name": "Stability AI",
        "description": "Stable Diffusion image generation",
        "color": "#9B59B6",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "sk-...",
                "prefix": "sk-"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://platform.stability.ai/docs/api-reference"
    },
    "leonardo": {
        "id": "leonardo",
        "name": "Leonardo AI",
        "description": "AI image generation and editing",
        "color": "#7B68EE",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "leonardo_...",
                "prefix": "leonardo_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.leonardo.ai/"
    },
    "ideogram": {
        "id": "ideogram",
        "name": "Ideogram",
        "description": "AI image generation with text rendering",
        "color": "#FF6B6B",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://developer.ideogram.ai/api-reference"
    },
    "midjourney": {
        "id": "midjourney",
        "name": "Midjourney",
        "description": "Midjourney image generation (via proxy)",
        "color": "#000000",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your proxy API key"
            },
            {
                "key": "base_url",
                "label": "Proxy URL",
                "type": "url",
                "required": true,
                "placeholder": "https://api.yourproxy.com"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://docs.midjourney.com/"
    },
    "dalleapi": {
        "id": "dalleapi",
        "name": "DALL-E API",
        "description": "OpenAI DALL-E image generation (standalone)",
        "color": "#00A67E",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "sk-...",
                "prefix": "sk-"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://platform.openai.com/docs/api-reference/images"
    },
    "runway": {
        "id": "runway",
        "name": "Runway ML",
        "description": "Gen-2, Gen-3 video generation",
        "color": "#00D4FF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.runwayml.com/"
    },
    "pika": {
        "id": "pika",
        "name": "Pika Labs",
        "description": "AI video generation",
        "color": "#FF69B4",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://pika.art/"
    },
    "luma": {
        "id": "luma",
        "name": "Luma AI",
        "description": "Dream Machine video generation",
        "color": "#8B5CF6",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.lumalabs.ai/"
    },
    "kling": {
        "id": "kling",
        "name": "Kling AI",
        "description": "AI video generation (China-based)",
        "color": "#E11D48",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            },
            {
                "key": "base_url",
                "label": "API Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://api.klingai.com"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://klingai.com/"
    },
    "heygen": {
        "id": "heygen",
        "name": "HeyGen",
        "description": "AI video avatars and talking heads",
        "color": "#6366F1",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.heygen.com/"
    },
    "suno": {
        "id": "suno",
        "name": "Suno AI",
        "description": "AI music and song generation",
        "color": "#F59E0B",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://suno.ai/"
    },
    "zapier": {
        "id": "zapier",
        "name": "Zapier",
        "description": "Automation platform connecting 5000+ apps",
        "color": "#FF4A00",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Zapier NLA API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://actions.zapier.com/docs/platform/api"
    },
    "make": {
        "id": "make",
        "name": "Make (Integromat)",
        "description": "Visual automation platform for workflows",
        "color": "#6D00CC",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Make API token"
            },
            {
                "key": "team_id",
                "label": "Team ID",
                "type": "text",
                "required": true,
                "placeholder": "Your team ID"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://www.make.com/en/api-documentation"
    },
    "ifttt": {
        "id": "ifttt",
        "name": "IFTTT",
        "description": "Simple automation for everyday tasks",
        "color": "#000000",
        "fields": [
            {
                "key": "service_key",
                "label": "Service Key",
                "type": "password",
                "required": true,
                "placeholder": "Your IFTTT Webhooks service key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://ifttt.com/docs"
    },
    "pipedream": {
        "id": "pipedream",
        "name": "Pipedream",
        "description": "Developer-first automation platform",
        "color": "#1E88E5",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Pipedream API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://pipedream.com/docs/api/"
    },
    "activepieces": {
        "id": "activepieces",
        "name": "Activepieces",
        "description": "Open-source automation platform",
        "color": "#6E41E2",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Activepieces API key"
            },
            {
                "key": "base_url",
                "label": "Instance URL",
                "type": "url",
                "required": true,
                "placeholder": "https://activepieces.example.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://www.activepieces.com/docs"
    },
    "tray": {
        "id": "tray",
        "name": "Tray.io",
        "description": "Enterprise automation platform",
        "color": "#12B886",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Tray.io access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://tray.io/documentation"
    },
    "workato": {
        "id": "workato",
        "name": "Workato",
        "description": "Enterprise automation and integration platform",
        "color": "#00538B",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Workato API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.workato.com/workato-api.html"
    },
    "power_automate": {
        "id": "power_automate",
        "name": "Power Automate",
        "description": "Microsoft Power Automate (Flow)",
        "color": "#0066FF",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Azure AD Application ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your client secret"
            },
            {
                "key": "tenant_id",
                "label": "Tenant ID",
                "type": "text",
                "required": true,
                "placeholder": "Azure AD Tenant ID"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://learn.microsoft.com/en-us/power-automate/web-api"
    },
    "airtable": {
        "id": "airtable",
        "name": "Airtable",
        "description": "Spreadsheet-database hybrid with automation",
        "color": "#18BFFF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key / Personal Access Token",
                "type": "password",
                "required": true,
                "placeholder": "pat... or key..."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://airtable.com/developers/web/api/introduction"
    },
    "notion": {
        "id": "notion",
        "name": "Notion",
        "description": "All-in-one workspace with database automation",
        "color": "#000000",
        "fields": [
            {
                "key": "integration_token",
                "label": "Integration Token",
                "type": "password",
                "required": true,
                "placeholder": "secret_... or ntn_..."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.notion.com/"
    },
    "gdrive": {
        "id": "gdrive",
        "name": "Google Drive",
        "description": "Docs and files from a connected Google Drive account",
        "color": "#0F9D58",
        "fields": [
            {
                "key": "integration_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "ya29..."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.google.com/drive/api/guides/about-sdk"
    },
    "google_service_account": {
        "id": "google_service_account",
        "name": "Google Service Account",
        "description": "Server-to-server Google API credential (Search Console, Analytics): the downloaded service-account JSON key",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account Key (JSON)",
                "type": "password",
                "required": true,
                "placeholder": "{ \"type\": \"service_account\", ... }"
            },
            {
                "key": "property_url",
                "label": "Property / Scope Hint",
                "type": "text",
                "required": false,
                "placeholder": "sc-domain:example.com"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "integrations",
        "docs": "https://developers.google.com/identity/protocols/oauth2/service-account"
    },
    "obsidian": {
        "id": "obsidian",
        "name": "Obsidian",
        "description": "Knowledge base with local REST API plugin",
        "color": "#7C3AED",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Local REST API key"
            },
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": false,
                "placeholder": "https://127.0.0.1:27124"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "productivity",
        "docs": "https://github.com/coddingtonbear/obsidian-local-rest-api"
    },
    "roam_research": {
        "id": "roam_research",
        "name": "Roam Research",
        "description": "Networked thought and note-taking",
        "color": "#0066FF",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Roam API token"
            },
            {
                "key": "graph_name",
                "label": "Graph Name",
                "type": "text",
                "required": true,
                "placeholder": "your-graph"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "productivity",
        "docs": "https://roamresearch.com/#/app/developer-documentation"
    },
    "logseq": {
        "id": "logseq",
        "name": "Logseq",
        "description": "Privacy-first knowledge base",
        "color": "#85C8C8",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Logseq API token"
            },
            {
                "key": "base_url",
                "label": "API URL",
                "type": "url",
                "required": false,
                "placeholder": "http://127.0.0.1:12315"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "productivity",
        "docs": "https://docs.logseq.com/"
    },
    "telegram": {
        "id": "telegram",
        "name": "Telegram Bot",
        "description": "Telegram messaging bot",
        "color": "#0088CC",
        "fields": [
            {
                "key": "bot_token",
                "label": "Bot Token",
                "type": "password",
                "required": true,
                "placeholder": "123456:ABC-DEF..."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://core.telegram.org/bots/api"
    },
    "slack": {
        "id": "slack",
        "name": "Slack",
        "description": "Slack workspace integration",
        "color": "#4A154B",
        "fields": [
            {
                "key": "bot_token",
                "label": "Bot Token",
                "type": "password",
                "required": true,
                "placeholder": "xoxb-...",
                "prefix": "xoxb-"
            },
            {
                "key": "signing_secret",
                "label": "Signing Secret",
                "type": "password",
                "required": false,
                "placeholder": "Optional"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://api.slack.com/docs"
    },
    "whatsapp": {
        "id": "whatsapp",
        "name": "WhatsApp Business API",
        "description": "WhatsApp Business messaging platform",
        "color": "#25D366",
        "fields": [
            {
                "key": "phone_number_id",
                "label": "Phone Number ID",
                "type": "text",
                "required": true,
                "placeholder": "Your phone number ID"
            },
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.facebook.com/docs/whatsapp/cloud-api"
    },
    "messenger": {
        "id": "messenger",
        "name": "Facebook Messenger",
        "description": "Facebook Messenger bot platform",
        "color": "#0084FF",
        "fields": [
            {
                "key": "page_access_token",
                "label": "Page Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your page access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.facebook.com/docs/messenger-platform"
    },
    "viber": {
        "id": "viber",
        "name": "Viber Bot",
        "description": "Viber messaging bot platform",
        "color": "#665CAC",
        "fields": [
            {
                "key": "auth_token",
                "label": "Auth Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Viber auth token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.viber.com/docs/api/rest-bot-api/"
    },
    "line": {
        "id": "line",
        "name": "LINE Messaging",
        "description": "LINE Messaging API platform",
        "color": "#00B900",
        "fields": [
            {
                "key": "channel_access_token",
                "label": "Channel Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your channel access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.line.biz/en/docs/messaging-api/"
    },
    "wechat": {
        "id": "wechat",
        "name": "WeChat Official",
        "description": "WeChat Official Account platform",
        "color": "#07C160",
        "fields": [
            {
                "key": "app_id",
                "label": "App ID",
                "type": "text",
                "required": true,
                "placeholder": "Your WeChat App ID"
            },
            {
                "key": "app_secret",
                "label": "App Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your WeChat App Secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.weixin.qq.com/doc/offiaccount/en/Getting_Started/Overview.html"
    },
    "intercom": {
        "id": "intercom",
        "name": "Intercom",
        "description": "Customer messaging platform",
        "color": "#1F8DED",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Intercom access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.intercom.com/docs"
    },
    "drift": {
        "id": "drift",
        "name": "Drift (Salesloft)",
        "description": "Conversational marketing (acquired by Salesloft 2024)",
        "color": "#0176FF",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Drift access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://devdocs.drift.com/"
    },
    "crisp": {
        "id": "crisp",
        "name": "Crisp",
        "description": "Customer messaging and support platform",
        "color": "#1972F5",
        "fields": [
            {
                "key": "identifier",
                "label": "Identifier",
                "type": "text",
                "required": true,
                "placeholder": "Your Crisp identifier"
            },
            {
                "key": "key",
                "label": "Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Crisp key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.crisp.chat/api/v1/"
    },
    "tawk": {
        "id": "tawk",
        "name": "Tawk.to",
        "description": "Live chat and messaging platform",
        "color": "#03A84E",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Tawk.to API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.tawk.to/"
    },
    "zendeskchat": {
        "id": "zendeskchat",
        "name": "Zendesk Chat",
        "description": "Zendesk live chat platform",
        "color": "#03363D",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Zendesk Chat access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.zendesk.com/api-reference/live-chat/chat-api/introduction/"
    },
    "custom": {
        "id": "custom",
        "name": "Custom Integration",
        "description": "Custom API with configurable auth",
        "color": "#6B7280",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key / Token",
                "type": "password",
                "required": true,
                "placeholder": "Your API key or token"
            },
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://api.example.com"
            },
            {
                "key": "auth_header",
                "label": "Auth Header",
                "type": "text",
                "required": false,
                "placeholder": "Authorization",
                "default": "Authorization"
            },
            {
                "key": "auth_prefix",
                "label": "Auth Prefix",
                "type": "text",
                "required": false,
                "placeholder": "Bearer",
                "default": "Bearer"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "none",
        "docs": null
    },
    "github": {
        "id": "github",
        "name": "GitHub",
        "description": "GitHub repositories and CI/CD",
        "color": "#24292E",
        "fields": [
            {
                "key": "token",
                "label": "Personal Access Token",
                "type": "password",
                "required": true,
                "placeholder": "ghp_... or github_pat_..."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://docs.github.com/en/rest"
    },
    "gitlab": {
        "id": "gitlab",
        "name": "GitLab",
        "description": "GitLab repositories and CI/CD",
        "color": "#FC6D26",
        "fields": [
            {
                "key": "private_token",
                "label": "Private Token",
                "type": "password",
                "required": true,
                "placeholder": "glpat-...",
                "prefix": "glpat-"
            },
            {
                "key": "base_url",
                "label": "GitLab URL",
                "type": "url",
                "required": false,
                "placeholder": "https://gitlab.com",
                "default": "https://gitlab.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.gitlab.com/ee/api/"
    },
    "bitbucket": {
        "id": "bitbucket",
        "name": "Bitbucket",
        "description": "Bitbucket repositories and pipelines",
        "color": "#0052CC",
        "fields": [
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "Your Bitbucket username"
            },
            {
                "key": "app_password",
                "label": "App Password",
                "type": "password",
                "required": true,
                "placeholder": "App password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.atlassian.com/cloud/bitbucket/rest/intro/"
    },
    "circleci": {
        "id": "circleci",
        "name": "CircleCI",
        "description": "CircleCI pipelines and workflows",
        "color": "#343434",
        "fields": [
            {
                "key": "token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "CircleCI API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://circleci.com/docs/api/v2/"
    },
    "jenkins": {
        "id": "jenkins",
        "name": "Jenkins",
        "description": "Jenkins CI/CD server",
        "color": "#D33833",
        "fields": [
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "Jenkins username"
            },
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Jenkins API token"
            },
            {
                "key": "base_url",
                "label": "Jenkins URL",
                "type": "url",
                "required": true,
                "placeholder": "https://jenkins.example.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://www.jenkins.io/doc/book/using/remote-access-api/"
    },
    "docker": {
        "id": "docker",
        "name": "Docker Hub",
        "description": "Docker Hub registry and images",
        "color": "#2496ED",
        "fields": [
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "Docker Hub username"
            },
            {
                "key": "token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Docker Hub access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.docker.com/docker-hub/api/latest/"
    },
    "vercel": {
        "id": "vercel",
        "name": "Vercel",
        "description": "Vercel deployments and projects",
        "color": "#000000",
        "fields": [
            {
                "key": "token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Vercel access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://vercel.com/docs/rest-api"
    },
    "netlify": {
        "id": "netlify",
        "name": "Netlify",
        "description": "Netlify sites and deployments",
        "color": "#00C7B7",
        "fields": [
            {
                "key": "token",
                "label": "Personal Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Netlify access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.netlify.com/api/get-started/"
    },
    "railway": {
        "id": "railway",
        "name": "Railway",
        "description": "Railway deployments and services",
        "color": "#0B0D0E",
        "fields": [
            {
                "key": "token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Railway API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.railway.app/reference/public-api"
    },
    "render": {
        "id": "render",
        "name": "Render",
        "description": "Render services and deployments",
        "color": "#46E3B7",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "rnd_...",
                "prefix": "rnd_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://api-docs.render.com/"
    },
    "aws": {
        "id": "aws",
        "name": "AWS",
        "description": "Amazon Web Services",
        "color": "#FF9900",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA...",
                "prefix": "AKIA"
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true,
                "placeholder": "Secret access key"
            },
            {
                "key": "region",
                "label": "Default Region",
                "type": "text",
                "required": false,
                "placeholder": "us-east-1",
                "default": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://docs.aws.amazon.com/general/latest/gr/aws-apis.html"
    },
    "gcp": {
        "id": "gcp",
        "name": "Google Cloud",
        "description": "Google Cloud Platform",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true,
                "placeholder": "{\"type\": \"service_account\", ...}"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://cloud.google.com/docs/authentication"
    },
    "azure": {
        "id": "azure",
        "name": "Azure",
        "description": "Microsoft Azure cloud services",
        "color": "#0078D4",
        "fields": [
            {
                "key": "tenant_id",
                "label": "Tenant ID",
                "type": "text",
                "required": true,
                "placeholder": "Azure tenant ID"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Application client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Client secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://learn.microsoft.com/en-us/azure/developer/"
    },
    "digitalocean": {
        "id": "digitalocean",
        "name": "DigitalOcean",
        "description": "DigitalOcean cloud infrastructure",
        "color": "#0080FF",
        "fields": [
            {
                "key": "token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "dop_v1_...",
                "prefix": "dop_v1_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.digitalocean.com/reference/api/"
    },
    "cloudflare": {
        "id": "cloudflare",
        "name": "Cloudflare",
        "description": "Cloudflare DNS, CDN, and security",
        "color": "#F38020",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Cloudflare API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.cloudflare.com/api/"
    },
    "linode": {
        "id": "linode",
        "name": "Linode (Akamai)",
        "description": "Akamai cloud computing (formerly Linode)",
        "color": "#00A95C",
        "fields": [
            {
                "key": "api_token",
                "label": "Personal Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Linode API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://www.linode.com/docs/api/"
    },
    "vultr": {
        "id": "vultr",
        "name": "Vultr",
        "description": "High-performance cloud compute",
        "color": "#007BFC",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Vultr API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://www.vultr.com/api/"
    },
    "hetzner": {
        "id": "hetzner",
        "name": "Hetzner Cloud",
        "description": "European cloud infrastructure",
        "color": "#D50C2D",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Hetzner API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.hetzner.cloud/"
    },
    "ovh": {
        "id": "ovh",
        "name": "OVH Cloud",
        "description": "European cloud and hosting provider",
        "color": "#123F6D",
        "fields": [
            {
                "key": "application_key",
                "label": "Application Key",
                "type": "text",
                "required": true,
                "placeholder": "OVH application key"
            },
            {
                "key": "application_secret",
                "label": "Application Secret",
                "type": "password",
                "required": true,
                "placeholder": "OVH application secret"
            },
            {
                "key": "consumer_key",
                "label": "Consumer Key",
                "type": "password",
                "required": true,
                "placeholder": "OVH consumer key"
            },
            {
                "key": "endpoint",
                "label": "API Endpoint",
                "type": "text",
                "required": false,
                "placeholder": "ovh-eu, ovh-us, ovh-ca",
                "default": "ovh-eu"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://api.ovh.com/"
    },
    "oracle": {
        "id": "oracle",
        "name": "Oracle Cloud (OCI)",
        "description": "Oracle Cloud Infrastructure",
        "color": "#F80000",
        "fields": [
            {
                "key": "tenancy_ocid",
                "label": "Tenancy OCID",
                "type": "text",
                "required": true,
                "placeholder": "ocid1.tenancy.oc1..."
            },
            {
                "key": "user_ocid",
                "label": "User OCID",
                "type": "text",
                "required": true,
                "placeholder": "ocid1.user.oc1..."
            },
            {
                "key": "fingerprint",
                "label": "API Key Fingerprint",
                "type": "text",
                "required": true,
                "placeholder": "aa:bb:cc:..."
            },
            {
                "key": "private_key",
                "label": "Private Key (PEM)",
                "type": "textarea",
                "required": true,
                "placeholder": "-----BEGIN RSA PRIVATE KEY-----"
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "placeholder": "us-ashburn-1",
                "default": "us-ashburn-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://docs.oracle.com/en-us/iaas/api/"
    },
    "ibm": {
        "id": "ibm",
        "name": "IBM Cloud",
        "description": "IBM Cloud infrastructure and services",
        "color": "#054ADA",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "IBM Cloud API key"
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": false,
                "placeholder": "us-south",
                "default": "us-south"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://cloud.ibm.com/apidocs"
    },
    "alibaba": {
        "id": "alibaba",
        "name": "Alibaba Cloud",
        "description": "Alibaba Cloud (Aliyun) services",
        "color": "#FF6A00",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "LTAI..."
            },
            {
                "key": "access_key_secret",
                "label": "Access Key Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your access key secret"
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": false,
                "placeholder": "cn-hangzhou, us-west-1",
                "default": "cn-hangzhou"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://www.alibabacloud.com/help/"
    },
    "twitter": {
        "id": "twitter",
        "name": "Twitter/X",
        "description": "X (Twitter) API for governed posting and analytics. OAuth 1.0a user context.",
        "color": "#1DA1F2",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "From the X developer portal, Keys and tokens tab"
            },
            {
                "key": "api_secret",
                "label": "API Key Secret",
                "type": "password",
                "required": true,
                "placeholder": "From the X developer portal, Keys and tokens tab"
            },
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "From the X developer portal, Keys and tokens tab"
            },
            {
                "key": "access_secret",
                "label": "Access Token Secret",
                "type": "password",
                "required": true,
                "placeholder": "From the X developer portal, Keys and tokens tab"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "social",
        "docs": "https://developer.x.com/en/docs"
    },
    "linkedin": {
        "id": "linkedin",
        "name": "LinkedIn",
        "description": "LinkedIn API for profiles and posts",
        "color": "#0A66C2",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "LinkedIn OAuth access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://learn.microsoft.com/en-us/linkedin/"
    },
    "meta": {
        "id": "meta",
        "name": "Meta (Facebook/Instagram)",
        "description": "Meta Graph API for Facebook and Instagram",
        "color": "#1877F2",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Meta Graph API access token"
            },
            {
                "key": "page_id",
                "label": "Default Page ID",
                "type": "text",
                "required": false,
                "placeholder": "Optional: default Facebook Page ID"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.facebook.com/docs/graph-api/"
    },
    "tiktok": {
        "id": "tiktok",
        "name": "TikTok",
        "description": "TikTok API for content, publishing, and analytics",
        "color": "#000000",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "TikTok OAuth access token (lives 24 hours)"
            },
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": true,
                "placeholder": "TikTok OAuth refresh token (rotates every refresh; required, or the credential cannot outlive 24 hours)"
            },
            {
                "key": "client_key",
                "label": "Client Key",
                "type": "text",
                "required": true,
                "placeholder": "TikTok app client key"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "TikTok app client secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.tiktok.com/doc/overview/"
    },
    "youtube": {
        "id": "youtube",
        "name": "YouTube",
        "description": "YouTube Data API",
        "color": "#FF0000",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            },
            {
                "key": "access_token",
                "label": "OAuth Access Token",
                "type": "password",
                "required": false,
                "placeholder": "Optional OAuth token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.google.com/youtube/v3"
    },
    "pinterest": {
        "id": "pinterest",
        "name": "Pinterest",
        "description": "Pinterest API for pins and boards",
        "color": "#E60023",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Pinterest access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.pinterest.com/docs/api/v5/"
    },
    "snapchat": {
        "id": "snapchat",
        "name": "Snapchat Marketing",
        "description": "Snapchat Marketing API",
        "color": "#FFFC00",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your client secret"
            },
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": true,
                "placeholder": "OAuth refresh token"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://developers.snap.com/api/marketing-api/"
    },
    "reddit": {
        "id": "reddit",
        "name": "Reddit",
        "description": "Reddit API for posts and comments",
        "color": "#FF4500",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your client secret"
            },
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": true,
                "placeholder": "OAuth refresh token"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://www.reddit.com/dev/api/"
    },
    "tumblr": {
        "id": "tumblr",
        "name": "Tumblr",
        "description": "Tumblr API for posts and blogs",
        "color": "#36465D",
        "fields": [
            {
                "key": "consumer_key",
                "label": "Consumer Key",
                "type": "text",
                "required": true,
                "placeholder": "Your consumer key"
            },
            {
                "key": "consumer_secret",
                "label": "Consumer Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your consumer secret"
            },
            {
                "key": "token",
                "label": "Token",
                "type": "password",
                "required": true,
                "placeholder": "OAuth token"
            },
            {
                "key": "token_secret",
                "label": "Token Secret",
                "type": "password",
                "required": true,
                "placeholder": "OAuth token secret"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://www.tumblr.com/docs/en/api/v2"
    },
    "threads": {
        "id": "threads",
        "name": "Threads (Meta)",
        "description": "Threads API (Instagram/Meta)",
        "color": "#000000",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Threads access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.facebook.com/docs/threads"
    },
    "bluesky": {
        "id": "bluesky",
        "name": "Bluesky",
        "description": "Bluesky/AT Protocol",
        "color": "#0085FF",
        "fields": [
            {
                "key": "handle",
                "label": "Handle",
                "type": "text",
                "required": true,
                "placeholder": "yourname.bsky.social"
            },
            {
                "key": "app_password",
                "label": "App Password",
                "type": "password",
                "required": true,
                "placeholder": "App password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.bsky.app/"
    },
    "mastodon": {
        "id": "mastodon",
        "name": "Mastodon",
        "description": "Mastodon/Fediverse API",
        "color": "#6364FF",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your access token"
            },
            {
                "key": "instance_url",
                "label": "Instance URL",
                "type": "url",
                "required": true,
                "placeholder": "https://mastodon.social"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.joinmastodon.org/api/"
    },
    "docusign": {
        "id": "docusign",
        "name": "DocuSign",
        "description": "DocuSign e-signature and agreements",
        "color": "#FFCC22",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "DocuSign OAuth access token"
            },
            {
                "key": "account_id",
                "label": "Account ID",
                "type": "text",
                "required": true,
                "placeholder": "DocuSign account ID"
            },
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": false,
                "placeholder": "https://demo.docusign.net",
                "default": "https://demo.docusign.net"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.docusign.com/docs/"
    },
    "adobesign": {
        "id": "adobesign",
        "name": "Adobe Sign",
        "description": "Adobe Acrobat Sign e-signatures",
        "color": "#FA0F00",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Adobe Sign OAuth access token"
            },
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": false,
                "placeholder": "https://api.na1.adobesign.com",
                "default": "https://api.na1.adobesign.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://www.adobe.io/apis/documentcloud/sign.html"
    },
    "adobepdf": {
        "id": "adobepdf",
        "name": "Adobe PDF Services",
        "description": "Adobe PDF creation and manipulation",
        "color": "#FA0F00",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Adobe PDF Services client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Client secret"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://developer.adobe.com/document-services/apis/pdf-services/"
    },
    "dropboxsign": {
        "id": "dropboxsign",
        "name": "Dropbox Sign",
        "description": "Dropbox Sign (HelloSign) e-signatures",
        "color": "#0061FF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Dropbox Sign API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.hellosign.com/"
    },
    "pandadoc": {
        "id": "pandadoc",
        "name": "PandaDoc",
        "description": "PandaDoc document automation",
        "color": "#42B983",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "PandaDoc API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.pandadoc.com/"
    },
    "figma": {
        "id": "figma",
        "name": "Figma",
        "description": "Collaborative design platform",
        "color": "#F24E1E",
        "fields": [
            {
                "key": "personal_access_token",
                "label": "Personal Access Token",
                "type": "password",
                "required": true,
                "placeholder": "figd_...",
                "prefix": "figd_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://www.figma.com/developers/api"
    },
    "canva": {
        "id": "canva",
        "name": "Canva",
        "description": "Online design and publishing tool",
        "color": "#00C4CC",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Canva API key"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": false,
                "placeholder": "Only for the connector OAuth refresh flow"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": false,
                "placeholder": "Only for the connector OAuth refresh flow"
            },
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": false,
                "placeholder": "Only for the connector OAuth refresh flow"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://www.canva.dev/docs/connect/"
    },
    "adobecc": {
        "id": "adobecc",
        "name": "Adobe Creative Cloud",
        "description": "Adobe Creative Cloud APIs",
        "color": "#FF0000",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your Adobe client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your client secret"
            },
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "OAuth access token"
            },
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": false,
                "placeholder": "Only for the connector OAuth refresh flow"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.adobe.com/creative-cloud-libraries/docs/"
    },
    "shutterstock": {
        "id": "shutterstock",
        "name": "Shutterstock",
        "description": "Stock photos, images, and media",
        "color": "#EE2B24",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Shutterstock API key"
            },
            {
                "key": "api_secret",
                "label": "API Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your API secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.shutterstock.com/"
    },
    "gettyimages": {
        "id": "gettyimages",
        "name": "Getty Images",
        "description": "Premium stock photos and editorial images",
        "color": "#000000",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Getty Images API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.gettyimages.com/"
    },
    "unsplash": {
        "id": "unsplash",
        "name": "Unsplash",
        "description": "Free high-resolution photos",
        "color": "#000000",
        "fields": [
            {
                "key": "access_key",
                "label": "Access Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Unsplash access key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://unsplash.com/documentation"
    },
    "pexels": {
        "id": "pexels",
        "name": "Pexels",
        "description": "Free stock photos and videos",
        "color": "#05A081",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Pexels API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://www.pexels.com/api/documentation/"
    },
    "mailchimp": {
        "id": "mailchimp",
        "name": "Mailchimp",
        "description": "Email marketing and automation",
        "color": "#FFE01B",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "xxxxxxxxxxxxxxxx-usX"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://mailchimp.com/developer/marketing/api/"
    },
    "mailgun": {
        "id": "mailgun",
        "name": "Mailgun",
        "description": "Email API for developers",
        "color": "#F06B66",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "key-xxxxxxxxxxxxxxxx"
            },
            {
                "key": "domain",
                "label": "Domain",
                "type": "text",
                "required": false,
                "placeholder": "mg.yourdomain.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://documentation.mailgun.com/en/latest/api_reference.html"
    },
    "postmark": {
        "id": "postmark",
        "name": "Postmark",
        "description": "Fast transactional email",
        "color": "#FFDE00",
        "fields": [
            {
                "key": "server_token",
                "label": "Server Token",
                "type": "password",
                "required": true,
                "placeholder": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://postmarkapp.com/developer"
    },
    "ses": {
        "id": "ses",
        "name": "Amazon SES",
        "description": "AWS Simple Email Service",
        "color": "#FF9900",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "password",
                "required": true,
                "placeholder": "AKIA..."
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true,
                "placeholder": "Your secret key"
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "placeholder": "us-east-1",
                "default": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://docs.aws.amazon.com/ses/latest/APIReference/"
    },
    "vonage": {
        "id": "vonage",
        "name": "Vonage (Nexmo)",
        "description": "Communication APIs for SMS, voice, video",
        "color": "#7B00FF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "text",
                "required": true,
                "placeholder": "Your API key"
            },
            {
                "key": "api_secret",
                "label": "API Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your API secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.vonage.com/api"
    },
    "plivo": {
        "id": "plivo",
        "name": "Plivo",
        "description": "Cloud communications platform",
        "color": "#00B16A",
        "fields": [
            {
                "key": "auth_id",
                "label": "Auth ID",
                "type": "text",
                "required": true,
                "placeholder": "Your Auth ID"
            },
            {
                "key": "auth_token",
                "label": "Auth Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Auth Token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://www.plivo.com/docs/sms/api/"
    },
    "messagebird": {
        "id": "messagebird",
        "name": "MessageBird",
        "description": "Omnichannel messaging platform",
        "color": "#2481D7",
        "fields": [
            {
                "key": "access_key",
                "label": "Access Key",
                "type": "password",
                "required": true,
                "placeholder": "Your access key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.messagebird.com/api/"
    },
    "bandwidth": {
        "id": "bandwidth",
        "name": "Bandwidth",
        "description": "Enterprise communications APIs",
        "color": "#079CEE",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your API token"
            },
            {
                "key": "api_secret",
                "label": "API Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your API secret"
            },
            {
                "key": "account_id",
                "label": "Account ID",
                "type": "text",
                "required": true,
                "placeholder": "Your account ID"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://dev.bandwidth.com/docs/"
    },
    "discord": {
        "id": "discord",
        "name": "Discord Bot",
        "description": "Discord messaging and bot integration",
        "color": "#5865F2",
        "fields": [
            {
                "key": "bot_token",
                "label": "Bot Token",
                "type": "password",
                "required": true,
                "placeholder": "Your bot token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://discord.com/developers/docs/intro"
    },
    "msteams": {
        "id": "msteams",
        "name": "Microsoft Teams",
        "description": "Microsoft Teams integration",
        "color": "#6264A7",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Azure AD Application ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your client secret"
            },
            {
                "key": "tenant_id",
                "label": "Tenant ID",
                "type": "text",
                "required": true,
                "placeholder": "Azure AD Tenant ID"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://learn.microsoft.com/en-us/graph/teams-concept-overview"
    },
    "webex": {
        "id": "webex",
        "name": "Cisco Webex",
        "description": "Webex messaging and meetings",
        "color": "#00BCF2",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.webex.com/docs/api/getting-started"
    },
    "zoom": {
        "id": "zoom",
        "name": "Zoom",
        "description": "Zoom meetings and webinars",
        "color": "#2D8CFF",
        "fields": [
            {
                "key": "account_id",
                "label": "Account ID",
                "type": "text",
                "required": true,
                "placeholder": "Your account ID"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your client secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.zoom.us/docs/api/"
    },
    "onesignal": {
        "id": "onesignal",
        "name": "OneSignal",
        "description": "Push notifications and in-app messaging",
        "color": "#E54B4D",
        "fields": [
            {
                "key": "app_id",
                "label": "App ID",
                "type": "text",
                "required": true,
                "placeholder": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            },
            {
                "key": "rest_api_key",
                "label": "REST API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your REST API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://documentation.onesignal.com/reference"
    },
    "firebase": {
        "id": "firebase",
        "name": "Firebase Cloud Messaging",
        "description": "Google push notifications service",
        "color": "#FFCA28",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true,
                "placeholder": "{\"type\": \"service_account\", ...}"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://firebase.google.com/docs/cloud-messaging"
    },
    "pusher": {
        "id": "pusher",
        "name": "Pusher",
        "description": "Real-time messaging and notifications",
        "color": "#300D4F",
        "fields": [
            {
                "key": "app_id",
                "label": "App ID",
                "type": "text",
                "required": true,
                "placeholder": "Your app ID"
            },
            {
                "key": "key",
                "label": "Key",
                "type": "text",
                "required": true,
                "placeholder": "Your app key"
            },
            {
                "key": "secret",
                "label": "Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your app secret"
            },
            {
                "key": "cluster",
                "label": "Cluster",
                "type": "text",
                "required": true,
                "placeholder": "us2",
                "default": "us2"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://pusher.com/docs/channels/server_api/overview/"
    },
    "salesforce": {
        "id": "salesforce",
        "name": "Salesforce",
        "description": "Enterprise CRM platform",
        "color": "#00A1E0",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your connected app client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your client secret"
            },
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": true,
                "placeholder": "OAuth refresh token"
            },
            {
                "key": "instance_url",
                "label": "Instance URL",
                "type": "url",
                "required": true,
                "placeholder": "https://yourorg.salesforce.com"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/"
    },
    "hubspot": {
        "id": "hubspot",
        "name": "HubSpot",
        "description": "Marketing, sales, and CRM platform",
        "color": "#FF7A59",
        "fields": [
            {
                "key": "private_app_token",
                "label": "Private App Token",
                "type": "password",
                "required": true,
                "placeholder": "pat-...",
                "prefix": "pat-"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.hubspot.com/docs/api/overview"
    },
    "pipedrive": {
        "id": "pipedrive",
        "name": "Pipedrive",
        "description": "Sales CRM and pipeline management",
        "color": "#017737",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Pipedrive API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.pipedrive.com/docs/api/v1"
    },
    "zoho_crm": {
        "id": "zoho_crm",
        "name": "Zoho CRM",
        "description": "Cloud-based CRM for businesses",
        "color": "#C8202B",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your Zoho client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your client secret"
            },
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": true,
                "placeholder": "OAuth refresh token"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://www.zoho.com/crm/developer/docs/api/v5/"
    },
    "freshsales": {
        "id": "freshsales",
        "name": "Freshsales",
        "description": "Freshworks CRM for sales teams",
        "color": "#F36C3D",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Freshsales API key"
            },
            {
                "key": "domain",
                "label": "Domain",
                "type": "text",
                "required": true,
                "placeholder": "yourcompany"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.freshworks.com/crm/api/"
    },
    "copper": {
        "id": "copper",
        "name": "Copper",
        "description": "CRM for Google Workspace",
        "color": "#4A154B",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Copper API key"
            },
            {
                "key": "email",
                "label": "User Email",
                "type": "text",
                "required": true,
                "placeholder": "your@email.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.copper.com/"
    },
    "close": {
        "id": "close",
        "name": "Close",
        "description": "Sales CRM for startups and SMBs",
        "color": "#1463FF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Close API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.close.com/"
    },
    "monday": {
        "id": "monday",
        "name": "Monday.com",
        "description": "Work OS and CRM platform",
        "color": "#FF3D57",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your monday.com API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.monday.com/api-reference/docs"
    },
    "zendesk": {
        "id": "zendesk",
        "name": "Zendesk",
        "description": "Customer service and support platform",
        "color": "#03363D",
        "fields": [
            {
                "key": "subdomain",
                "label": "Subdomain",
                "type": "text",
                "required": true,
                "placeholder": "yourcompany"
            },
            {
                "key": "email",
                "label": "Email",
                "type": "text",
                "required": true,
                "placeholder": "admin@yourcompany.com"
            },
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Zendesk API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.zendesk.com/api-reference/"
    },
    "freshdesk": {
        "id": "freshdesk",
        "name": "Freshdesk",
        "description": "Helpdesk and ticketing system",
        "color": "#22C55E",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Freshdesk API key"
            },
            {
                "key": "domain",
                "label": "Domain",
                "type": "text",
                "required": true,
                "placeholder": "yourcompany"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.freshdesk.com/api/"
    },
    "helpscout": {
        "id": "helpscout",
        "name": "Help Scout",
        "description": "Customer service software",
        "color": "#1292EE",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Help Scout API key"
            },
            {
                "key": "client_id",
                "label": "App ID",
                "type": "text",
                "required": false,
                "placeholder": "Only for the connector OAuth client-credentials flow"
            },
            {
                "key": "client_secret",
                "label": "App Secret",
                "type": "password",
                "required": false,
                "placeholder": "Only for the connector OAuth client-credentials flow"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.helpscout.com/"
    },
    "front": {
        "id": "front",
        "name": "Front",
        "description": "Shared inbox and customer communication",
        "color": "#001B38",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Front API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://dev.frontapp.com/docs/getting-started"
    },
    "paypal": {
        "id": "paypal",
        "name": "PayPal",
        "description": "Online payments and checkout",
        "color": "#003087",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your PayPal client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your PayPal client secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.paypal.com/docs/api/overview/"
    },
    "square": {
        "id": "square",
        "name": "Square",
        "description": "Payment processing and POS",
        "color": "#006AFF",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Square access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.squareup.com/docs"
    },
    "braintree": {
        "id": "braintree",
        "name": "Braintree",
        "description": "Full-stack payment platform",
        "color": "#003366",
        "fields": [
            {
                "key": "merchant_id",
                "label": "Merchant ID",
                "type": "text",
                "required": true,
                "placeholder": "Your Braintree merchant ID"
            },
            {
                "key": "public_key",
                "label": "Public Key",
                "type": "text",
                "required": true,
                "placeholder": "Your public key"
            },
            {
                "key": "private_key",
                "label": "Private Key",
                "type": "password",
                "required": true,
                "placeholder": "Your private key"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://developer.paypal.com/braintree/docs"
    },
    "adyen": {
        "id": "adyen",
        "name": "Adyen",
        "description": "Global payment platform",
        "color": "#0ABF53",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Adyen API key"
            },
            {
                "key": "merchant_account",
                "label": "Merchant Account",
                "type": "text",
                "required": true,
                "placeholder": "Your merchant account name"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.adyen.com/api-explorer/"
    },
    "klarna": {
        "id": "klarna",
        "name": "Klarna",
        "description": "Buy now, pay later solutions",
        "color": "#FFB3C7",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key (Base64)",
                "type": "password",
                "required": true,
                "placeholder": "Base64 encoded username:password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.klarna.com/"
    },
    "shopify": {
        "id": "shopify",
        "name": "Shopify",
        "description": "E-commerce platform",
        "color": "#96BF48",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "shpat_...",
                "prefix": "shpat_"
            },
            {
                "key": "shop_domain",
                "label": "Shop Domain",
                "type": "text",
                "required": true,
                "placeholder": "your-store.myshopify.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://shopify.dev/docs/api"
    },
    "woocommerce": {
        "id": "woocommerce",
        "name": "WooCommerce",
        "description": "WordPress e-commerce plugin",
        "color": "#96588A",
        "fields": [
            {
                "key": "consumer_key",
                "label": "Consumer Key",
                "type": "text",
                "required": true,
                "placeholder": "ck_...",
                "prefix": "ck_"
            },
            {
                "key": "consumer_secret",
                "label": "Consumer Secret",
                "type": "password",
                "required": true,
                "placeholder": "cs_...",
                "prefix": "cs_"
            },
            {
                "key": "store_url",
                "label": "Store URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-store.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://woocommerce.github.io/woocommerce-rest-api-docs/"
    },
    "bigcommerce": {
        "id": "bigcommerce",
        "name": "BigCommerce",
        "description": "Enterprise e-commerce platform",
        "color": "#121118",
        "fields": [
            {
                "key": "store_hash",
                "label": "Store Hash",
                "type": "text",
                "required": true,
                "placeholder": "Your store hash"
            },
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.bigcommerce.com/docs/rest"
    },
    "magento": {
        "id": "magento",
        "name": "Adobe Commerce (Magento)",
        "description": "Enterprise e-commerce platform",
        "color": "#EE672F",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your integration access token"
            },
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-store.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.adobe.com/commerce/webapi/"
    },
    "wix": {
        "id": "wix",
        "name": "Wix",
        "description": "Website builder and e-commerce",
        "color": "#000000",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Wix API key"
            },
            {
                "key": "site_id",
                "label": "Site ID",
                "type": "text",
                "required": true,
                "placeholder": "Your Wix site ID"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://dev.wix.com/docs/rest"
    },
    "etsy": {
        "id": "etsy",
        "name": "Etsy",
        "description": "Handmade and vintage marketplace",
        "color": "#F45800",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key (Keystring)",
                "type": "text",
                "required": true,
                "placeholder": "Your Etsy API keystring"
            },
            {
                "key": "oauth_token",
                "label": "OAuth Token",
                "type": "password",
                "required": true,
                "placeholder": "Your OAuth access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.etsy.com/documentation/"
    },
    "amazon_sp": {
        "id": "amazon_sp",
        "name": "Amazon Selling Partner",
        "description": "Amazon marketplace API",
        "color": "#FF9900",
        "fields": [
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": true,
                "placeholder": "Your LWA refresh token"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your LWA client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your LWA client secret"
            },
            {
                "key": "aws_access_key",
                "label": "AWS Access Key",
                "type": "text",
                "required": true,
                "placeholder": "AKIA..."
            },
            {
                "key": "aws_secret_key",
                "label": "AWS Secret Key",
                "type": "password",
                "required": true,
                "placeholder": "Your AWS secret key"
            },
            {
                "key": "aws_role_arn",
                "label": "IAM Role ARN",
                "type": "text",
                "required": false,
                "placeholder": "arn:aws:iam::..."
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://developer-docs.amazon.com/sp-api/"
    },
    "snowflake": {
        "id": "snowflake",
        "name": "Snowflake",
        "description": "Cloud data warehouse",
        "color": "#29B5E8",
        "fields": [
            {
                "key": "account_identifier",
                "label": "Account Identifier",
                "type": "text",
                "required": true,
                "placeholder": "xy12345.us-east-1"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "Your username"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": false,
                "placeholder": "Your password"
            },
            {
                "key": "private_key",
                "label": "Private Key",
                "type": "textarea",
                "required": false,
                "placeholder": "-----BEGIN PRIVATE KEY-----"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://docs.snowflake.com/"
    },
    "databricks": {
        "id": "databricks",
        "name": "Databricks",
        "description": "Unified analytics platform",
        "color": "#FF3621",
        "fields": [
            {
                "key": "host",
                "label": "Workspace URL",
                "type": "url",
                "required": true,
                "placeholder": "https://dbc-12345678-abcd.cloud.databricks.com"
            },
            {
                "key": "token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "dapi...",
                "prefix": "dapi"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.databricks.com/"
    },
    "bigquery": {
        "id": "bigquery",
        "name": "Google BigQuery",
        "description": "Serverless data warehouse",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true,
                "placeholder": "{ \"type\": \"service_account\", ... }"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://cloud.google.com/bigquery/docs"
    },
    "mongodb": {
        "id": "mongodb",
        "name": "MongoDB Atlas",
        "description": "Document database as a service",
        "color": "#47A248",
        "fields": [
            {
                "key": "connection_string",
                "label": "Connection String",
                "type": "password",
                "required": true,
                "placeholder": "mongodb+srv://user:password@cluster.mongodb.net/database",
                "prefix": "mongodb+srv://"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://www.mongodb.com/docs/atlas/"
    },
    "postgresql": {
        "id": "postgresql",
        "name": "PostgreSQL",
        "description": "Open source relational database",
        "color": "#336791",
        "fields": [
            {
                "key": "host",
                "label": "Host",
                "type": "text",
                "required": true,
                "placeholder": "db.example.com"
            },
            {
                "key": "port",
                "label": "Port",
                "type": "number",
                "required": true,
                "placeholder": "5432",
                "default": "5432"
            },
            {
                "key": "database",
                "label": "Database",
                "type": "text",
                "required": true,
                "placeholder": "mydb"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "postgres"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true,
                "placeholder": "Your password"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://www.postgresql.org/docs/"
    },
    "redis": {
        "id": "redis",
        "name": "Redis",
        "description": "In-memory data store",
        "color": "#DC382D",
        "fields": [
            {
                "key": "host",
                "label": "Host",
                "type": "text",
                "required": true,
                "placeholder": "redis.example.com"
            },
            {
                "key": "port",
                "label": "Port",
                "type": "number",
                "required": true,
                "placeholder": "6379",
                "default": "6379"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": false,
                "placeholder": "Your password (optional)"
            },
            {
                "key": "tls",
                "label": "Use TLS",
                "type": "boolean",
                "required": false,
                "default": false
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://redis.io/docs/"
    },
    "elasticsearch": {
        "id": "elasticsearch",
        "name": "Elasticsearch",
        "description": "Distributed search and analytics",
        "color": "#FEC514",
        "fields": [
            {
                "key": "cloud_id",
                "label": "Cloud ID",
                "type": "text",
                "required": false,
                "placeholder": "my-deployment:dXMtY2VudHJhbDEuZ2Nw..."
            },
            {
                "key": "host",
                "label": "Host URL",
                "type": "url",
                "required": false,
                "placeholder": "https://localhost:9200"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": false,
                "placeholder": "Your API key"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": false,
                "placeholder": "elastic"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": false,
                "placeholder": "Your password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://www.elastic.co/guide/en/elasticsearch/reference/current/"
    },
    "tableau": {
        "id": "tableau",
        "name": "Tableau",
        "description": "Business intelligence and analytics",
        "color": "#E97627",
        "fields": [
            {
                "key": "server_url",
                "label": "Server URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-server.online.tableau.com"
            },
            {
                "key": "site_id",
                "label": "Site ID",
                "type": "text",
                "required": true,
                "placeholder": "your-site-id"
            },
            {
                "key": "token_name",
                "label": "Token Name",
                "type": "text",
                "required": true,
                "placeholder": "my-token"
            },
            {
                "key": "token_value",
                "label": "Token Value",
                "type": "password",
                "required": true,
                "placeholder": "Your token value"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://help.tableau.com/current/api/rest_api/en-us/"
    },
    "looker": {
        "id": "looker",
        "name": "Looker (Google)",
        "description": "Business intelligence platform",
        "color": "#4285F4",
        "fields": [
            {
                "key": "base_url",
                "label": "Instance URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-instance.looker.com"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your client secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://cloud.google.com/looker/docs/api-reference"
    },
    "okta": {
        "id": "okta",
        "name": "Okta",
        "description": "Identity and access management",
        "color": "#007DC1",
        "fields": [
            {
                "key": "domain",
                "label": "Okta Domain",
                "type": "text",
                "required": true,
                "placeholder": "dev-123456.okta.com"
            },
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Okta API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.okta.com/docs/reference/"
    },
    "auth0": {
        "id": "auth0",
        "name": "Auth0",
        "description": "Authentication and authorization platform",
        "color": "#EB5424",
        "fields": [
            {
                "key": "domain",
                "label": "Auth0 Domain",
                "type": "text",
                "required": true,
                "placeholder": "your-tenant.auth0.com"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your application Client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your application Client Secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://auth0.com/docs/api"
    },
    "onelogin": {
        "id": "onelogin",
        "name": "OneLogin",
        "description": "Identity and access management",
        "color": "#000000",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your API client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your API client secret"
            },
            {
                "key": "region",
                "label": "Region",
                "type": "select",
                "required": true,
                "options": [
                    {
                        "value": "us",
                        "label": "US"
                    },
                    {
                        "value": "eu",
                        "label": "EU"
                    }
                ]
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.onelogin.com/api-docs/2/getting-started/dev-overview"
    },
    "crowdstrike": {
        "id": "crowdstrike",
        "name": "CrowdStrike",
        "description": "Endpoint security and threat intelligence",
        "color": "#FC0000",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your API client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your API client secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://falcon.crowdstrike.com/documentation/"
    },
    "snyk": {
        "id": "snyk",
        "name": "Snyk",
        "description": "Security scanning and vulnerability management",
        "color": "#4C4A73",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Snyk API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.snyk.io/snyk-api"
    },
    "vault": {
        "id": "vault",
        "name": "HashiCorp Vault",
        "description": "Secrets management and data protection",
        "color": "#000000",
        "fields": [
            {
                "key": "address",
                "label": "Vault Address",
                "type": "url",
                "required": true,
                "placeholder": "https://vault.example.com:8200"
            },
            {
                "key": "token",
                "label": "Vault Token",
                "type": "password",
                "required": false,
                "placeholder": "hvs.xxx..."
            },
            {
                "key": "role_id",
                "label": "AppRole Role ID",
                "type": "text",
                "required": false,
                "placeholder": "Role ID for AppRole auth"
            },
            {
                "key": "secret_id",
                "label": "AppRole Secret ID",
                "type": "password",
                "required": false,
                "placeholder": "Secret ID for AppRole auth"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.hashicorp.com/vault/api-docs"
    },
    "1password": {
        "id": "1password",
        "name": "1Password Connect",
        "description": "Password and secrets management",
        "color": "#0094F5",
        "fields": [
            {
                "key": "connect_host",
                "label": "Connect Server Host",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:8080"
            },
            {
                "key": "connect_token",
                "label": "Connect Token",
                "type": "password",
                "required": true,
                "placeholder": "Your 1Password Connect token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.1password.com/docs/connect/"
    },
    "newrelic": {
        "id": "newrelic",
        "name": "New Relic",
        "description": "Full-stack observability platform",
        "color": "#008C99",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "NRAK-...",
                "prefix": "NRAK-"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.newrelic.com/docs/apis/intro-apis/new-relic-api-keys/"
    },
    "splunk": {
        "id": "splunk",
        "name": "Splunk",
        "description": "Log management and SIEM platform",
        "color": "#000000",
        "fields": [
            {
                "key": "base_url",
                "label": "Splunk URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-splunk-instance:8089"
            },
            {
                "key": "token",
                "label": "Auth Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Splunk auth token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.splunk.com/Documentation/Splunk/latest/RESTREF/RESTprolog"
    },
    "sentry": {
        "id": "sentry",
        "name": "Sentry",
        "description": "Error tracking and performance monitoring",
        "color": "#362D59",
        "fields": [
            {
                "key": "auth_token",
                "label": "Auth Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Sentry auth token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.sentry.io/api/"
    },
    "pagerduty": {
        "id": "pagerduty",
        "name": "PagerDuty",
        "description": "Incident management and alerting",
        "color": "#06AC38",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your PagerDuty API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.pagerduty.com/api-reference/"
    },
    "opsgenie": {
        "id": "opsgenie",
        "name": "OpsGenie",
        "description": "Alert and incident management",
        "color": "#172B4D",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your OpsGenie API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.opsgenie.com/docs/api-overview"
    },
    "prometheus": {
        "id": "prometheus",
        "name": "Prometheus",
        "description": "Metrics monitoring and alerting",
        "color": "#E6522C",
        "fields": [
            {
                "key": "base_url",
                "label": "Prometheus URL",
                "type": "url",
                "required": true,
                "placeholder": "http://prometheus:9090"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": false,
                "placeholder": "Optional basic auth username"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": false,
                "placeholder": "Optional basic auth password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://prometheus.io/docs/prometheus/latest/querying/api/"
    },
    "launchdarkly": {
        "id": "launchdarkly",
        "name": "LaunchDarkly",
        "description": "Feature flag management",
        "color": "#405BFF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your LaunchDarkly API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://apidocs.launchdarkly.com/"
    },
    "terraform": {
        "id": "terraform",
        "name": "Terraform Cloud",
        "description": "Infrastructure as code platform",
        "color": "#7B42BC",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Terraform Cloud API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.hashicorp.com/terraform/cloud-docs/api-docs"
    },
    "workday": {
        "id": "workday",
        "name": "Workday",
        "description": "Enterprise HR and finance platform",
        "color": "#0875E1",
        "fields": [
            {
                "key": "tenant",
                "label": "Tenant",
                "type": "text",
                "required": true,
                "placeholder": "Your Workday tenant name"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "OAuth client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "OAuth client secret"
            },
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": true,
                "placeholder": "OAuth refresh token"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://community.workday.com/sites/default/files/file-hosting/restapi/"
    },
    "bamboohr": {
        "id": "bamboohr",
        "name": "BambooHR",
        "description": "HR software for small and medium businesses",
        "color": "#73C41D",
        "fields": [
            {
                "key": "subdomain",
                "label": "Subdomain",
                "type": "text",
                "required": true,
                "placeholder": "yourcompany"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your BambooHR API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://documentation.bamboohr.com/reference"
    },
    "greenhouse": {
        "id": "greenhouse",
        "name": "Greenhouse",
        "description": "Applicant tracking and recruiting",
        "color": "#24A47F",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Greenhouse API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.greenhouse.io/harvest.html"
    },
    "lever": {
        "id": "lever",
        "name": "Lever",
        "description": "Recruiting software and ATS",
        "color": "#1F3037",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Lever API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://hire.lever.co/developer/documentation"
    },
    "adp": {
        "id": "adp",
        "name": "ADP",
        "description": "Payroll and HR management",
        "color": "#ED1C24",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your ADP client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your ADP client secret"
            },
            {
                "key": "cert",
                "label": "SSL Certificate",
                "type": "textarea",
                "required": true,
                "placeholder": "-----BEGIN CERTIFICATE-----"
            },
            {
                "key": "key",
                "label": "Private Key",
                "type": "textarea",
                "required": true,
                "placeholder": "-----BEGIN PRIVATE KEY-----"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "docs": "https://developers.adp.com/"
    },
    "gusto": {
        "id": "gusto",
        "name": "Gusto",
        "description": "Payroll, benefits, and HR",
        "color": "#F45D48",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Gusto access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://docs.gusto.com/app-integrations/reference"
    },
    "asana": {
        "id": "asana",
        "name": "Asana",
        "description": "Work management and team collaboration",
        "color": "#F06A6A",
        "fields": [
            {
                "key": "access_token",
                "label": "Personal Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Asana PAT"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developers.asana.com/docs"
    },
    "trello": {
        "id": "trello",
        "name": "Trello",
        "description": "Visual project boards and collaboration",
        "color": "#0052CC",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "text",
                "required": true,
                "placeholder": "Your Trello API key"
            },
            {
                "key": "token",
                "label": "Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Trello token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.atlassian.com/cloud/trello/"
    },
    "clickup": {
        "id": "clickup",
        "name": "ClickUp",
        "description": "All-in-one productivity platform",
        "color": "#7B68EE",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your ClickUp API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://clickup.com/api"
    },
    "confluence": {
        "id": "confluence",
        "name": "Confluence",
        "description": "Team wiki and documentation",
        "color": "#172B4D",
        "fields": [
            {
                "key": "domain",
                "label": "Domain",
                "type": "text",
                "required": true,
                "placeholder": "yourcompany.atlassian.net"
            },
            {
                "key": "email",
                "label": "Email",
                "type": "text",
                "required": true,
                "placeholder": "your@email.com"
            },
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Atlassian API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "docs": "https://developer.atlassian.com/cloud/confluence/rest/v1/"
    },
    "dropbox": {
        "id": "dropbox",
        "name": "Dropbox",
        "description": "Cloud file storage and sharing",
        "color": "#0061FF",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "sl....",
                "prefix": "sl."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "productivity",
        "docs": "https://www.dropbox.com/developers/documentation"
    },
    "box": {
        "id": "box",
        "name": "Box",
        "description": "Cloud content management and file sharing",
        "color": "#0061D5",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "productivity",
        "docs": "https://developer.box.com/reference/"
    },
    "googledrive": {
        "id": "googledrive",
        "name": "Google Drive",
        "description": "Cloud storage and collaboration",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": false,
                "placeholder": "{\"type\": \"service_account\", ...}"
            },
            {
                "key": "oauth_token",
                "label": "OAuth Token",
                "type": "password",
                "required": false,
                "placeholder": "Your OAuth access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "productivity",
        "docs": "https://developers.google.com/drive/api"
    },
    "calendly": {
        "id": "calendly",
        "name": "Calendly",
        "description": "Scheduling and appointment booking",
        "color": "#006BFF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "productivity",
        "docs": "https://developer.calendly.com/"
    },
    "typeform": {
        "id": "typeform",
        "name": "Typeform",
        "description": "Interactive forms and surveys",
        "color": "#262627",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "tfp_...",
                "prefix": "tfp_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "productivity",
        "docs": "https://developer.typeform.com/"
    },
    "jotform": {
        "id": "jotform",
        "name": "JotForm",
        "description": "Online form builder",
        "color": "#09F",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "productivity",
        "docs": "https://api.jotform.com/docs/"
    },
    "surveymonkey": {
        "id": "surveymonkey",
        "name": "SurveyMonkey",
        "description": "Survey creation and analytics",
        "color": "#00BF6F",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "productivity",
        "docs": "https://developer.surveymonkey.com/"
    },
    "mixpanel": {
        "id": "mixpanel",
        "name": "Mixpanel",
        "description": "Product analytics and user tracking",
        "color": "#7856FF",
        "fields": [
            {
                "key": "project_token",
                "label": "Project Token",
                "type": "password",
                "required": true,
                "placeholder": "Your project token"
            },
            {
                "key": "api_secret",
                "label": "API Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your API secret"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "analytics",
        "docs": "https://developer.mixpanel.com/"
    },
    "amplitude": {
        "id": "amplitude",
        "name": "Amplitude",
        "description": "Product analytics platform",
        "color": "#0061FF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            },
            {
                "key": "secret_key",
                "label": "Secret Key",
                "type": "password",
                "required": true,
                "placeholder": "Your secret key"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "analytics",
        "docs": "https://www.docs.developers.amplitude.com/"
    },
    "segment": {
        "id": "segment",
        "name": "Segment",
        "description": "Customer data platform",
        "color": "#52BD95",
        "fields": [
            {
                "key": "write_key",
                "label": "Write Key",
                "type": "password",
                "required": true,
                "placeholder": "Your write key"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "analytics",
        "docs": "https://segment.com/docs/"
    },
    "posthog": {
        "id": "posthog",
        "name": "PostHog",
        "description": "Open-source product analytics",
        "color": "#1D4AFF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "phc_...",
                "prefix": "phc_"
            },
            {
                "key": "host",
                "label": "Host",
                "type": "url",
                "required": false,
                "placeholder": "https://app.posthog.com",
                "default": "https://app.posthog.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "analytics",
        "docs": "https://posthog.com/docs/api"
    },
    "bitly": {
        "id": "bitly",
        "name": "Bitly",
        "description": "URL shortening and link management",
        "color": "#EE6123",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "utilities",
        "docs": "https://dev.bitly.com/"
    },
    "deepl": {
        "id": "deepl",
        "name": "DeepL",
        "description": "AI-powered translation",
        "color": "#042B48",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "utilities",
        "docs": "https://www.deepl.com/docs-api"
    },
    "algolia": {
        "id": "algolia",
        "name": "Algolia",
        "description": "Search and discovery platform",
        "color": "#003DFF",
        "fields": [
            {
                "key": "app_id",
                "label": "Application ID",
                "type": "text",
                "required": true,
                "placeholder": "Your Application ID"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "utilities",
        "docs": "https://www.algolia.com/doc/"
    },
    "supabase": {
        "id": "supabase",
        "name": "Supabase",
        "description": "Open-source Firebase alternative",
        "color": "#3ECF8E",
        "fields": [
            {
                "key": "project_url",
                "label": "Project URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-project.supabase.co"
            },
            {
                "key": "anon_key",
                "label": "Anon Key",
                "type": "password",
                "required": true,
                "placeholder": "Your anon/public key"
            },
            {
                "key": "service_role_key",
                "label": "Service Role Key",
                "type": "password",
                "required": false,
                "placeholder": "Your service role key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "utilities",
        "docs": "https://supabase.com/docs"
    },
    "pinecone": {
        "id": "pinecone",
        "name": "Pinecone",
        "description": "Vector database for AI applications",
        "color": "#000000",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "utilities",
        "docs": "https://docs.pinecone.io/"
    },
    "openweathermap": {
        "id": "openweathermap",
        "name": "OpenWeatherMap",
        "description": "Weather data and forecasts",
        "color": "#EB6E4B",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "utilities",
        "docs": "https://openweathermap.org/api"
    },
    "servicenow": {
        "id": "servicenow",
        "name": "ServiceNow",
        "description": "IT service management and ticketing platform",
        "color": "#81B5A1",
        "fields": [
            {
                "key": "instance_url",
                "label": "Instance URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-instance.service-now.com"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": false,
                "placeholder": "Your username"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": false,
                "placeholder": "Your password"
            },
            {
                "key": "oauth_token",
                "label": "OAuth Token",
                "type": "password",
                "required": false,
                "placeholder": "OAuth access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ticketing",
        "docs": "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest"
    },
    "freshservice": {
        "id": "freshservice",
        "name": "Freshservice",
        "description": "IT service desk and asset management",
        "color": "#2ECC40",
        "fields": [
            {
                "key": "domain",
                "label": "Domain",
                "type": "text",
                "required": true,
                "placeholder": "your-company"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ticketing",
        "docs": "https://api.freshservice.com/"
    },
    "zoho_desk": {
        "id": "zoho_desk",
        "name": "Zoho Desk",
        "description": "Customer service and helpdesk software",
        "color": "#C8202B",
        "fields": [
            {
                "key": "org_id",
                "label": "Organization ID",
                "type": "text",
                "required": true,
                "placeholder": "Your org ID"
            },
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "OAuth access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ticketing",
        "docs": "https://desk.zoho.com/DeskAPIDocument"
    },
    "kayako": {
        "id": "kayako",
        "name": "Kayako",
        "description": "Customer service and helpdesk platform (discontinued — acquired by Paddle 2023)",
        "color": "#F26522",
        "fields": [
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-company.kayako.com"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            },
            {
                "key": "secret_key",
                "label": "Secret Key",
                "type": "password",
                "required": true,
                "placeholder": "Your secret key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ticketing",
        "docs": "https://developer.kayako.com/"
    },
    "happyfox": {
        "id": "happyfox",
        "name": "HappyFox",
        "description": "Helpdesk and customer support ticketing",
        "color": "#FF6B00",
        "fields": [
            {
                "key": "domain",
                "label": "Domain",
                "type": "text",
                "required": true,
                "placeholder": "your-company"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            },
            {
                "key": "auth_code",
                "label": "Auth Code",
                "type": "password",
                "required": true,
                "placeholder": "Your auth code"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ticketing",
        "docs": "https://support.happyfox.com/kb/section/6/"
    },
    "spiceworks": {
        "id": "spiceworks",
        "name": "Spiceworks Cloud",
        "description": "Free IT helpdesk and network monitoring",
        "color": "#A1C900",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "ticketing",
        "docs": "https://community.spiceworks.com/support/help-desk-cloud-edition/"
    },
    "osticket": {
        "id": "osticket",
        "name": "osTicket",
        "description": "Open-source support ticket system",
        "color": "#97C93E",
        "fields": [
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://support.yourcompany.com"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ticketing",
        "docs": "https://docs.osticket.com/en/latest/Developer%20Documentation/API.html"
    },
    "zammad": {
        "id": "zammad",
        "name": "Zammad",
        "description": "Open-source helpdesk and ticketing system",
        "color": "#FFB300",
        "fields": [
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://zammad.yourcompany.com"
            },
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "Your access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ticketing",
        "docs": "https://docs.zammad.org/en/latest/api/intro.html"
    },
    "request_tracker": {
        "id": "request_tracker",
        "name": "Request Tracker (RT)",
        "description": "Enterprise-grade issue tracking system",
        "color": "#444444",
        "fields": [
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://rt.yourcompany.com"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "Your RT username"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true,
                "placeholder": "Your RT password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ticketing",
        "docs": "https://docs.bestpractical.com/rt/latest/RT/REST2.html"
    },
    "aws_kms": {
        "id": "aws_kms",
        "name": "AWS KMS",
        "description": "AWS Key Management Service for encryption keys",
        "color": "#FF9900",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA..."
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true,
                "placeholder": "Your secret key"
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "placeholder": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloudsecurity",
        "docs": "https://docs.aws.amazon.com/kms/latest/developerguide/"
    },
    "aws_secrets_manager": {
        "id": "aws_secrets_manager",
        "name": "AWS Secrets Manager",
        "description": "Secure secrets storage and rotation",
        "color": "#FF9900",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA..."
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true,
                "placeholder": "Your secret key"
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "placeholder": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloudsecurity",
        "docs": "https://docs.aws.amazon.com/secretsmanager/latest/userguide/"
    },
    "azure_keyvault": {
        "id": "azure_keyvault",
        "name": "Azure Key Vault",
        "description": "Azure secrets and key management",
        "color": "#0078D4",
        "fields": [
            {
                "key": "vault_url",
                "label": "Vault URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-vault.vault.azure.net/"
            },
            {
                "key": "tenant_id",
                "label": "Tenant ID",
                "type": "text",
                "required": true,
                "placeholder": "Your Azure tenant ID"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Application client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Application client secret"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloudsecurity",
        "docs": "https://docs.microsoft.com/en-us/azure/key-vault/"
    },
    "gcp_kms": {
        "id": "gcp_kms",
        "name": "GCP Cloud KMS",
        "description": "Google Cloud Key Management Service",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true,
                "placeholder": "{\"type\": \"service_account\", ...}"
            },
            {
                "key": "project_id",
                "label": "Project ID",
                "type": "text",
                "required": true,
                "placeholder": "your-project-id"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloudsecurity",
        "docs": "https://cloud.google.com/kms/docs"
    },
    "microsoft_sentinel": {
        "id": "microsoft_sentinel",
        "name": "Microsoft Sentinel",
        "description": "Cloud-native SIEM and SOAR",
        "color": "#0078D4",
        "fields": [
            {
                "key": "workspace_id",
                "label": "Workspace ID",
                "type": "text",
                "required": true,
                "placeholder": "Log Analytics workspace ID"
            },
            {
                "key": "tenant_id",
                "label": "Tenant ID",
                "type": "text",
                "required": true,
                "placeholder": "Azure tenant ID"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Application client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Application client secret"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloudsecurity",
        "docs": "https://docs.microsoft.com/en-us/azure/sentinel/"
    },
    "wiz": {
        "id": "wiz",
        "name": "Wiz",
        "description": "Cloud security posture management",
        "color": "#1A56DB",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Service account client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Service account secret"
            },
            {
                "key": "auth_url",
                "label": "Auth URL",
                "type": "url",
                "required": true,
                "placeholder": "https://auth.app.wiz.io/oauth/token"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloudsecurity",
        "docs": "https://docs.wiz.io/"
    },
    "orca": {
        "id": "orca",
        "name": "Orca Security",
        "description": "Cloud security platform",
        "color": "#00D4AA",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Orca API token"
            },
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": false,
                "placeholder": "https://api.orcasecurity.io"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "cloudsecurity",
        "docs": "https://docs.orcasecurity.io/"
    },
    "sentinelone": {
        "id": "sentinelone",
        "name": "SentinelOne",
        "description": "Endpoint detection and response",
        "color": "#6B21A8",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your API token"
            },
            {
                "key": "base_url",
                "label": "Console URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-console.sentinelone.net"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "cloudsecurity",
        "docs": "https://usea1-partners.sentinelone.net/api-doc/overview"
    },
    "cortex_xsoar": {
        "id": "cortex_xsoar",
        "name": "Cortex XSOAR",
        "description": "Palo Alto security orchestration",
        "color": "#F04E23",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            },
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-xsoar.paloaltonetworks.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "cloudsecurity",
        "docs": "https://xsoar.pan.dev/"
    },
    "prisma_cloud": {
        "id": "prisma_cloud",
        "name": "Prisma Cloud",
        "description": "Cloud native security platform",
        "color": "#F04E23",
        "fields": [
            {
                "key": "access_key",
                "label": "Access Key",
                "type": "text",
                "required": true,
                "placeholder": "Your access key ID"
            },
            {
                "key": "secret_key",
                "label": "Secret Key",
                "type": "password",
                "required": true,
                "placeholder": "Your secret key"
            },
            {
                "key": "api_url",
                "label": "API URL",
                "type": "url",
                "required": true,
                "placeholder": "https://api.prismacloud.io"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloudsecurity",
        "docs": "https://prisma.pan.dev/"
    },
    "google_chronicle": {
        "id": "google_chronicle",
        "name": "Google Chronicle",
        "description": "Google Cloud security analytics",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true,
                "placeholder": "{\"type\": \"service_account\", ...}"
            },
            {
                "key": "region",
                "label": "Region",
                "type": "select",
                "required": true,
                "options": [
                    "US",
                    "Europe",
                    "Asia"
                ]
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloudsecurity",
        "docs": "https://cloud.google.com/chronicle/docs"
    },
    "cloudflare_zero_trust": {
        "id": "cloudflare_zero_trust",
        "name": "Cloudflare Zero Trust",
        "description": "Zero trust network access",
        "color": "#F38020",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Cloudflare API token"
            },
            {
                "key": "account_id",
                "label": "Account ID",
                "type": "text",
                "required": true,
                "placeholder": "Your account ID"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "zerotrust",
        "docs": "https://developers.cloudflare.com/api/"
    },
    "zscaler": {
        "id": "zscaler",
        "name": "Zscaler",
        "description": "Cloud security platform",
        "color": "#049FD9",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            },
            {
                "key": "cloud",
                "label": "Cloud",
                "type": "text",
                "required": true,
                "placeholder": "zscaler.net"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "admin@company.com"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true,
                "placeholder": "Your password"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "zerotrust",
        "docs": "https://help.zscaler.com/zia/api"
    },
    "tailscale": {
        "id": "tailscale",
        "name": "Tailscale",
        "description": "Zero config VPN mesh network",
        "color": "#242424",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "tskey-api-..."
            },
            {
                "key": "tailnet",
                "label": "Tailnet",
                "type": "text",
                "required": true,
                "placeholder": "your-tailnet.ts.net"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "zerotrust",
        "docs": "https://tailscale.com/kb/1101/api/"
    },
    "teleport": {
        "id": "teleport",
        "name": "Teleport",
        "description": "Identity-aware infrastructure access",
        "color": "#512FC9",
        "fields": [
            {
                "key": "proxy_addr",
                "label": "Proxy Address",
                "type": "url",
                "required": true,
                "placeholder": "https://teleport.example.com"
            },
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your machine ID token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "zerotrust",
        "docs": "https://goteleport.com/docs/"
    },
    "kubernetes_api": {
        "id": "kubernetes_api",
        "name": "Kubernetes API",
        "description": "Direct Kubernetes cluster access",
        "color": "#326CE5",
        "fields": [
            {
                "key": "api_server",
                "label": "API Server URL",
                "type": "url",
                "required": true,
                "placeholder": "https://kubernetes.default.svc"
            },
            {
                "key": "token",
                "label": "Bearer Token",
                "type": "password",
                "required": true,
                "placeholder": "Service account token"
            },
            {
                "key": "ca_cert",
                "label": "CA Certificate",
                "type": "textarea",
                "required": false,
                "placeholder": "Base64 encoded CA cert (optional)"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "kubernetes",
        "docs": "https://kubernetes.io/docs/reference/kubernetes-api/"
    },
    "argocd": {
        "id": "argocd",
        "name": "ArgoCD",
        "description": "GitOps continuous delivery",
        "color": "#EF7B4D",
        "fields": [
            {
                "key": "server_url",
                "label": "Server URL",
                "type": "url",
                "required": true,
                "placeholder": "https://argocd.example.com"
            },
            {
                "key": "auth_token",
                "label": "Auth Token",
                "type": "password",
                "required": true,
                "placeholder": "ArgoCD API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "kubernetes",
        "docs": "https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/"
    },
    "backstage": {
        "id": "backstage",
        "name": "Backstage",
        "description": "Developer portal platform",
        "color": "#36BAA2",
        "fields": [
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://backstage.example.com"
            },
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": false,
                "placeholder": "Bearer token (if auth enabled)"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "kubernetes",
        "docs": "https://backstage.io/docs/"
    },
    "jfrog_artifactory": {
        "id": "jfrog_artifactory",
        "name": "JFrog Artifactory",
        "description": "Universal artifact repository",
        "color": "#40BE46",
        "fields": [
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-org.jfrog.io/artifactory"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key or access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "kubernetes",
        "docs": "https://jfrog.com/help/r/jfrog-rest-apis/"
    },
    "sonatype_nexus": {
        "id": "sonatype_nexus",
        "name": "Sonatype Nexus",
        "description": "Repository manager",
        "color": "#1B1C1D",
        "fields": [
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://nexus.example.com"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "admin"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true,
                "placeholder": "Your password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "kubernetes",
        "docs": "https://help.sonatype.com/repomanager3/integrations/rest-and-integration-api"
    },
    "airbyte": {
        "id": "airbyte",
        "name": "Airbyte",
        "description": "Data integration platform",
        "color": "#615EFF",
        "fields": [
            {
                "key": "base_url",
                "label": "API URL",
                "type": "url",
                "required": true,
                "placeholder": "https://api.airbyte.com"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "datamovement",
        "docs": "https://reference.airbyte.com/"
    },
    "fivetran": {
        "id": "fivetran",
        "name": "Fivetran",
        "description": "Automated data movement",
        "color": "#0073FF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "text",
                "required": true,
                "placeholder": "Your API key"
            },
            {
                "key": "api_secret",
                "label": "API Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your API secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "datamovement",
        "docs": "https://fivetran.com/docs/rest-api"
    },
    "dbt_cloud": {
        "id": "dbt_cloud",
        "name": "dbt Cloud",
        "description": "Data transformation platform",
        "color": "#FF694A",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your service token"
            },
            {
                "key": "account_id",
                "label": "Account ID",
                "type": "text",
                "required": true,
                "placeholder": "Your account ID"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "datamovement",
        "docs": "https://docs.getdbt.com/docs/dbt-cloud-apis/overview"
    },
    "confluent": {
        "id": "confluent",
        "name": "Confluent Cloud",
        "description": "Kafka as a service",
        "color": "#171A21",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "text",
                "required": true,
                "placeholder": "Cloud API key"
            },
            {
                "key": "api_secret",
                "label": "API Secret",
                "type": "password",
                "required": true,
                "placeholder": "Cloud API secret"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "datamovement",
        "docs": "https://docs.confluent.io/cloud/current/api.html"
    },
    "collibra": {
        "id": "collibra",
        "name": "Collibra",
        "description": "Data intelligence platform",
        "color": "#00875A",
        "fields": [
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-org.collibra.com"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "Your username"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true,
                "placeholder": "Your password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "datacatalog",
        "docs": "https://developer.collibra.com/"
    },
    "alation": {
        "id": "alation",
        "name": "Alation",
        "description": "Data catalog and governance",
        "color": "#0066CC",
        "fields": [
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-org.alationcatalog.com"
            },
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your API access token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "datacatalog",
        "docs": "https://developer.alation.com/"
    },
    "datahub": {
        "id": "datahub",
        "name": "DataHub",
        "description": "Open source data catalog",
        "color": "#4C8C4A",
        "fields": [
            {
                "key": "gms_url",
                "label": "GMS URL",
                "type": "url",
                "required": true,
                "placeholder": "https://datahub.example.com:8080"
            },
            {
                "key": "token",
                "label": "Access Token",
                "type": "password",
                "required": false,
                "placeholder": "Personal access token (if auth enabled)"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "datacatalog",
        "docs": "https://datahubproject.io/docs/"
    },
    "aws_textract": {
        "id": "aws_textract",
        "name": "AWS Textract",
        "description": "Document text and data extraction",
        "color": "#FF9900",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA..."
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true,
                "placeholder": "Your secret key"
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "placeholder": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "documentai",
        "docs": "https://docs.aws.amazon.com/textract/"
    },
    "azure_form_recognizer": {
        "id": "azure_form_recognizer",
        "name": "Azure Document Intelligence",
        "description": "Document intelligence service (formerly Form Recognizer)",
        "color": "#0078D4",
        "fields": [
            {
                "key": "endpoint",
                "label": "Endpoint",
                "type": "url",
                "required": true,
                "placeholder": "https://your-resource.cognitiveservices.azure.com/"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "documentai",
        "docs": "https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/"
    },
    "google_document_ai": {
        "id": "google_document_ai",
        "name": "Google Document AI",
        "description": "Document processing and extraction",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true,
                "placeholder": "{\"type\": \"service_account\", ...}"
            },
            {
                "key": "project_id",
                "label": "Project ID",
                "type": "text",
                "required": true,
                "placeholder": "your-project-id"
            },
            {
                "key": "location",
                "label": "Location",
                "type": "text",
                "required": true,
                "placeholder": "us or eu"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "documentai",
        "docs": "https://cloud.google.com/document-ai/docs"
    },
    "browserless": {
        "id": "browserless",
        "name": "Browserless",
        "description": "Headless browser as a service",
        "color": "#00D8FF",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your API token"
            },
            {
                "key": "base_url",
                "label": "Base URL",
                "type": "url",
                "required": false,
                "placeholder": "https://chrome.browserless.io (default)"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "browser",
        "docs": "https://www.browserless.io/docs/"
    },
    "apify": {
        "id": "apify",
        "name": "Apify",
        "description": "Web scraping and automation platform",
        "color": "#00AAFF",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "browser",
        "docs": "https://docs.apify.com/api/v2"
    },
    "browser_login": {
        "id": "browser_login",
        "name": "Website Login",
        "description": "Username and password for website login (used by Browser-Q automations)",
        "color": "#06b6d4",
        "fields": [
            {
                "key": "domain",
                "label": "Website / Domain",
                "type": "url",
                "required": true,
                "placeholder": "https://console.hetzner.cloud"
            },
            {
                "key": "username",
                "label": "Username or Email",
                "type": "text",
                "required": true,
                "placeholder": "user@example.com"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true
            },
            {
                "key": "login_url",
                "label": "Login Page URL (optional)",
                "type": "url",
                "required": false,
                "placeholder": "https://console.hetzner.cloud/login"
            },
            {
                "key": "notes",
                "label": "Notes",
                "type": "text",
                "required": false,
                "placeholder": "e.g. Has 2FA, use authenticator app"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "browser",
        "docs": null
    },
    "netsuite": {
        "id": "netsuite",
        "name": "NetSuite",
        "description": "Oracle ERP cloud suite",
        "color": "#0A0A0A",
        "fields": [
            {
                "key": "account_id",
                "label": "Account ID",
                "type": "text",
                "required": true,
                "placeholder": "Your NetSuite account ID"
            },
            {
                "key": "consumer_key",
                "label": "Consumer Key",
                "type": "text",
                "required": true,
                "placeholder": "OAuth consumer key"
            },
            {
                "key": "consumer_secret",
                "label": "Consumer Secret",
                "type": "password",
                "required": true,
                "placeholder": "OAuth consumer secret"
            },
            {
                "key": "token_id",
                "label": "Token ID",
                "type": "text",
                "required": true,
                "placeholder": "Token ID"
            },
            {
                "key": "token_secret",
                "label": "Token Secret",
                "type": "password",
                "required": true,
                "placeholder": "Token secret"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "finance",
        "docs": "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1529086055.html"
    },
    "dynamics_365": {
        "id": "dynamics_365",
        "name": "Microsoft Dynamics 365",
        "description": "Microsoft ERP and CRM",
        "color": "#002050",
        "fields": [
            {
                "key": "tenant_id",
                "label": "Tenant ID",
                "type": "text",
                "required": true,
                "placeholder": "Azure AD tenant ID"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Application client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Application client secret"
            },
            {
                "key": "environment_url",
                "label": "Environment URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-org.crm.dynamics.com"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "finance",
        "docs": "https://docs.microsoft.com/en-us/dynamics365/"
    },
    "quickbooks": {
        "id": "quickbooks",
        "name": "QuickBooks Online",
        "description": "Intuit accounting software",
        "color": "#2CA01C",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "OAuth client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "OAuth client secret"
            },
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": true,
                "placeholder": "OAuth refresh token"
            },
            {
                "key": "realm_id",
                "label": "Realm ID",
                "type": "text",
                "required": true,
                "placeholder": "Company ID"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "finance",
        "docs": "https://developer.intuit.com/app/developer/qbo/docs/get-started"
    },
    "xero": {
        "id": "xero",
        "name": "Xero",
        "description": "Cloud accounting platform",
        "color": "#13B5EA",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "OAuth client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "OAuth client secret"
            },
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": true,
                "placeholder": "OAuth refresh token"
            },
            {
                "key": "tenant_id",
                "label": "Tenant ID",
                "type": "text",
                "required": true,
                "placeholder": "Xero tenant ID"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "finance",
        "docs": "https://developer.xero.com/documentation/"
    },
    "ramp": {
        "id": "ramp",
        "name": "Ramp",
        "description": "Corporate card and spend management",
        "color": "#000000",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "OAuth client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "OAuth client secret"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "finance",
        "docs": "https://docs.ramp.com/"
    },
    "brex": {
        "id": "brex",
        "name": "Brex",
        "description": "Business financial services",
        "color": "#FF6633",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "finance",
        "docs": "https://developer.brex.com/"
    },
    "microsoft_purview": {
        "id": "microsoft_purview",
        "name": "Microsoft Purview",
        "description": "Data governance and compliance",
        "color": "#0078D4",
        "fields": [
            {
                "key": "tenant_id",
                "label": "Tenant ID",
                "type": "text",
                "required": true,
                "placeholder": "Azure AD tenant ID"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Application client ID"
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true,
                "placeholder": "Application client secret"
            },
            {
                "key": "purview_account",
                "label": "Purview Account",
                "type": "text",
                "required": true,
                "placeholder": "Your Purview account name"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "compliance",
        "docs": "https://docs.microsoft.com/en-us/azure/purview/"
    },
    "google_vault": {
        "id": "google_vault",
        "name": "Google Vault",
        "description": "eDiscovery and information governance",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true,
                "placeholder": "{\"type\": \"service_account\", ...}"
            },
            {
                "key": "delegated_user",
                "label": "Delegated User Email",
                "type": "email",
                "required": true,
                "placeholder": "admin@yourdomain.com"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "compliance",
        "docs": "https://developers.google.com/vault"
    },
    "weaviate": {
        "id": "weaviate",
        "name": "Weaviate",
        "description": "Vector search engine",
        "color": "#46B480",
        "fields": [
            {
                "key": "host",
                "label": "Host URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-cluster.weaviate.network"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": false,
                "placeholder": "Your API key (if auth enabled)"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "vectordb",
        "docs": "https://weaviate.io/developers/weaviate"
    },
    "qdrant": {
        "id": "qdrant",
        "name": "Qdrant",
        "description": "Vector similarity search",
        "color": "#DC382D",
        "fields": [
            {
                "key": "host",
                "label": "Host URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-cluster.qdrant.io"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": false,
                "placeholder": "Your API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "vectordb",
        "docs": "https://qdrant.tech/documentation/"
    },
    "milvus": {
        "id": "milvus",
        "name": "Milvus / Zilliz",
        "description": "Vector database for AI",
        "color": "#00A1EA",
        "fields": [
            {
                "key": "host",
                "label": "Host",
                "type": "text",
                "required": true,
                "placeholder": "your-cluster.zillizcloud.com"
            },
            {
                "key": "port",
                "label": "Port",
                "type": "text",
                "required": true,
                "placeholder": "19530"
            },
            {
                "key": "token",
                "label": "Token",
                "type": "password",
                "required": false,
                "placeholder": "API token (for Zilliz Cloud)"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "vectordb",
        "docs": "https://milvus.io/docs/"
    },
    "stripe": {
        "id": "stripe",
        "name": "Stripe",
        "description": "Payment processing and billing platform",
        "color": "#635BFF",
        "fields": [
            {
                "key": "api_key",
                "label": "Secret Key",
                "type": "password",
                "required": true,
                "placeholder": "sk_live_... or sk_test_...",
                "prefix": "sk_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ecommerce",
        "docs": "https://docs.stripe.com/api"
    },
    "plaid": {
        "id": "plaid",
        "name": "Plaid",
        "description": "Financial data and banking API",
        "color": "#00D64F",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true,
                "placeholder": "Your Plaid client ID"
            },
            {
                "key": "secret",
                "label": "Secret",
                "type": "password",
                "required": true,
                "placeholder": "Your Plaid secret"
            },
            {
                "key": "environment",
                "label": "Environment",
                "type": "select",
                "required": true,
                "default": "sandbox",
                "options": [
                    "sandbox",
                    "production"
                ]
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "ecommerce",
        "docs": "https://plaid.com/docs/"
    },
    "twilio": {
        "id": "twilio",
        "name": "Twilio",
        "description": "SMS, voice, and messaging APIs",
        "color": "#F22F46",
        "fields": [
            {
                "key": "account_sid",
                "label": "Account SID",
                "type": "text",
                "required": true,
                "placeholder": "AC...",
                "prefix": "AC"
            },
            {
                "key": "auth_token",
                "label": "Auth Token",
                "type": "password",
                "required": true,
                "placeholder": "Your auth token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "communication",
        "docs": "https://www.twilio.com/docs/usage/api"
    },
    "sendgrid": {
        "id": "sendgrid",
        "name": "SendGrid",
        "description": "Email delivery and marketing platform",
        "color": "#1A82E2",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "SG....",
                "prefix": "SG."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "communication",
        "docs": "https://docs.sendgrid.com/api-reference/"
    },
    "resend": {
        "id": "resend",
        "name": "Resend",
        "description": "Modern email API for developers",
        "color": "#000000",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "re_...",
                "prefix": "re_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "communication",
        "docs": "https://resend.com/docs/api-reference"
    },
    "jira": {
        "id": "jira",
        "name": "Jira",
        "description": "Atlassian project and issue tracking",
        "color": "#0052CC",
        "fields": [
            {
                "key": "email",
                "label": "Email",
                "type": "email",
                "required": true,
                "placeholder": "you@company.com"
            },
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Atlassian API token"
            },
            {
                "key": "domain",
                "label": "Domain",
                "type": "text",
                "required": true,
                "placeholder": "your-company.atlassian.net"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://developer.atlassian.com/cloud/jira/platform/rest/v3/"
    },
    "linear": {
        "id": "linear",
        "name": "Linear",
        "description": "Modern issue tracking and project management",
        "color": "#5E6AD2",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "lin_api_...",
                "prefix": "lin_api_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://developers.linear.app/docs"
    },
    "datadog": {
        "id": "datadog",
        "name": "Datadog",
        "description": "Cloud monitoring and analytics platform",
        "color": "#632CA6",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Datadog API key"
            },
            {
                "key": "app_key",
                "label": "Application Key",
                "type": "password",
                "required": true,
                "placeholder": "Your application key"
            },
            {
                "key": "site",
                "label": "Datadog Site",
                "type": "select",
                "required": true,
                "default": "datadoghq.com",
                "options": [
                    "datadoghq.com",
                    "datadoghq.eu",
                    "us3.datadoghq.com",
                    "us5.datadoghq.com"
                ]
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://docs.datadoghq.com/api/"
    },
    "grafana": {
        "id": "grafana",
        "name": "Grafana",
        "description": "Open-source monitoring and visualization",
        "color": "#F46800",
        "fields": [
            {
                "key": "api_key",
                "label": "Service Account Token",
                "type": "password",
                "required": true,
                "placeholder": "glsa_...",
                "prefix": "glsa_"
            },
            {
                "key": "base_url",
                "label": "Grafana URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-grafana.grafana.net"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://grafana.com/docs/grafana/latest/developers/http_api/"
    },
    "rabbitmq": {
        "id": "rabbitmq",
        "name": "RabbitMQ",
        "description": "Message broker management API (overview, queues, nodes, exchanges)",
        "color": "#FF6600",
        "fields": [
            {
                "key": "base_url",
                "label": "Management URL",
                "type": "url",
                "required": true,
                "placeholder": "http://rabbitmq-host:15672"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "guest"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true,
                "placeholder": "Your RabbitMQ password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://www.rabbitmq.com/docs/management#http-api"
    },
    "netdata": {
        "id": "netdata",
        "name": "Netdata",
        "description": "Real-time per-second infrastructure monitoring agent",
        "color": "#00AB44",
        "fields": [
            {
                "key": "base_url",
                "label": "Netdata Agent URL",
                "type": "url",
                "required": true,
                "placeholder": "http://netdata-host:19999"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://learn.netdata.cloud/docs/developer-and-contributor-corner/rest-api"
    },
    "opensearch": {
        "id": "opensearch",
        "name": "OpenSearch",
        "description": "Open-source search and analytics engine (Elasticsearch fork)",
        "color": "#005EB8",
        "fields": [
            {
                "key": "base_url",
                "label": "OpenSearch URL",
                "type": "url",
                "required": true,
                "placeholder": "https://opensearch-host:9200"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "admin"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true,
                "placeholder": "Your OpenSearch password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data_ai",
        "docs": "https://opensearch.org/docs/latest/api-reference/"
    },
    "alertmanager": {
        "id": "alertmanager",
        "name": "Prometheus Alertmanager",
        "description": "Prometheus Alertmanager: active alerts, silences and cluster status",
        "color": "#E6522C",
        "fields": [
            {
                "key": "base_url",
                "label": "Alertmanager URL",
                "type": "url",
                "required": true,
                "placeholder": "http://alertmanager-host:9093"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://github.com/prometheus/alertmanager/blob/main/api/v2/openapi.yaml"
    },
    "loki": {
        "id": "loki",
        "name": "Grafana Loki",
        "description": "Grafana Loki log aggregation: labels, series and LogQL queries",
        "color": "#F5A623",
        "fields": [
            {
                "key": "base_url",
                "label": "Loki URL",
                "type": "url",
                "required": true,
                "placeholder": "http://loki-host:3100"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://grafana.com/docs/loki/latest/reference/loki-http-api/"
    },
    "nats": {
        "id": "nats",
        "name": "NATS",
        "description": "NATS server monitoring: server info, connections, subscriptions and JetStream",
        "color": "#27AAE1",
        "fields": [
            {
                "key": "base_url",
                "label": "NATS Monitoring URL",
                "type": "url",
                "required": true,
                "placeholder": "http://nats-host:8222"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://docs.nats.io/running-a-nats-service/nats_admin/monitoring"
    },
    "traefik": {
        "id": "traefik",
        "name": "Traefik",
        "description": "Traefik reverse proxy: overview, routers, services and middlewares",
        "color": "#24A1C1",
        "fields": [
            {
                "key": "base_url",
                "label": "Traefik API URL",
                "type": "url",
                "required": true,
                "placeholder": "http://traefik-host:8080"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://doc.traefik.io/traefik/operations/api/"
    },
    "victoriametrics": {
        "id": "victoriametrics",
        "name": "VictoriaMetrics",
        "description": "VictoriaMetrics time-series database: PromQL queries, labels and TSDB status",
        "color": "#621773",
        "fields": [
            {
                "key": "base_url",
                "label": "VictoriaMetrics URL",
                "type": "url",
                "required": true,
                "placeholder": "http://victoriametrics-host:8428"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://docs.victoriametrics.com/url-examples/"
    },
    "google_sheets": {
        "id": "google_sheets",
        "name": "Google Sheets",
        "description": "Google Sheets spreadsheet API",
        "color": "#0F9D58",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true,
                "placeholder": "Paste service account JSON key"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "documents",
        "docs": "https://developers.google.com/sheets/api"
    },
    "google_calendar": {
        "id": "google_calendar",
        "name": "Google Calendar",
        "description": "Google Calendar scheduling API",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true,
                "placeholder": "Paste service account JSON key"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "documents",
        "docs": "https://developers.google.com/calendar/api"
    },
    "proxmox": {
        "id": "proxmox",
        "name": "Proxmox VE",
        "description": "Proxmox Virtual Environment hypervisor API",
        "color": "#E57000",
        "fields": [
            {
                "key": "base_url",
                "label": "Proxmox URL",
                "type": "url",
                "required": true,
                "placeholder": "https://hyp-01.example.com:8006"
            },
            {
                "key": "token_id",
                "label": "API Token ID",
                "type": "text",
                "required": true,
                "placeholder": "user@pam!tokenname"
            },
            {
                "key": "token_secret",
                "label": "Token Secret",
                "type": "password",
                "required": true,
                "placeholder": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "infra",
        "docs": "https://pve.proxmox.com/pve-docs/api-viewer/"
    },
    "fly_io": {
        "id": "fly_io",
        "name": "Fly.io",
        "description": "Global application platform",
        "color": "#7B36ED",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "FlyV1 ...",
                "prefix": "FlyV1 "
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "cloud",
        "docs": "https://fly.io/docs/machines/api/"
    },
    "upstash": {
        "id": "upstash",
        "name": "Upstash",
        "description": "Serverless Redis and Kafka",
        "color": "#00E9A3",
        "fields": [
            {
                "key": "email",
                "label": "Email",
                "type": "email",
                "required": true,
                "placeholder": "you@company.com"
            },
            {
                "key": "api_key",
                "label": "Management API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Upstash management API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://upstash.com/docs/devops/developer-api"
    },
    "chroma": {
        "id": "chroma",
        "name": "Chroma",
        "description": "Open-source AI-native embedding database",
        "color": "#FFD700",
        "fields": [
            {
                "key": "base_url",
                "label": "Chroma URL",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:8000",
                "default": "http://localhost:8000"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": false,
                "placeholder": "API key (if auth enabled)"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://docs.trychroma.com/"
    },
    "mysql": {
        "id": "mysql",
        "name": "MySQL",
        "description": "MySQL relational database",
        "color": "#4479A1",
        "fields": [
            {
                "key": "host",
                "label": "Host",
                "type": "text",
                "required": true,
                "placeholder": "localhost"
            },
            {
                "key": "port",
                "label": "Port",
                "type": "text",
                "required": true,
                "placeholder": "3306",
                "default": "3306"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true
            },
            {
                "key": "database",
                "label": "Database",
                "type": "text",
                "required": false
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "data",
        "docs": "https://dev.mysql.com/doc/"
    },
    "mariadb": {
        "id": "mariadb",
        "name": "MariaDB",
        "description": "MariaDB relational database",
        "color": "#003545",
        "fields": [
            {
                "key": "host",
                "label": "Host",
                "type": "text",
                "required": true,
                "placeholder": "localhost"
            },
            {
                "key": "port",
                "label": "Port",
                "type": "text",
                "required": true,
                "placeholder": "3306",
                "default": "3306"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true
            },
            {
                "key": "database",
                "label": "Database",
                "type": "text",
                "required": false
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "data",
        "docs": "https://mariadb.com/kb/en/documentation/"
    },
    "cockroachdb": {
        "id": "cockroachdb",
        "name": "CockroachDB",
        "description": "Distributed SQL database",
        "color": "#6933FF",
        "fields": [
            {
                "key": "connection_string",
                "label": "Connection String",
                "type": "password",
                "required": true,
                "placeholder": "postgresql://user:pass@host:26257/db?sslmode=verify-full"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "data",
        "docs": "https://www.cockroachlabs.com/docs/"
    },
    "planetscale": {
        "id": "planetscale",
        "name": "PlanetScale",
        "description": "Serverless MySQL platform",
        "color": "#000000",
        "fields": [
            {
                "key": "service_token_id",
                "label": "Service Token ID",
                "type": "text",
                "required": true,
                "placeholder": "Your service token ID"
            },
            {
                "key": "service_token",
                "label": "Service Token",
                "type": "password",
                "required": true,
                "placeholder": "pscale_tkn_..."
            },
            {
                "key": "organization",
                "label": "Organization",
                "type": "text",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://api-docs.planetscale.com/"
    },
    "neon": {
        "id": "neon",
        "name": "Neon",
        "description": "Serverless Postgres with branching",
        "color": "#00E699",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your Neon API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://api-docs.neon.tech/reference/"
    },
    "turso": {
        "id": "turso",
        "name": "Turso",
        "description": "Edge-hosted distributed SQLite (libSQL)",
        "color": "#4FF8D2",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your Turso platform API token"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://docs.turso.tech/api-reference/"
    },
    "fauna": {
        "id": "fauna",
        "name": "Fauna",
        "description": "Document-relational database",
        "color": "#3A1AB6",
        "fields": [
            {
                "key": "secret",
                "label": "Secret Key",
                "type": "password",
                "required": true,
                "placeholder": "fnAE..."
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "data",
        "docs": "https://docs.fauna.com/"
    },
    "couchdb": {
        "id": "couchdb",
        "name": "CouchDB",
        "description": "Apache CouchDB document database",
        "color": "#E42528",
        "fields": [
            {
                "key": "base_url",
                "label": "CouchDB URL",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:5984"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://docs.couchdb.org/"
    },
    "neo4j": {
        "id": "neo4j",
        "name": "Neo4j",
        "description": "Graph database platform",
        "color": "#008CC1",
        "fields": [
            {
                "key": "uri",
                "label": "Connection URI",
                "type": "text",
                "required": true,
                "placeholder": "neo4j+s://xxxxx.databases.neo4j.io"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "default": "neo4j"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "data",
        "docs": "https://neo4j.com/docs/"
    },
    "influxdb": {
        "id": "influxdb",
        "name": "InfluxDB",
        "description": "Time series database",
        "color": "#22ADF6",
        "fields": [
            {
                "key": "url",
                "label": "InfluxDB URL",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:8086"
            },
            {
                "key": "token",
                "label": "API Token",
                "type": "password",
                "required": true,
                "placeholder": "Your InfluxDB token"
            },
            {
                "key": "org",
                "label": "Organization",
                "type": "text",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://docs.influxdata.com/influxdb/"
    },
    "clickhouse": {
        "id": "clickhouse",
        "name": "ClickHouse",
        "description": "Column-oriented analytics database",
        "color": "#FFCC00",
        "fields": [
            {
                "key": "host",
                "label": "Host",
                "type": "text",
                "required": true,
                "placeholder": "your-instance.clickhouse.cloud"
            },
            {
                "key": "port",
                "label": "Port",
                "type": "text",
                "required": false,
                "default": "8443"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "default": "default"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "data",
        "docs": "https://clickhouse.com/docs/"
    },
    "timescaledb": {
        "id": "timescaledb",
        "name": "TimescaleDB",
        "description": "Time-series database on PostgreSQL",
        "color": "#FDB515",
        "fields": [
            {
                "key": "connection_string",
                "label": "Connection String",
                "type": "password",
                "required": true,
                "placeholder": "postgres://user:pass@host:port/db"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "data",
        "docs": "https://docs.timescale.com/"
    },
    "singlestore": {
        "id": "singlestore",
        "name": "SingleStore",
        "description": "Distributed SQL database for analytics and transactions",
        "color": "#AA00FF",
        "fields": [
            {
                "key": "api_key",
                "label": "Management API Key",
                "type": "password",
                "required": true,
                "placeholder": "Your management API key"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://docs.singlestore.com/"
    },
    "aws_s3": {
        "id": "aws_s3",
        "name": "AWS S3",
        "description": "Amazon Simple Storage Service",
        "color": "#569A31",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA...",
                "prefix": "AKIA"
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "default": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://docs.aws.amazon.com/s3/"
    },
    "aws_lambda": {
        "id": "aws_lambda",
        "name": "AWS Lambda",
        "description": "Serverless compute service",
        "color": "#FF9900",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA...",
                "prefix": "AKIA"
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "default": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://docs.aws.amazon.com/lambda/"
    },
    "aws_sqs": {
        "id": "aws_sqs",
        "name": "AWS SQS",
        "description": "Simple Queue Service",
        "color": "#FF9900",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA...",
                "prefix": "AKIA"
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "default": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://docs.aws.amazon.com/sqs/"
    },
    "aws_sns": {
        "id": "aws_sns",
        "name": "AWS SNS",
        "description": "Simple Notification Service",
        "color": "#FF9900",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA...",
                "prefix": "AKIA"
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "default": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://docs.aws.amazon.com/sns/"
    },
    "aws_dynamodb": {
        "id": "aws_dynamodb",
        "name": "AWS DynamoDB",
        "description": "NoSQL key-value and document database",
        "color": "#4053D6",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA...",
                "prefix": "AKIA"
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "default": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://docs.aws.amazon.com/dynamodb/"
    },
    "aws_cloudwatch": {
        "id": "aws_cloudwatch",
        "name": "AWS CloudWatch",
        "description": "Monitoring and observability service",
        "color": "#FF4F8B",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA...",
                "prefix": "AKIA"
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "default": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "devops",
        "docs": "https://docs.aws.amazon.com/cloudwatch/"
    },
    "aws_ecs": {
        "id": "aws_ecs",
        "name": "AWS ECS",
        "description": "Elastic Container Service",
        "color": "#FF9900",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA...",
                "prefix": "AKIA"
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "default": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://docs.aws.amazon.com/ecs/"
    },
    "aws_route53": {
        "id": "aws_route53",
        "name": "AWS Route 53",
        "description": "DNS and domain management",
        "color": "#8C4FFF",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA...",
                "prefix": "AKIA"
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://docs.aws.amazon.com/route53/"
    },
    "azure_devops": {
        "id": "azure_devops",
        "name": "Azure DevOps",
        "description": "Azure DevOps Services (repos, pipelines, boards)",
        "color": "#0078D7",
        "fields": [
            {
                "key": "organization",
                "label": "Organization",
                "type": "text",
                "required": true,
                "placeholder": "your-org"
            },
            {
                "key": "pat",
                "label": "Personal Access Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://learn.microsoft.com/en-us/rest/api/azure/devops/"
    },
    "azure_blob": {
        "id": "azure_blob",
        "name": "Azure Blob Storage",
        "description": "Azure object storage service",
        "color": "#0078D4",
        "fields": [
            {
                "key": "account_name",
                "label": "Storage Account Name",
                "type": "text",
                "required": true
            },
            {
                "key": "account_key",
                "label": "Account Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://learn.microsoft.com/en-us/azure/storage/blobs/"
    },
    "azure_functions": {
        "id": "azure_functions",
        "name": "Azure Functions",
        "description": "Serverless compute platform",
        "color": "#0078D4",
        "fields": [
            {
                "key": "subscription_id",
                "label": "Subscription ID",
                "type": "text",
                "required": true
            },
            {
                "key": "tenant_id",
                "label": "Tenant ID",
                "type": "text",
                "required": true
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://learn.microsoft.com/en-us/azure/azure-functions/"
    },
    "azure_cosmos_db": {
        "id": "azure_cosmos_db",
        "name": "Azure Cosmos DB",
        "description": "Globally distributed multi-model database",
        "color": "#0078D4",
        "fields": [
            {
                "key": "endpoint",
                "label": "Account Endpoint",
                "type": "url",
                "required": true,
                "placeholder": "https://your-account.documents.azure.com:443/"
            },
            {
                "key": "primary_key",
                "label": "Primary Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "data",
        "docs": "https://learn.microsoft.com/en-us/azure/cosmos-db/"
    },
    "gcp_cloud_run": {
        "id": "gcp_cloud_run",
        "name": "Google Cloud Run",
        "description": "Serverless container platform",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://cloud.google.com/run/docs"
    },
    "gcp_pubsub": {
        "id": "gcp_pubsub",
        "name": "Google Pub/Sub",
        "description": "Messaging and event streaming",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://cloud.google.com/pubsub/docs"
    },
    "gcp_cloud_functions": {
        "id": "gcp_cloud_functions",
        "name": "Google Cloud Functions",
        "description": "Serverless functions platform",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://cloud.google.com/functions/docs"
    },
    "gcp_storage": {
        "id": "gcp_storage",
        "name": "Google Cloud Storage",
        "description": "Object storage service",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://cloud.google.com/storage/docs"
    },
    "vertex_ai": {
        "id": "vertex_ai",
        "name": "Google Vertex AI",
        "description": "Google Cloud ML platform",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true
            },
            {
                "key": "project_id",
                "label": "Project ID",
                "type": "text",
                "required": true
            },
            {
                "key": "location",
                "label": "Location",
                "type": "text",
                "required": true,
                "default": "us-central1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "ai",
        "docs": "https://cloud.google.com/vertex-ai/docs"
    },
    "sonarqube": {
        "id": "sonarqube",
        "name": "SonarQube",
        "description": "Code quality and security analysis",
        "color": "#4E9BCD",
        "fields": [
            {
                "key": "base_url",
                "label": "SonarQube URL",
                "type": "url",
                "required": true,
                "placeholder": "https://sonarqube.example.com"
            },
            {
                "key": "token",
                "label": "User Token",
                "type": "password",
                "required": true,
                "placeholder": "squ_...",
                "prefix": "squ_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://docs.sonarsource.com/sonarqube/"
    },
    "sonarcloud": {
        "id": "sonarcloud",
        "name": "SonarCloud",
        "description": "Cloud-based code quality analysis",
        "color": "#F3702A",
        "fields": [
            {
                "key": "token",
                "label": "Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://docs.sonarsource.com/sonarcloud/"
    },
    "codecov": {
        "id": "codecov",
        "name": "Codecov",
        "description": "Code coverage reporting",
        "color": "#F01F7A",
        "fields": [
            {
                "key": "token",
                "label": "Global Upload Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "developer",
        "docs": "https://docs.codecov.com/"
    },
    "buildkite": {
        "id": "buildkite",
        "name": "Buildkite",
        "description": "CI/CD platform for scalable pipelines",
        "color": "#14CC80",
        "fields": [
            {
                "key": "api_token",
                "label": "API Access Token",
                "type": "password",
                "required": true,
                "placeholder": "bkua_...",
                "prefix": "bkua_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://buildkite.com/docs/apis/rest-api"
    },
    "teamcity": {
        "id": "teamcity",
        "name": "TeamCity",
        "description": "JetBrains CI/CD server",
        "color": "#000000",
        "fields": [
            {
                "key": "base_url",
                "label": "TeamCity URL",
                "type": "url",
                "required": true,
                "placeholder": "https://teamcity.example.com"
            },
            {
                "key": "token",
                "label": "Access Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://www.jetbrains.com/help/teamcity/rest-api.html"
    },
    "pulumi": {
        "id": "pulumi",
        "name": "Pulumi",
        "description": "Infrastructure as Code platform",
        "color": "#8A3391",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "pul-...",
                "prefix": "pul-"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://www.pulumi.com/docs/pulumi-cloud/reference/cloud-rest-api/"
    },
    "docker_hub": {
        "id": "docker_hub",
        "name": "Docker Hub",
        "description": "Container image registry",
        "color": "#2496ED",
        "fields": [
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true
            },
            {
                "key": "access_token",
                "label": "Personal Access Token",
                "type": "password",
                "required": true,
                "placeholder": "dckr_pat_...",
                "prefix": "dckr_pat_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://docs.docker.com/docker-hub/api/"
    },
    "harbor": {
        "id": "harbor",
        "name": "Harbor",
        "description": "Open source container image registry",
        "color": "#60B932",
        "fields": [
            {
                "key": "base_url",
                "label": "Harbor URL",
                "type": "url",
                "required": true,
                "placeholder": "https://harbor.example.com"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://goharbor.io/docs/"
    },
    "postman": {
        "id": "postman",
        "name": "Postman",
        "description": "API development and testing platform",
        "color": "#FF6C37",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "PMAK-...",
                "prefix": "PMAK-"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://www.postman.com/postman/postman-public-workspace/documentation/12946884/postman-api"
    },
    "kong": {
        "id": "kong",
        "name": "Kong",
        "description": "API gateway and service mesh",
        "color": "#003459",
        "fields": [
            {
                "key": "admin_url",
                "label": "Admin API URL",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:8001"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": false,
                "placeholder": "Admin API key (if secured)"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://docs.konghq.com/"
    },
    "ringcentral": {
        "id": "ringcentral",
        "name": "RingCentral",
        "description": "Cloud communications and phone system",
        "color": "#F80",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true
            },
            {
                "key": "jwt_token",
                "label": "JWT Credential",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "communication",
        "docs": "https://developers.ringcentral.com/api-reference"
    },
    "dialpad": {
        "id": "dialpad",
        "name": "Dialpad",
        "description": "AI-powered communications platform",
        "color": "#7C52FF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "communication",
        "docs": "https://developers.dialpad.com/"
    },
    "telnyx": {
        "id": "telnyx",
        "name": "Telnyx",
        "description": "Telephony and messaging API",
        "color": "#00C08B",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "KEY...",
                "prefix": "KEY"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "communication",
        "docs": "https://developers.telnyx.com/"
    },
    "mailjet": {
        "id": "mailjet",
        "name": "Mailjet",
        "description": "Email delivery and marketing",
        "color": "#FFC844",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "text",
                "required": true
            },
            {
                "key": "secret_key",
                "label": "Secret Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "communication",
        "docs": "https://dev.mailjet.com/"
    },
    "pushover": {
        "id": "pushover",
        "name": "Pushover",
        "description": "Push notifications for mobile and desktop",
        "color": "#249DF1",
        "fields": [
            {
                "key": "api_token",
                "label": "Application Token",
                "type": "password",
                "required": true
            },
            {
                "key": "user_key",
                "label": "User Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "notification",
        "docs": "https://pushover.net/api#verification"
    },
    "outreach": {
        "id": "outreach",
        "name": "Outreach",
        "description": "Sales engagement platform",
        "color": "#5951FF",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://api.outreach.io/api/v2/docs"
    },
    "apollo": {
        "id": "apollo",
        "name": "Apollo.io",
        "description": "Sales intelligence and engagement",
        "color": "#6B57FF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://apolloio.github.io/apollo-api-docs/"
    },
    "clearbit": {
        "id": "clearbit",
        "name": "Clearbit",
        "description": "Business intelligence and data enrichment",
        "color": "#3E5BF5",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "sk_...",
                "prefix": "sk_"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "crm",
        "docs": "https://dashboard.clearbit.com/docs"
    },
    "gong": {
        "id": "gong",
        "name": "Gong",
        "description": "Revenue intelligence and conversation analytics",
        "color": "#7C3AED",
        "fields": [
            {
                "key": "access_key",
                "label": "Access Key",
                "type": "text",
                "required": true
            },
            {
                "key": "access_key_secret",
                "label": "Access Key Secret",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://gong.app.gong.io/settings/api/documentation"
    },
    "salesloft": {
        "id": "salesloft",
        "name": "Salesloft",
        "description": "Sales engagement and workflow platform",
        "color": "#00B4D8",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://developers.salesloft.com/api.html"
    },
    "zendesk_sell": {
        "id": "zendesk_sell",
        "name": "Zendesk Sell",
        "description": "Sales CRM and pipeline management",
        "color": "#03363D",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://developer.zendesk.com/api-reference/sales-crm/introduction/"
    },
    "rippling": {
        "id": "rippling",
        "name": "Rippling",
        "description": "HR, IT, and finance platform",
        "color": "#FED501",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://developer.rippling.com/"
    },
    "deel": {
        "id": "deel",
        "name": "Deel",
        "description": "Global payroll and compliance",
        "color": "#15357A",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://developer.deel.com/"
    },
    "personio": {
        "id": "personio",
        "name": "Personio",
        "description": "HR management and recruiting",
        "color": "#00B8A9",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "custom",
        "docs": "https://developer.personio.de/reference"
    },
    "hibob": {
        "id": "hibob",
        "name": "HiBob",
        "description": "HR platform for modern businesses",
        "color": "#FFD100",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            },
            {
                "key": "service_user_id",
                "label": "Service User ID",
                "type": "text",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://apidocs.hibob.com/"
    },
    "activecampaign": {
        "id": "activecampaign",
        "name": "ActiveCampaign",
        "description": "Email marketing and CRM automation",
        "color": "#356AE6",
        "fields": [
            {
                "key": "base_url",
                "label": "Account URL",
                "type": "url",
                "required": true,
                "placeholder": "https://youraccountname.api-us1.com"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://developers.activecampaign.com/reference/"
    },
    "klaviyo": {
        "id": "klaviyo",
        "name": "Klaviyo",
        "description": "Email and SMS marketing automation",
        "color": "#000000",
        "fields": [
            {
                "key": "api_key",
                "label": "Private API Key",
                "type": "password",
                "required": true,
                "placeholder": "pk_...",
                "prefix": "pk_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://developers.klaviyo.com/en/reference/"
    },
    "braze": {
        "id": "braze",
        "name": "Braze",
        "description": "Customer engagement platform",
        "color": "#000000",
        "fields": [
            {
                "key": "api_key",
                "label": "REST API Key",
                "type": "password",
                "required": true
            },
            {
                "key": "rest_endpoint",
                "label": "REST Endpoint",
                "type": "url",
                "required": true,
                "placeholder": "https://rest.iad-01.braze.com"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://www.braze.com/docs/api/"
    },
    "convertkit": {
        "id": "convertkit",
        "name": "Kit (ConvertKit)",
        "description": "Creator-focused email marketing",
        "color": "#FB6970",
        "fields": [
            {
                "key": "api_secret",
                "label": "API Secret",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://developers.kit.com/v4"
    },
    "beehiiv": {
        "id": "beehiiv",
        "name": "beehiiv",
        "description": "Newsletter platform for creators",
        "color": "#FFD73C",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://developers.beehiiv.com/"
    },
    "customer_io": {
        "id": "customer_io",
        "name": "Customer.io",
        "description": "Automated messaging and customer data",
        "color": "#FFD200",
        "fields": [
            {
                "key": "api_key",
                "label": "App API Key",
                "type": "password",
                "required": true
            },
            {
                "key": "site_id",
                "label": "Site ID",
                "type": "text",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://customer.io/docs/api/"
    },
    "google_ads": {
        "id": "google_ads",
        "name": "Google Ads",
        "description": "Google advertising platform",
        "color": "#4285F4",
        "fields": [
            {
                "key": "developer_token",
                "label": "Developer Token",
                "type": "password",
                "required": true
            },
            {
                "key": "client_id",
                "label": "OAuth Client ID",
                "type": "text",
                "required": true
            },
            {
                "key": "client_secret",
                "label": "OAuth Client Secret",
                "type": "password",
                "required": true
            },
            {
                "key": "refresh_token",
                "label": "Refresh Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "social",
        "docs": "https://developers.google.com/google-ads/api/docs/start"
    },
    "facebook_ads": {
        "id": "facebook_ads",
        "name": "Meta Ads",
        "description": "Facebook and Instagram advertising",
        "color": "#1877F2",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true
            },
            {
                "key": "ad_account_id",
                "label": "Ad Account ID",
                "type": "text",
                "required": true,
                "placeholder": "act_123456789"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "social",
        "docs": "https://developers.facebook.com/docs/marketing-apis"
    },
    "google_analytics": {
        "id": "google_analytics",
        "name": "Google Analytics",
        "description": "Google Analytics 4 (GA4) reporting",
        "color": "#E37400",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true
            },
            {
                "key": "property_id",
                "label": "GA4 Property ID",
                "type": "text",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "data",
        "docs": "https://developers.google.com/analytics/devguides/reporting/data/v1"
    },
    "hotjar": {
        "id": "hotjar",
        "name": "Hotjar",
        "description": "Heatmaps, recordings, and feedback",
        "color": "#FD3A5C",
        "fields": [
            {
                "key": "api_key",
                "label": "Personal API Key",
                "type": "password",
                "required": true
            },
            {
                "key": "site_id",
                "label": "Site ID",
                "type": "text",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://developer.hotjar.com/"
    },
    "heap": {
        "id": "heap",
        "name": "Heap",
        "description": "Digital analytics and session replay",
        "color": "#FF6F61",
        "fields": [
            {
                "key": "app_id",
                "label": "App ID",
                "type": "text",
                "required": true
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "data",
        "docs": "https://developers.heap.io/"
    },
    "logrocket": {
        "id": "logrocket",
        "name": "LogRocket",
        "description": "Session replay and error tracking",
        "color": "#764ABC",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            },
            {
                "key": "org_slug",
                "label": "Organization Slug",
                "type": "text",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "data",
        "docs": "https://docs.logrocket.com/"
    },
    "plausible": {
        "id": "plausible",
        "name": "Plausible",
        "description": "Privacy-friendly web analytics",
        "color": "#5850EC",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            },
            {
                "key": "base_url",
                "label": "Instance URL",
                "type": "url",
                "required": false,
                "placeholder": "https://plausible.io",
                "default": "https://plausible.io"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://plausible.io/docs/stats-api"
    },
    "squarespace": {
        "id": "squarespace",
        "name": "Squarespace",
        "description": "Website builder and e-commerce platform",
        "color": "#000000",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ecommerce",
        "docs": "https://developers.squarespace.com/"
    },
    "lemon_squeezy": {
        "id": "lemon_squeezy",
        "name": "Lemon Squeezy",
        "description": "Payments, tax, and subscriptions for SaaS",
        "color": "#FFC233",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ecommerce",
        "docs": "https://docs.lemonsqueezy.com/api"
    },
    "paddle": {
        "id": "paddle",
        "name": "Paddle",
        "description": "Payments and billing for SaaS",
        "color": "#003049",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            },
            {
                "key": "environment",
                "label": "Environment",
                "type": "select",
                "required": true,
                "default": "sandbox",
                "options": [
                    "sandbox",
                    "production"
                ]
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ecommerce",
        "docs": "https://developer.paddle.com/api-reference/"
    },
    "chargebee": {
        "id": "chargebee",
        "name": "Chargebee",
        "description": "Subscription billing and revenue management",
        "color": "#FF6633",
        "fields": [
            {
                "key": "site",
                "label": "Site Name",
                "type": "text",
                "required": true,
                "placeholder": "your-site"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ecommerce",
        "docs": "https://apidocs.chargebee.com/docs/api/"
    },
    "recurly": {
        "id": "recurly",
        "name": "Recurly",
        "description": "Subscription management and billing",
        "color": "#F26B33",
        "fields": [
            {
                "key": "api_key",
                "label": "Private API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ecommerce",
        "docs": "https://developers.recurly.com/"
    },
    "gumroad": {
        "id": "gumroad",
        "name": "Gumroad",
        "description": "Digital product sales platform",
        "color": "#FF90E8",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ecommerce",
        "docs": "https://app.gumroad.com/api"
    },
    "hashicorp_consul": {
        "id": "hashicorp_consul",
        "name": "HashiCorp Consul",
        "description": "Service mesh and service discovery",
        "color": "#DC477D",
        "fields": [
            {
                "key": "base_url",
                "label": "Consul URL",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:8500"
            },
            {
                "key": "token",
                "label": "ACL Token",
                "type": "password",
                "required": false
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "security",
        "docs": "https://developer.hashicorp.com/consul/api-docs"
    },
    "hashicorp_nomad": {
        "id": "hashicorp_nomad",
        "name": "HashiCorp Nomad",
        "description": "Workload orchestrator",
        "color": "#00CA8E",
        "fields": [
            {
                "key": "base_url",
                "label": "Nomad URL",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:4646"
            },
            {
                "key": "token",
                "label": "ACL Token",
                "type": "password",
                "required": false
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "infra",
        "docs": "https://developer.hashicorp.com/nomad/api-docs"
    },
    "bitwarden": {
        "id": "bitwarden",
        "name": "Bitwarden",
        "description": "Password manager and secrets management",
        "color": "#175DDC",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true
            },
            {
                "key": "base_url",
                "label": "Server URL",
                "type": "url",
                "required": false,
                "default": "https://vault.bitwarden.com"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "security",
        "docs": "https://bitwarden.com/help/public-api/"
    },
    "cloudinary": {
        "id": "cloudinary",
        "name": "Cloudinary",
        "description": "Image and video management platform",
        "color": "#3448C5",
        "fields": [
            {
                "key": "cloud_name",
                "label": "Cloud Name",
                "type": "text",
                "required": true
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "text",
                "required": true
            },
            {
                "key": "api_secret",
                "label": "API Secret",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "creative",
        "docs": "https://cloudinary.com/documentation/"
    },
    "backblaze_b2": {
        "id": "backblaze_b2",
        "name": "Backblaze B2",
        "description": "S3-compatible cloud object storage",
        "color": "#E21D38",
        "fields": [
            {
                "key": "application_key_id",
                "label": "Application Key ID",
                "type": "text",
                "required": true
            },
            {
                "key": "application_key",
                "label": "Application Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "cloud",
        "docs": "https://www.backblaze.com/docs/cloud-storage"
    },
    "minio": {
        "id": "minio",
        "name": "MinIO",
        "description": "S3-compatible object storage",
        "color": "#C72C48",
        "fields": [
            {
                "key": "endpoint",
                "label": "MinIO Endpoint",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:9000"
            },
            {
                "key": "access_key",
                "label": "Access Key",
                "type": "text",
                "required": true
            },
            {
                "key": "secret_key",
                "label": "Secret Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "infra",
        "docs": "https://min.io/docs/minio/linux/developers/minio-drivers.html"
    },
    "fastly": {
        "id": "fastly",
        "name": "Fastly",
        "description": "Edge cloud and CDN platform",
        "color": "#FF282D",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "cloud",
        "docs": "https://www.fastly.com/documentation/reference/api/"
    },
    "bunny_cdn": {
        "id": "bunny_cdn",
        "name": "Bunny.net",
        "description": "CDN, storage, and edge platform",
        "color": "#FF6900",
        "fields": [
            {
                "key": "api_key",
                "label": "Account API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "cloud",
        "docs": "https://docs.bunny.net/reference/"
    },
    "todoist": {
        "id": "todoist",
        "name": "Todoist",
        "description": "Task management and to-do lists",
        "color": "#E44332",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://developer.todoist.com/rest/v2/"
    },
    "basecamp": {
        "id": "basecamp",
        "name": "Basecamp",
        "description": "Project management and team communication",
        "color": "#1D2D35",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true
            },
            {
                "key": "account_id",
                "label": "Account ID",
                "type": "text",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://github.com/basecamp/bc3-api"
    },
    "wrike": {
        "id": "wrike",
        "name": "Wrike",
        "description": "Work management and project collaboration",
        "color": "#08CF65",
        "fields": [
            {
                "key": "access_token",
                "label": "Permanent Access Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://developers.wrike.com/"
    },
    "smartsheet": {
        "id": "smartsheet",
        "name": "Smartsheet",
        "description": "Work management and collaboration platform",
        "color": "#0073E6",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://smartsheet.redoc.ly/"
    },
    "coda": {
        "id": "coda",
        "name": "Coda",
        "description": "All-in-one docs and workflow platform",
        "color": "#F46A54",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "documents",
        "docs": "https://coda.io/developers/apis/v1"
    },
    "google_docs": {
        "id": "google_docs",
        "name": "Google Docs",
        "description": "Google Docs document API",
        "color": "#4285F4",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "documents",
        "docs": "https://developers.google.com/docs/api"
    },
    "bedrock": {
        "id": "bedrock",
        "name": "AWS Bedrock",
        "description": "Foundation models as a service",
        "color": "#FF9900",
        "fields": [
            {
                "key": "access_key_id",
                "label": "Access Key ID",
                "type": "text",
                "required": true,
                "placeholder": "AKIA...",
                "prefix": "AKIA"
            },
            {
                "key": "secret_access_key",
                "label": "Secret Access Key",
                "type": "password",
                "required": true
            },
            {
                "key": "region",
                "label": "Region",
                "type": "text",
                "required": true,
                "default": "us-east-1"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "ai",
        "docs": "https://docs.aws.amazon.com/bedrock/"
    },
    "ollama": {
        "id": "ollama",
        "name": "Ollama",
        "description": "Local LLM server",
        "color": "#000000",
        "fields": [
            {
                "key": "base_url",
                "label": "Ollama URL",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:11434",
                "default": "http://localhost:11434"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ai",
        "docs": "https://github.com/ollama/ollama/blob/main/docs/api.md"
    },
    "langsmith": {
        "id": "langsmith",
        "name": "LangSmith",
        "description": "LLM observability and evaluation",
        "color": "#1C3C3C",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "lsv2_...",
                "prefix": "lsv2_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ai",
        "docs": "https://docs.smith.langchain.com/"
    },
    "weights_biases": {
        "id": "weights_biases",
        "name": "Weights & Biases",
        "description": "ML experiment tracking and model registry",
        "color": "#FFBE00",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ai",
        "docs": "https://docs.wandb.ai/"
    },
    "assemblyai": {
        "id": "assemblyai",
        "name": "AssemblyAI",
        "description": "Speech-to-text and audio intelligence",
        "color": "#0000FF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ai",
        "docs": "https://www.assemblyai.com/docs"
    },
    "roboflow": {
        "id": "roboflow",
        "name": "Roboflow",
        "description": "Computer vision model training and deployment",
        "color": "#6706CE",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ai",
        "docs": "https://docs.roboflow.com/"
    },
    "cal_com": {
        "id": "cal_com",
        "name": "Cal.com",
        "description": "Open-source scheduling platform",
        "color": "#292929",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true,
                "placeholder": "cal_...",
                "prefix": "cal_"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://cal.com/docs/api-reference/"
    },
    "acuity": {
        "id": "acuity",
        "name": "Acuity Scheduling",
        "description": "Online appointment scheduling",
        "color": "#3896E3",
        "fields": [
            {
                "key": "user_id",
                "label": "User ID",
                "type": "text",
                "required": true
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://developers.acuityscheduling.com/"
    },
    "home_assistant": {
        "id": "home_assistant",
        "name": "Home Assistant",
        "description": "Open-source home automation",
        "color": "#41BDF5",
        "fields": [
            {
                "key": "base_url",
                "label": "Home Assistant URL",
                "type": "url",
                "required": true,
                "placeholder": "http://homeassistant.local:8123"
            },
            {
                "key": "access_token",
                "label": "Long-Lived Access Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "infra",
        "docs": "https://developers.home-assistant.io/docs/api/rest/"
    },
    "mqtt": {
        "id": "mqtt",
        "name": "MQTT",
        "description": "MQTT message broker",
        "color": "#660066",
        "fields": [
            {
                "key": "broker_url",
                "label": "Broker URL",
                "type": "text",
                "required": true,
                "placeholder": "mqtt://broker.example.com:1883"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": false
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": false
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "infra",
        "docs": "https://mqtt.org/mqtt-specification/"
    },
    "linkedin_ads": {
        "id": "linkedin_ads",
        "name": "LinkedIn Ads",
        "description": "LinkedIn advertising and campaign management",
        "color": "#0A66C2",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true
            },
            {
                "key": "ad_account_id",
                "label": "Ad Account ID",
                "type": "text",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "social",
        "docs": "https://learn.microsoft.com/en-us/linkedin/marketing/"
    },
    "tiktok_ads": {
        "id": "tiktok_ads",
        "name": "TikTok Ads",
        "description": "TikTok advertising platform",
        "color": "#000000",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true
            },
            {
                "key": "advertiser_id",
                "label": "Advertiser ID",
                "type": "text",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "social",
        "docs": "https://business-api.tiktok.com/portal/docs"
    },
    "marketo": {
        "id": "marketo",
        "name": "Marketo",
        "description": "B2B marketing automation (Adobe)",
        "color": "#5C4C9F",
        "fields": [
            {
                "key": "munchkin_id",
                "label": "Munchkin ID",
                "type": "text",
                "required": true,
                "placeholder": "123-ABC-456"
            },
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "crm",
        "docs": "https://developers.marketo.com/rest-api/"
    },
    "iterable": {
        "id": "iterable",
        "name": "Iterable",
        "description": "Cross-channel marketing platform",
        "color": "#6747ED",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "crm",
        "docs": "https://api.iterable.com/api/docs"
    },
    "jira_sm": {
        "id": "jira_sm",
        "name": "Jira Service Management",
        "description": "Atlassian ITSM and service desk",
        "color": "#0052CC",
        "fields": [
            {
                "key": "email",
                "label": "Email",
                "type": "email",
                "required": true
            },
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            },
            {
                "key": "domain",
                "label": "Domain",
                "type": "text",
                "required": true,
                "placeholder": "your-company.atlassian.net"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://developer.atlassian.com/cloud/jira/service-desk/rest/intro/"
    },
    "statuspage": {
        "id": "statuspage",
        "name": "Statuspage",
        "description": "Atlassian status and incident communication",
        "color": "#2684FF",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            },
            {
                "key": "page_id",
                "label": "Page ID",
                "type": "text",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://developer.statuspage.io/"
    },
    "split": {
        "id": "split",
        "name": "Split",
        "description": "Feature flagging and experimentation",
        "color": "#01B286",
        "fields": [
            {
                "key": "api_key",
                "label": "Admin API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://docs.split.io/reference/introduction-to-admin-api"
    },
    "flagsmith": {
        "id": "flagsmith",
        "name": "Flagsmith",
        "description": "Open-source feature flag management",
        "color": "#3D4CDB",
        "fields": [
            {
                "key": "api_key",
                "label": "Environment Key",
                "type": "password",
                "required": true
            },
            {
                "key": "base_url",
                "label": "API URL",
                "type": "url",
                "required": false,
                "default": "https://edge.api.flagsmith.com/api/v1"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://docs.flagsmith.com/"
    },
    "unleash": {
        "id": "unleash",
        "name": "Unleash",
        "description": "Open-source feature management",
        "color": "#1A4049",
        "fields": [
            {
                "key": "base_url",
                "label": "Unleash URL",
                "type": "url",
                "required": true,
                "placeholder": "https://unleash.example.com"
            },
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "developer",
        "docs": "https://docs.getunleash.io/reference/api/"
    },
    "bugsnag": {
        "id": "bugsnag",
        "name": "Bugsnag",
        "description": "Error monitoring and stability management",
        "color": "#4949E4",
        "fields": [
            {
                "key": "auth_token",
                "label": "Personal Auth Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://bugsnagapiv2.docs.apiary.io/"
    },
    "rollbar": {
        "id": "rollbar",
        "name": "Rollbar",
        "description": "Error tracking and monitoring",
        "color": "#2980B9",
        "fields": [
            {
                "key": "access_token",
                "label": "Account Access Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://docs.rollbar.com/reference/"
    },
    "logdna": {
        "id": "logdna",
        "name": "Mezmo (LogDNA)",
        "description": "Log management and analysis",
        "color": "#0072F5",
        "fields": [
            {
                "key": "service_key",
                "label": "Service Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "devops",
        "docs": "https://docs.mezmo.com/"
    },
    "papertrail": {
        "id": "papertrail",
        "name": "Papertrail",
        "description": "Cloud-hosted log management",
        "color": "#279BDA",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://www.papertrail.com/help/api/"
    },
    "wise": {
        "id": "wise",
        "name": "Wise",
        "description": "International money transfers API",
        "color": "#9FE870",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ecommerce",
        "docs": "https://docs.wise.com/"
    },
    "mercury": {
        "id": "mercury",
        "name": "Mercury",
        "description": "Banking for startups",
        "color": "#5B5FED",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ecommerce",
        "docs": "https://docs.mercury.com/reference/"
    },
    "ntfy": {
        "id": "ntfy",
        "name": "ntfy",
        "description": "Simple HTTP-based push notifications",
        "color": "#317F6F",
        "fields": [
            {
                "key": "base_url",
                "label": "Server URL",
                "type": "url",
                "required": false,
                "placeholder": "https://ntfy.sh",
                "default": "https://ntfy.sh"
            },
            {
                "key": "token",
                "label": "Access Token",
                "type": "password",
                "required": false,
                "placeholder": "tk_..."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "notification",
        "docs": "https://docs.ntfy.sh/"
    },
    "slack_webhook": {
        "id": "slack_webhook",
        "name": "Slack Webhook",
        "description": "Slack incoming webhook for notifications",
        "color": "#4A154B",
        "fields": [
            {
                "key": "webhook_url",
                "label": "Webhook URL",
                "type": "password",
                "required": true,
                "placeholder": "https://hooks.slack.com/services/..."
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "notification",
        "docs": "https://api.slack.com/messaging/webhooks"
    },
    "discord_webhook": {
        "id": "discord_webhook",
        "name": "Discord Webhook",
        "description": "Discord channel webhook for notifications",
        "color": "#5865F2",
        "fields": [
            {
                "key": "webhook_url",
                "label": "Webhook URL",
                "type": "password",
                "required": true,
                "placeholder": "https://discord.com/api/webhooks/..."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "notification",
        "docs": "https://discord.com/developers/docs/resources/webhook#get-webhook"
    },
    "google_forms": {
        "id": "google_forms",
        "name": "Google Forms",
        "description": "Google Forms API",
        "color": "#673AB7",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "documents",
        "docs": "https://developers.google.com/forms/api"
    },
    "tally": {
        "id": "tally",
        "name": "Tally",
        "description": "Simple online form builder",
        "color": "#000000",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "documents",
        "docs": "https://tally.so/help/webhooks"
    },
    "heroku": {
        "id": "heroku",
        "name": "Heroku",
        "description": "Cloud application platform",
        "color": "#430098",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "cloud",
        "docs": "https://devcenter.heroku.com/articles/platform-api-reference"
    },
    "scaleway": {
        "id": "scaleway",
        "name": "Scaleway",
        "description": "European cloud infrastructure",
        "color": "#4F0599",
        "fields": [
            {
                "key": "access_key",
                "label": "Access Key",
                "type": "text",
                "required": true,
                "placeholder": "SCW...",
                "prefix": "SCW"
            },
            {
                "key": "secret_key",
                "label": "Secret Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "cloud",
        "docs": "https://www.scaleway.com/en/developers/api/"
    },
    "upcloud": {
        "id": "upcloud",
        "name": "UpCloud",
        "description": "European cloud infrastructure",
        "color": "#7B00FF",
        "fields": [
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "cloud",
        "docs": "https://developers.upcloud.com/"
    },
    "twitch": {
        "id": "twitch",
        "name": "Twitch",
        "description": "Twitch streaming and chat API",
        "color": "#9146FF",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": false,
                "placeholder": "Only for the connector OAuth client-credentials flow"
            },
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "social",
        "docs": "https://dev.twitch.tv/docs/api/"
    },
    "spotify": {
        "id": "spotify",
        "name": "Spotify",
        "description": "Spotify Web API for music data",
        "color": "#1DB954",
        "fields": [
            {
                "key": "client_id",
                "label": "Client ID",
                "type": "text",
                "required": true
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "social",
        "docs": "https://developer.spotify.com/documentation/web-api"
    },
    "open_meteo": {
        "id": "open_meteo",
        "name": "Open-Meteo",
        "description": "Free weather API (no key required)",
        "color": "#FF6B35",
        "fields": [],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://open-meteo.com/en/docs"
    },
    "ip_api": {
        "id": "ip_api",
        "name": "ip-api",
        "description": "IP geolocation API",
        "color": "#2196F3",
        "fields": [],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://ip-api.com/docs"
    },
    "wolfram_alpha": {
        "id": "wolfram_alpha",
        "name": "Wolfram Alpha",
        "description": "Computational knowledge engine",
        "color": "#DD1100",
        "fields": [
            {
                "key": "app_id",
                "label": "App ID",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ai",
        "docs": "https://products.wolframalpha.com/api"
    },
    "imgbb": {
        "id": "imgbb",
        "name": "ImgBB",
        "description": "Image hosting and sharing API",
        "color": "#3DB36B",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "creative",
        "docs": "https://api.imgbb.com/"
    },
    "uptimerobot": {
        "id": "uptimerobot",
        "name": "UptimeRobot",
        "description": "Website uptime monitoring",
        "color": "#3BD671",
        "fields": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://uptimerobot.com/api/"
    },
    "betterstack": {
        "id": "betterstack",
        "name": "Better Stack",
        "description": "Uptime monitoring, logging, and incident management",
        "color": "#000000",
        "fields": [
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://betterstack.com/docs/uptime/api/getting-started-with-uptime-api/"
    },
    "google_meet": {
        "id": "google_meet",
        "name": "Google Meet",
        "description": "Google Meet video conferencing API",
        "color": "#00897B",
        "fields": [
            {
                "key": "service_account_json",
                "label": "Service Account JSON",
                "type": "textarea",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "communication",
        "docs": "https://developers.google.com/meet/api"
    },
    "microsoft_365": {
        "id": "microsoft_365",
        "name": "Microsoft 365",
        "description": "Microsoft Graph API for 365 services",
        "color": "#0078D4",
        "fields": [
            {
                "key": "tenant_id",
                "label": "Tenant ID",
                "type": "text",
                "required": true
            },
            {
                "key": "client_id",
                "label": "Application (Client) ID",
                "type": "text",
                "required": true
            },
            {
                "key": "client_secret",
                "label": "Client Secret",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "documents",
        "docs": "https://learn.microsoft.com/en-us/graph/overview"
    },
    "mapbox": {
        "id": "mapbox",
        "name": "Mapbox",
        "description": "Maps and location APIs",
        "color": "#4264FB",
        "fields": [
            {
                "key": "access_token",
                "label": "Access Token",
                "type": "password",
                "required": true,
                "placeholder": "pk.ey...",
                "prefix": "pk."
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "custom",
        "docs": "https://docs.mapbox.com/api/"
    },
    "airtable_personal": {
        "id": "airtable_personal",
        "name": "Airtable (Personal Token)",
        "description": "Airtable personal access token auth",
        "color": "#18BFFF",
        "fields": [
            {
                "key": "personal_token",
                "label": "Personal Access Token",
                "type": "password",
                "required": true,
                "placeholder": "pat...",
                "prefix": "pat"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://airtable.com/developers/web/api/introduction"
    },
    "vercel_blob": {
        "id": "vercel_blob",
        "name": "Vercel Blob",
        "description": "Vercel edge-first object storage",
        "color": "#000000",
        "fields": [
            {
                "key": "token",
                "label": "Blob Read/Write Token",
                "type": "password",
                "required": true,
                "placeholder": "vercel_blob_rw_...",
                "prefix": "vercel_blob_rw_"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "cloud",
        "docs": "https://vercel.com/docs/storage/vercel-blob"
    },
    "sanity": {
        "id": "sanity",
        "name": "Sanity",
        "description": "Structured content platform (headless CMS)",
        "color": "#F03E2F",
        "fields": [
            {
                "key": "project_id",
                "label": "Project ID",
                "type": "text",
                "required": true
            },
            {
                "key": "token",
                "label": "API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "documents",
        "docs": "https://www.sanity.io/docs/http-api"
    },
    "contentful": {
        "id": "contentful",
        "name": "Contentful",
        "description": "Headless content management platform",
        "color": "#2478CC",
        "fields": [
            {
                "key": "space_id",
                "label": "Space ID",
                "type": "text",
                "required": true
            },
            {
                "key": "access_token",
                "label": "Content Delivery API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "documents",
        "docs": "https://www.contentful.com/developers/docs/"
    },
    "strapi": {
        "id": "strapi",
        "name": "Strapi",
        "description": "Open-source headless CMS",
        "color": "#4945FF",
        "fields": [
            {
                "key": "base_url",
                "label": "Strapi URL",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:1337"
            },
            {
                "key": "api_token",
                "label": "API Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "documents",
        "docs": "https://docs.strapi.io/dev-docs/api/rest"
    },
    "directus": {
        "id": "directus",
        "name": "Directus",
        "description": "Open-source data platform and headless CMS",
        "color": "#6644FF",
        "fields": [
            {
                "key": "base_url",
                "label": "Directus URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-instance.directus.app"
            },
            {
                "key": "token",
                "label": "Static Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "documents",
        "docs": "https://docs.directus.io/reference/introduction.html"
    },
    "ghost": {
        "id": "ghost",
        "name": "Ghost",
        "description": "Publishing and newsletter platform",
        "color": "#15171A",
        "fields": [
            {
                "key": "base_url",
                "label": "Ghost URL",
                "type": "url",
                "required": true,
                "placeholder": "https://your-site.ghost.io"
            },
            {
                "key": "admin_api_key",
                "label": "Admin API Key",
                "type": "password",
                "required": true,
                "placeholder": "id:secret format"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "documents",
        "docs": "https://ghost.org/docs/admin-api/"
    },
    "algolia_search": {
        "id": "algolia_search",
        "name": "Algolia Search",
        "description": "Algolia search API with search-only key",
        "color": "#003DFF",
        "fields": [
            {
                "key": "app_id",
                "label": "Application ID",
                "type": "text",
                "required": true
            },
            {
                "key": "admin_key",
                "label": "Admin API Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://www.algolia.com/doc/rest-api/search/"
    },
    "typesense": {
        "id": "typesense",
        "name": "Typesense",
        "description": "Open-source search engine",
        "color": "#D63AF9",
        "fields": [
            {
                "key": "host",
                "label": "Host",
                "type": "text",
                "required": true,
                "placeholder": "your-cluster.a1.typesense.net"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": true
            },
            {
                "key": "port",
                "label": "Port",
                "type": "text",
                "required": false,
                "default": "443"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://typesense.org/docs/"
    },
    "meilisearch": {
        "id": "meilisearch",
        "name": "Meilisearch",
        "description": "Lightning-fast search engine",
        "color": "#FF5CAA",
        "fields": [
            {
                "key": "host",
                "label": "Meilisearch URL",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:7700"
            },
            {
                "key": "api_key",
                "label": "Master Key",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "data",
        "docs": "https://www.meilisearch.com/docs/reference/api/"
    },
    "zep": {
        "id": "zep",
        "name": "Zep",
        "description": "Long-term memory for AI assistants",
        "color": "#6C47FF",
        "fields": [
            {
                "key": "api_url",
                "label": "Zep API URL",
                "type": "url",
                "required": true,
                "placeholder": "http://localhost:8000",
                "default": "http://localhost:8000"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": false
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "ai",
        "docs": "https://docs.getzep.com/"
    },
    "windmill": {
        "id": "windmill",
        "name": "Windmill",
        "description": "Open-source developer platform for scripts and workflows",
        "color": "#3B82F6",
        "fields": [
            {
                "key": "base_url",
                "label": "Windmill URL",
                "type": "url",
                "required": true,
                "placeholder": "https://app.windmill.dev"
            },
            {
                "key": "token",
                "label": "User Token",
                "type": "password",
                "required": true
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "automation",
        "docs": "https://app.windmill.dev/openapi.html"
    },
    "wazuh": {
        "id": "wazuh",
        "name": "Wazuh",
        "description": "Open source security monitoring (SIEM/XDR)",
        "color": "#00A9E5",
        "fields": [
            {
                "key": "base_url",
                "label": "Wazuh API URL",
                "type": "url",
                "required": true,
                "placeholder": "https://wazuh-host:55000"
            },
            {
                "key": "username",
                "label": "API Username",
                "type": "text",
                "required": true,
                "placeholder": "wazuh-wui"
            },
            {
                "key": "password",
                "label": "API Password",
                "type": "password",
                "required": true,
                "placeholder": "Your Wazuh API password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://documentation.wazuh.com/current/user-manual/api/reference.html"
    },
    "mikrotik_routeros": {
        "id": "mikrotik_routeros",
        "name": "MikroTik RouterOS",
        "description": "Network router and switch management",
        "color": "#293239",
        "fields": [
            {
                "key": "base_url",
                "label": "Router API URL",
                "type": "url",
                "required": true,
                "placeholder": "https://198.51.100.1"
            },
            {
                "key": "username",
                "label": "Username",
                "type": "text",
                "required": true,
                "placeholder": "admin"
            },
            {
                "key": "password",
                "label": "Password",
                "type": "password",
                "required": true,
                "placeholder": "Your RouterOS password"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "infra",
        "docs": "https://help.mikrotik.com/docs/display/ROS/REST+API"
    },
    "uptime_kuma": {
        "id": "uptime_kuma",
        "name": "Uptime Kuma",
        "description": "Self-hosted uptime monitoring",
        "color": "#5CDD8B",
        "fields": [
            {
                "key": "base_url",
                "label": "Uptime Kuma URL",
                "type": "url",
                "required": true,
                "placeholder": "https://status.example.com"
            },
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": false,
                "placeholder": "Optional API key for authenticated endpoints"
            }
        ],
        "hasLiveTest": true,
        "testDepth": "live",
        "category": "devops",
        "docs": "https://github.com/louislam/uptime-kuma/wiki/API"
    },
    "repobrain": {
        "id": "repobrain",
        "name": "RepoBrain Backend",
        "description": "Shared secret for a self-hosted RepoBrain (QuoxNucleus) backend",
        "color": "#7C5CFF",
        "fields": [
            {
                "key": "shared_secret",
                "label": "Shared Secret",
                "type": "password",
                "required": true,
                "placeholder": "Value of REPOBRAIN_SHARED_KEY on the backend host"
            }
        ],
        "hasLiveTest": false,
        "testDepth": "format-only",
        "category": "developer"
    }
};

// Categories for grouping — mirrors the backend registry's
// INTEGRATION_CATEGORIES so the two never diverge either.
export const INTEGRATION_CATEGORIES = {
    "ai": {
        "id": "ai",
        "name": "AI & ML",
        "description": "AI and machine learning services"
    },
    "developer": {
        "id": "developer",
        "name": "Developer Tools",
        "description": "Source control, CI/CD, and deployment"
    },
    "cloud": {
        "id": "cloud",
        "name": "Cloud Services",
        "description": "Cloud infrastructure and platforms"
    },
    "automation": {
        "id": "automation",
        "name": "Automation",
        "description": "Workflow and automation tools"
    },
    "messaging": {
        "id": "messaging",
        "name": "Messaging",
        "description": "Communication and messaging platforms"
    },
    "communication": {
        "id": "communication",
        "name": "Communication",
        "description": "Email, SMS, and messaging platforms"
    },
    "social": {
        "id": "social",
        "name": "Social Media",
        "description": "Social media platforms and APIs"
    },
    "documents": {
        "id": "documents",
        "name": "Documents & E-Signatures",
        "description": "Document management and signing"
    },
    "creative": {
        "id": "creative",
        "name": "Creative & Design",
        "description": "Design tools and creative platforms"
    },
    "ecommerce": {
        "id": "ecommerce",
        "name": "E-Commerce",
        "description": "Payment processing and online stores"
    },
    "custom": {
        "id": "custom",
        "name": "Custom",
        "description": "Custom integrations"
    },
    "crm": {
        "id": "crm",
        "name": "CRM & Sales",
        "description": "Customer relationship management and sales tools"
    },
    "data": {
        "id": "data",
        "name": "Data & Analytics",
        "description": "Databases, data warehouses, and BI tools"
    },
    "security": {
        "id": "security",
        "name": "Security & Identity",
        "description": "SSO, authentication, and security tools"
    },
    "devops": {
        "id": "devops",
        "name": "DevOps & Observability",
        "description": "Monitoring, logging, alerting, and infrastructure"
    },
    "infra": {
        "id": "infra",
        "name": "Infrastructure",
        "description": "SSH, bastion, and network management"
    },
    "notification": {
        "id": "notification",
        "name": "Notifications",
        "description": "Notification channels and alerting"
    },
    "browser": {
        "id": "browser",
        "name": "Browser & Scraping",
        "description": "Headless browsers, web scraping, and website login credentials"
    },
    "email": {
        "name": "Email",
        "description": "Email integrations"
    },
    "productivity": {
        "name": "Productivity",
        "description": "Productivity integrations"
    },
    "integrations": {
        "name": "Integrations",
        "description": "Integrations integrations"
    },
    "analytics": {
        "name": "Analytics",
        "description": "Analytics integrations"
    },
    "utilities": {
        "name": "Utilities",
        "description": "Utilities integrations"
    },
    "ticketing": {
        "name": "Ticketing",
        "description": "Ticketing integrations"
    },
    "cloudsecurity": {
        "name": "Cloud Security",
        "description": "Cloud Security integrations"
    },
    "zerotrust": {
        "name": "Zero Trust",
        "description": "Zero Trust integrations"
    },
    "kubernetes": {
        "name": "Kubernetes",
        "description": "Kubernetes integrations"
    },
    "datamovement": {
        "name": "Data Movement",
        "description": "Data Movement integrations"
    },
    "datacatalog": {
        "name": "Data Catalog",
        "description": "Data Catalog integrations"
    },
    "documentai": {
        "name": "Document AI",
        "description": "Document AI integrations"
    },
    "finance": {
        "name": "Finance",
        "description": "Finance integrations"
    },
    "compliance": {
        "name": "Compliance",
        "description": "Compliance integrations"
    },
    "vectordb": {
        "name": "Vector Databases",
        "description": "Vector Databases integrations"
    },
    "data_ai": {
        "name": "Data_ai",
        "description": "Data_ai integrations"
    }
};

/**
 * Get integration types grouped by category
 */
export function getIntegrationsByCategory() {
    const grouped = {};

    for (const [id, type] of Object.entries(INTEGRATION_TYPES)) {
        const category = type.category || 'custom';
        if (!grouped[category]) {
            grouped[category] = {
                ...INTEGRATION_CATEGORIES[category],
                integrations: []
            };
        }
        grouped[category].integrations.push(type);
    }

    return grouped;
}

/**
 * Get a specific integration type
 */
export function getIntegrationType(typeId) {
    return INTEGRATION_TYPES[typeId] || null;
}

/**
 * Validate credentials for a type (client-side)
 */
export function validateCredentials(typeId, credentials) {
    const type = INTEGRATION_TYPES[typeId];
    if (!type) {
        return { valid: false, errors: { _form: 'Unknown integration type' } };
    }

    const errors = {};

    for (const field of type.fields) {
        const value = credentials[field.key];

        if (field.required && (!value || !value.trim())) {
            errors[field.key] = `${field.label} is required`;
            continue;
        }

        if (value && field.prefix && !value.startsWith(field.prefix)) {
            errors[field.key] = `${field.label} should start with ${field.prefix}`;
        }

        if (value && field.type === 'url') {
            try {
                new URL(value);
            } catch {
                errors[field.key] = 'Invalid URL format';
            }
        }
    }

    return {
        valid: Object.keys(errors).length === 0,
        errors
    };
}

export default INTEGRATION_TYPES;
