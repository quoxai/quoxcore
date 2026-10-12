# QuoxCORE Plugin Registry

Comprehensive reference for all 26 plugins in the QuoxCORE platform.

---

## Overview

Plugins extend QuoxCORE with monitoring integrations, security tools, workflow capabilities, AI features, and infrastructure management. Each plugin is defined by a JSON manifest in `src/config/plugins/` and registered in `src/config/plugins/index.js`.

### Trust Model

- Official built-in plugins ship with QuoxCORE and are part of the reviewed application codebase.
- Community / third-party plugins are **trusted-admin-only extensions**.
- Install community plugins only from sources you trust and review as code, not as harmless content.
- AOCL layer plugins should prefer JSON manifests; JavaScript AOCL plugins are an explicitly higher-trust path used for reviewed code.

### Architecture

```
JSON Manifest (src/config/plugins/<name>.json)
    |
    v
Plugin Registry (src/config/plugins/index.js)
    |
    v
License Validator (src/services/licenseValidator.js)
    |
    v
App Routes (src/App.jsx) + Sidebar Entry
    |
    v
View Component (src/pages/views/<Name>View.jsx)
```

### Activation Flow

1. User navigates to **Settings > Plugins** and enables a plugin.
2. The license validator checks whether the user's stored license includes the required tier.
3. If licensed (or free), the plugin activates: its sidebar entry appears and its route becomes accessible.
4. Plugin state persists in localStorage and syncs to the server via `serverSyncQueue`.

---

## Plugin Tiers

QuoxCORE uses a hierarchical tier model. Higher tiers include all lower tier access.

| Tier | Level | Description |
|------|-------|-------------|
| `free` | 0 | No licence required. Available to all users. |
| `tier_a` | 1 | Starter plugins. Low-cost, one-time purchase. |
| `tier_b` | 2 | Standard plugins. Infrastructure and monitoring integrations. |
| `tier_c` | 3 | Enterprise plugins. Compliance, audit, and governance. |

### Licensing Model

- **Ed25519 signature verification** for agent-generated licences (cryptographic proof).
- **HMAC-signed licences** for website store purchases (server-generated, trusted).
- **Trial licences** accepted without cryptographic verification for evaluation.
- Licences are stored in localStorage and synced to the server for cross-device access.
- A licence contains: `id`, `customer_id`, `tiers[]`, `expires_at`, and `signature`.
- Tier hierarchy means a `tier_c` licence unlocks all `tier_a` and `tier_b` plugins automatically.

---

## Plugin Registry

### Monitoring (6 plugins)

| Plugin | ID | Tier | Price | Description |
|--------|----|------|-------|-------------|
| Uptime Kuma | `uptime-kuma` | tier_a | $9 | Real-time service uptime monitoring. Ping times, 24h/30d uptime percentages, service groups, auto-refresh. |
| Grafana | `grafana` | tier_a | $9 | Dashboard discovery, alert rule visibility, folder browsing, quick links to Grafana dashboards. |
| Prometheus Intelligence | `prometheus` | tier_a | $19 | Fleet health heatmap, anomaly detection, capacity forecasting, PromQL explorer, alert timeline. |
| Proxmox VE | `proxmox` | tier_b | $29 | Cluster overview, VM/LXC lifecycle management, resource monitoring, snapshot management, storage overview. |
| OpsDeck | `opsdeck` | tier_a | $8 | Live constellation visualisation of all 16 agents. Orbital layout, scanning glow effect, system pulse bar. |
| Wazuh SIEM | `wazuh` | tier_b | $25 | SIEM integration with fleet agent deployment, alert triage, vulnerability scanning, file integrity monitoring, CIS compliance. |

### Infrastructure (5 plugins)

| Plugin | ID | Tier | Price | Description |
|--------|----|------|-------|-------------|
| QuoxAgent Fleet Management | `quoxagent-fleet` | tier_b | $39 | Distributed agent fleet dashboard, remote command execution, per-host resource monitoring, job tracking. |
| QuoxBastion Fleet Manager | `bastion-fleet` | tier_b | $15 | Centralised host registry, secure SSH remote execution, SSH key management, AEE audit trail. |
| Docker Fleet | `docker-fleet` | tier_b | $25 | Multi-host Docker management. Auto-discovery, container lifecycle, Compose stacks, image security scanning, AI diagnostics. |
| RouterOS (MikroTik) | `mikrotik-routeros` | tier_b | $35 | MikroTik router management with plain English explanations, DHCP management, VPN monitoring, firewall rules, safe automation. |
| Web Terminal | `web-terminal` | tier_b | $20 | Browser-based terminal with multi-pane workspaces, SSH via bastion, AI chat assistant, session persistence, AEE audit trail. |

### AI & Memory (4 plugins)

| Plugin | ID | Tier | Price | Description |
|--------|----|------|-------|-------------|
| Advanced Memory | `advanced-memory` | tier_b | $99 | Unlimited semantic memory, style engine, ChatGPT import, belief/failure memory, WSM, contradiction detection, 4000-token context. |
| Advanced Voice | `advanced-voice` | tier_a | $35 | 40+ ElevenLabs voices, voice parameter tuning, AI smart summarisation, 2000-char TTS limit, per-agent voice assignment. |
| Cognitive Topology | `cognitive-topology` | free | Free | Mirror self-awareness system. 10 cognitive implants, memory lattice, agent mesh, reflection data viewer. |
| Local Inference | `local-inference` | tier_b* | $89 (beta: free) | Self-hosted LLM inference via Ollama, vLLM, llama.cpp, NVIDIA NIM. Model switching, streaming, local embeddings, health monitoring. |

\* Local Inference is not yet in the licence validator tier map. Currently free during public beta.

### Compliance & Audit (3 plugins)

| Plugin | ID | Tier | Price | Description |
|--------|----|------|-------|-------------|
| AOCL Compliance Suite | `aocl-compliance-suite` | tier_c | $499/yr | SOC2, HIPAA, GDPR, ISO 27001 exports. Trace replay, trace comparison, multi-agent correlation, evidence bundles. |
| AOCL Developer Kit | `aocl-developer-kit` | tier_c | $199 | Layer Playground, custom AOCL layer plugins, plugin marketplace, SDK with TypeScript support, sandboxed execution. |
| Decision Evidence | `decision-evidence` | tier_c | $699/yr | Structured decision evidence capture for every AI response. Evidence timeline, search, export, VOLT integration. |

### Workflow & Productivity (4 plugins)

| Plugin | ID | Tier | Price | Description |
|--------|----|------|-------|-------------|
| Workflow Library | `workflow-library` | free | Free | 1,300+ QuoxFlow workflow templates with search, category filtering, WireMap visual diagrams. |
| Action Tracker | `action-tracker` | tier_a | $5 | Kanban board with TODO/DOING/DONE columns, drag-and-drop, streaks, confetti, AI integration, due dates. |
| Prompts Library | `prompts-library` | free | Free | 80+ curated AI system prompts from Claude, Cursor, Devin, and more. Copy, create, search, export. |
| CoreComms | `core-comms` | tier_a | $5 | External notifications via Telegram, Slack, and Email. Priority filters, test connections, graceful error recovery. |

### System (4 plugins)

| Plugin | ID | Tier | Price | Description |
|--------|----|------|-------|-------------|
| Files | `files` | tier_a | Free | File upload, preview, chat attachments, storage tracking. Premium: semantic search, memory integration. |
| Backup, Restore & Migration | `backup-restore` | tier_a | Free | Full/selective backup, SHA-256 verification, DEFCON audit logging, scheduling, dry-run restore, migration support. |
| System Maintenance | `system-maintenance` | free | Free | Unified backup + update management. GitHub Release detection, one-click updates, rollback, version tracking. |
| Codebase Mirror | `codebase-mirror` | free | Free | Structural code indexing and drift detection. Auto-detect project types, registry sync validation, cognitive implant. |

---

## Tier-to-Plugin Mapping

Source: `src/services/licenseValidator.js` (`PLUGIN_TIERS` constant).

### Free (no licence required)

| Plugin | Notes |
|--------|-------|
| Cognitive Topology | Mirror self-awareness system |
| Workflow Library | 1,300+ templates |
| Prompts Library | 80+ curated prompts |
| System Maintenance | Backup + updates |
| Codebase Mirror | Code indexing |

### Tier A (Starter)

| Plugin | Price |
|--------|-------|
| Advanced Voice | $35 |
| Files | Free |
| Prometheus Intelligence | $19 |
| Grafana | $9 |
| Uptime Kuma | $9 |
| Backup, Restore & Migration | Free |
| CoreComms | $5 |
| Action Tracker | $5 |
| OpsDeck | $8 |

### Tier B (Standard)

| Plugin | Price |
|--------|-------|
| Advanced Memory | $99 |
| Proxmox VE | $29 |
| QuoxAgent Fleet Management | $39 |
| Cognitive Topology | Free (also in free) |
| MikroTik RouterOS | $35 |
| Web Terminal | $20 |
| Wazuh SIEM | $25 |
| QuoxBastion Fleet Manager | $15 |
| Docker Fleet | $25 |

### Tier C (Enterprise)

| Plugin | Price |
|--------|-------|
| AOCL Compliance Suite | $499/yr |
| AOCL Developer Kit | $199 |
| Decision Evidence | $699/yr |

---

## Registration Chain

To add a new plugin to QuoxCORE, complete all steps in order.

### Step 1: Create the Manifest

Create `src/config/plugins/<plugin-name>.json` with the required fields (see [Manifest Format](#plugin-manifest-format) below).

### Step 2: Register in Plugin Index

Add the import and registry entry in `src/config/plugins/index.js`:

```javascript
import myPlugin from './my-plugin.json'

export const PLUGINS = {
  // ...existing plugins
  'my-plugin': myPlugin
}
```

### Step 3: Add to Licence Validator

Add the tier mapping in `src/services/licenseValidator.js`:

```javascript
const PLUGIN_TIERS = {
  // ...existing mappings
  'my-plugin': 'tier_a'  // or tier_b, tier_c, free
}
```

### Step 4: Create the View Component

Create `src/pages/views/MyPluginView.jsx` with the plugin's UI.

### Step 5: Add the Route

Register the route in `src/App.jsx`:

```jsx
<Route path="/my-plugin" element={<MyPluginView />} />
```

### Step 6: Add the Sidebar Entry

Add the navigation entry in the sidebar component so users can reach the plugin.

### Step 7: Test the Activation Flow

Verify the complete chain:
1. Plugin appears in **Settings > Plugins**.
2. Enabling the plugin adds a sidebar entry.
3. Clicking the sidebar entry renders the view.
4. Licence gating works correctly (free plugins always accessible; premium plugins require the correct tier).

---

## Plugin Manifest Format

Every plugin manifest is a JSON file in `src/config/plugins/`. Below is the schema with required and optional fields.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique plugin identifier (kebab-case). Must match the key in `PLUGINS`. |
| `version` | string | Semantic version (e.g. `"1.0.0"`). |
| `displayName` | string | Human-readable name shown in the UI. |
| `description` | string | Full description for the plugin store page. |
| `shortDescription` | string | One-line summary for cards and lists. |
| `author` | string | Plugin author (typically `"QUOX"`). |
| `license` | string | `"free"` or `"commercial"`. |
| `price` | number | Price in USD. `0` for free plugins. |
| `priceDisplay` | string | Formatted price string (e.g. `"$29"`, `"$499/yr"`, `"Free"`). |
| `priceModel` | string | `"free"`, `"one-time"`, or `"annual"`. |
| `tier` | string | Display tier: `"free"`, `"starter"`, `"standard"`, `"pro"`, `"enterprise"`. |
| `features` | object | Map of feature keys to feature objects (see below). |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `tagline` | string | Short marketing tagline. |
| `featured` | boolean | Whether to highlight in the plugin store. |
| `badge` | string | Badge label (e.g. `"MOST POPULAR"`, `"ENTERPRISE"`, `"NEW"`, `"BETA"`). |
| `icon` | string | Icon identifier for the UI. |
| `accentColor` | string | Hex colour for UI theming. |
| `heroGradient` | string | CSS gradient for the plugin store hero section. |
| `infoUrl` | string | URL to the plugin's information page. |
| `route` | string | Dashboard route path (e.g. `"/monitoring/grafana"`). |
| `marketingPoints` | string[] | Bullet points for the store listing. |
| `comparison` | object | Free vs premium feature comparison for the store page. |
| `limits` | object | Tier-specific numeric limits (e.g. max items, storage caps). |
| `requirements` | object | Minimum version requirements and external dependencies. |
| `activation` | object | Licence activation config (type, endpoint, validation method). |
| `integration` | object | Paths to service files, view components, and panels. |
| `configSchema` | object | User-configurable settings with types, defaults, and labels. |
| `safety` | object | Destructive actions list, approval requirements, kill switch flag. |
| `capabilities` | object | AEE intents and tool access levels. |
| `nocIntegration` | object | NOC tab config with quick action buttons. |
| `changelog` | object | Version history with dates and change lists. |
| `testimonials` | array | Quotes for the store listing. |

### Feature Object Schema

```json
{
  "name": "Feature Display Name",
  "description": "What this feature does.",
  "icon": "icon-identifier",
  "highlight": true,
  "premiumOnly": false,
  "comingSoon": false,
  "enterprise": false
}
```

### Example Manifest (Minimal)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "displayName": "My Plugin",
  "tagline": "Does something useful",
  "description": "Full description of what this plugin does.",
  "shortDescription": "One-line summary.",
  "author": "QUOX",
  "license": "commercial",
  "price": 15,
  "priceDisplay": "$15",
  "priceModel": "one-time",
  "tier": "standard",
  "featured": false,
  "icon": "zap",
  "accentColor": "#3b82f6",

  "features": {
    "mainFeature": {
      "name": "Main Feature",
      "description": "The primary capability of this plugin.",
      "icon": "star",
      "highlight": true
    }
  },

  "limits": {
    "free": { "maxItems": 5 },
    "premium": { "maxItems": -1 }
  },

  "requirements": {
    "quox": ">=1.0.0"
  },

  "integration": {
    "view": "src/pages/views/MyPluginView.jsx",
    "service": "src/services/myPluginService.js"
  }
}
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/config/plugins/index.js` | Plugin registry. Exports `PLUGINS`, `getPluginManifest()`, `getPluginFeatures()`, `getPluginLimits()`. |
| `src/config/plugins/*.json` | 26 individual plugin manifest files. |
| `src/services/licenseValidator.js` | Licence validation, tier checking, `PLUGIN_TIERS` mapping, `isPluginLicensed()`. |
| `src/services/pluginClient.js` | Client-side plugin activation and state management. |
| `src/App.jsx` | Route definitions for all plugin views. |
