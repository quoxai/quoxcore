/**
 * MCP Resource & Prompt Definitions
 *
 * Defines read-only resources and reusable prompt templates that QuoxMCP
 * registers via the MCP protocol. Resources provide static/semi-static
 * context; prompts provide operational templates with argument substitution.
 *
 * Resources are fetched by QuoxMCP at startup via GET /api/v1/resources/list.
 * Prompts are fetched via GET /api/v1/prompts/list.
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// Per-resource caches  { data: string, expires: number }
// ============================================================================

const _alertsCache = new Map();      // keyed by promUrl
const _pluginStatusCache = new Map(); // keyed by 'plugin-status'
const _auditHistoryCache = new Map(); // keyed by 'audit-history'

// ============================================================================
// Resource content generators
// ============================================================================

/**
 * System identity — static context about Quox architecture and capabilities.
 */
function generateSystemIdentity() {
  return `## Quox System Context

You are operating within **Quox** (Multi-Agent Executive System for Tactical Resource Orchestration).
Quox is an AI-powered infrastructure command center that manages a homelab environment.

### Agent Hierarchy
- **Quox** - Master orchestrator (coordinates all)
- **WARDEN** - Security operations
- **CIPHER** - Network operations
- **DAEDALUS** - DevOps & automation
- **PRISM** - Analysis & classification
- **HYPERION** - Proxmox/virtualization
- **METRICS** - Prometheus monitoring
- **INSIGHT** - Grafana dashboards
- **SCHOLAR** - Research & documentation
- **VIGIL** - Uptime monitoring
- **VULCAN** - Code generation
- **COREY** - System introspection

### Capabilities
- SSH execution on 50+ hosts via QuoxBastion
- Docker container management
- Proxmox VM/CT operations
- Prometheus metrics and Grafana dashboards
- Security auditing and SSL certificate checks
- Fleet management via QuoxAgent
- Persistent memory across sessions
- File management with AI-powered search

### Infrastructure
- Bastion: gw-01 (${process.env.BASTION_HOST || 'your-bastion'})
- Proxmox cluster: hyp-01-03
- Docker hosts: docker01-04
- Collector API: port 9848
- QuoxAgent: port 9847 per host`;
}

/**
 * Agent registry — all agents with their roles, domains, and capabilities.
 * Reads from entity assistant JSON files if available, falls back to inline.
 */
function generateAgentRegistry() {
  const assistantsPath = path.join(__dirname, '../../../src/config/entities/assistants');
  const agents = [];

  try {
    const files = fs.readdirSync(assistantsPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(assistantsPath, file), 'utf8'));
        agents.push({
          id: data.id,
          name: (data.identity && data.identity.name) || data.id.toUpperCase(),
          role: (data.hierarchy && data.hierarchy.role) || 'agent',
          domain: (data.capabilities && data.capabilities.domains && data.capabilities.domains[0]) || 'general',
          description: (data.identity && data.identity.description) || '',
          defconLevel: (data.safety && data.safety.defconLevel) || 'GREEN',
          capabilities: (data.capabilities && data.capabilities.domains) || []
        });
      } catch (err) {
        // Skip malformed files
      }
    }
  } catch (err) {
    // Assistants directory not available — use minimal fallback
  }

  if (agents.length === 0) {
    // Inline fallback if entity files not mounted
    return JSON.stringify({ agents: [
      { id: 'quox', name: 'QUOX', role: 'orchestrator', domain: 'coordination', defconLevel: 'GREEN' },
      { id: 'sentinel', name: 'WARDEN', role: 'specialist', domain: 'security', defconLevel: 'AMBER' },
      { id: 'nova', name: 'DAEDALUS', role: 'specialist', domain: 'devops', defconLevel: 'GREEN' },
      { id: 'cipher', name: 'CIPHER', role: 'specialist', domain: 'network', defconLevel: 'AMBER' },
      { id: 'atlas', name: 'HYPERION', role: 'specialist', domain: 'virtualization', defconLevel: 'AMBER' },
      { id: 'metrics', name: 'METRICS', role: 'specialist', domain: 'monitoring', defconLevel: 'GREEN' },
    ]}, null, 2);
  }

  return JSON.stringify({ agents }, null, 2);
}

/**
 * Tool permissions — RBAC matrix showing which tools each agent can use.
 * Requires AGENT_TOOLS to be passed in.
 */
function generateToolPermissions(agentTools) {
  const matrix = {};
  for (const [agentId, tools] of Object.entries(agentTools)) {
    matrix[agentId] = tools;
  }
  return JSON.stringify({ tool_permissions: matrix }, null, 2);
}

/**
 * DEFCON levels — operational risk classification system.
 */
function generateDefconLevels() {
  return JSON.stringify({
    defcon_levels: {
      GREEN: { level: 5, description: 'Safe operations - auto-run allowed', approval: 'none', examples: ['status queries', 'metric lookups', 'dashboard views'] },
      BLUE: { level: 4, description: 'Low risk operations - auto-run with logging', approval: 'log_only', examples: ['single-host queries', 'code generation', 'analysis'] },
      AMBER: { level: 3, description: 'Medium risk operations - require confirmation', approval: 'human_confirm', examples: ['multi-host ops', 'VM operations', 'service restarts'] },
      YELLOW: { level: 2.5, description: 'Elevated risk - confirmation required with audit', approval: 'human_confirm', examples: ['bulk operations', 'network changes', 'credential access'] },
      ORANGE: { level: 2, description: 'High risk operations - require explicit approval', approval: 'two_person', examples: ['production changes', 'data modifications', 'security changes'] },
      RED: { level: 1, description: 'Critical operations - manual only', approval: 'manual_only', examples: ['firewall changes', 'key rotations', 'destructive ops'] }
    }
  }, null, 2);
}

/**
 * Fleet topology — live data, generated on each read from in-memory agent state.
 * Requires the agents Map and a formatter function.
 */
function generateFleetTopology(agentsMap) {
  if (!agentsMap || typeof agentsMap.values !== 'function') {
    return JSON.stringify({ hosts: [], total: 0 });
  }

  const hosts = [];
  for (const agent of agentsMap.values()) {
    hosts.push({
      host_id: agent.host_id,
      hostname: agent.system?.hostname || agent.host_id,
      ip: agent.remote_addr || '',
      os: agent.system?.os_version || '',
      health: agent.status?.health || 'unknown',
      connection: agent.status?.connection || 'unknown',
      cpu_percent: agent.resources?.cpu?.usage_percent || 0,
      memory_percent: agent.resources?.memory?.usage_percent || 0,
      uptime_seconds: agent.system?.uptime_seconds || 0,
      agent_version: agent.agent?.version || '',
      capabilities: agent.capabilities || []
    });
  }

  return JSON.stringify({ hosts, total: hosts.length }, null, 2);
}

/**
 * Active alerts — live Prometheus alert data grouped by severity.
 * Cached 30 seconds per Prometheus URL.
 * @param {string} promUrl
 * @returns {Promise<string>} JSON string
 */
async function generatePrometheusAlerts(promUrl) {
  const now = Date.now();
  const cached = _alertsCache.get(promUrl);
  if (cached && now < cached.expires) {
    return cached.data;
  }

  const empty = { critical: [], warning: [], info: [], total: 0 };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    let res;
    try {
      res = await fetch(`${promUrl}/api/v1/alerts`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const data = JSON.stringify({ ...empty, error: 'prometheus_unreachable' }, null, 2);
      _alertsCache.set(promUrl, { data, expires: now + 30000 });
      return data;
    }

    const json = await res.json();
    const alerts = (json.data && json.data.alerts) || [];
    const result = { critical: [], warning: [], info: [], total: 0 };

    for (const alert of alerts) {
      if (alert.state !== 'firing') continue;
      const severity = (alert.labels && alert.labels.severity) || 'info';
      const entry = {
        name: (alert.labels && alert.labels.alertname) || 'unknown',
        host: (alert.labels && (alert.labels.instance || alert.labels.job)) || '',
        started_at: alert.activeAt || ''
      };
      if (severity === 'critical') {
        result.critical.push(entry);
      } else if (severity === 'warning') {
        result.warning.push(entry);
      } else {
        result.info.push(entry);
      }
    }
    result.total = result.critical.length + result.warning.length + result.info.length;

    const data = JSON.stringify(result, null, 2);
    _alertsCache.set(promUrl, { data, expires: now + 30000 });
    return data;
  } catch (_err) {
    const data = JSON.stringify({ ...empty, error: 'prometheus_unreachable' }, null, 2);
    _alertsCache.set(promUrl, { data, expires: now + 30000 });
    return data;
  }
}

/**
 * Plugin status — which QuoxFlow plugins are enabled and their license tier.
 * Cached 1 hour.
 * @returns {string} JSON string
 */
function generatePluginStatus() {
  const now = Date.now();
  const cached = _pluginStatusCache.get('plugin-status');
  if (cached && now < cached.expires) {
    return cached.data;
  }

  const pluginsPath = path.join(__dirname, '../../../src/config/plugins');
  const plugins = [];

  try {
    const files = fs.readdirSync(pluginsPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(pluginsPath, file), 'utf8'));
        plugins.push({
          id: raw.name || path.basename(file, '.json'),
          name: raw.displayName || raw.name || path.basename(file, '.json'),
          enabled: raw.enabled !== undefined ? raw.enabled : true,
          license_tier: raw.tier || raw.license || 'free'
        });
      } catch (_e) {
        // Skip malformed files
      }
    }
  } catch (_e) {
    // Plugins directory not available
  }

  const data = JSON.stringify({ plugins }, null, 2);
  _pluginStatusCache.set('plugin-status', { data, expires: now + 3600000 });
  return data;
}

/**
 * Audit history — last 20 AEE envelopes from the SQLite envelopes table.
 * Cached 30 seconds.
 * @param {object|null} aeeDb  better-sqlite3 database instance
 * @returns {string} JSON string
 */
function generateAuditHistory(aeeDb) {
  const now = Date.now();
  const cached = _auditHistoryCache.get('audit-history');
  if (cached && now < cached.expires) {
    return cached.data;
  }

  if (!aeeDb) {
    const data = JSON.stringify({ envelopes: [], error: 'db_unavailable' }, null, 2);
    // Don't cache the unavailable state — retry on next call
    return data;
  }

  try {
    const rows = aeeDb.prepare(
      `SELECT id, ts, type, intent, "from", "to", corr FROM envelopes ORDER BY ts DESC LIMIT 20`
    ).all();

    const data = JSON.stringify({ envelopes: rows }, null, 2);
    _auditHistoryCache.set('audit-history', { data, expires: now + 30000 });
    return data;
  } catch (_err) {
    const data = JSON.stringify({ envelopes: [], error: 'db_unavailable' }, null, 2);
    return data;
  }
}

// ============================================================================
// Resource definitions
// ============================================================================

/**
 * Build the list of MCP resource definitions.
 * @param {object} deps - { AGENT_TOOLS, agentsMap, aeeDb }
 * @returns {Array} Resource definitions for the API response
 */
function buildResourceDefs(deps = {}) {
  const promUrl = process.env.PROMETHEUS_URL || 'http://prometheus:9090';

  const resources = [
    {
      name: 'system-identity',
      uri: 'quox://system/identity',
      title: 'Quox System Identity',
      description: 'System architecture, agent hierarchy, and capability overview',
      mimeType: 'text/markdown',
      content: generateSystemIdentity(),
      live: false
    },
    {
      name: 'agent-registry',
      uri: 'quox://agents/registry',
      title: 'Agent Registry',
      description: 'All Quox agents with roles, domains, capabilities, and DEFCON levels',
      mimeType: 'application/json',
      content: generateAgentRegistry(),
      live: false
    },
    {
      name: 'tool-permissions',
      uri: 'quox://agents/tool-permissions',
      title: 'Tool Permissions (RBAC)',
      description: 'Which tools each agent is authorized to use',
      mimeType: 'application/json',
      content: generateToolPermissions(deps.AGENT_TOOLS || {}),
      live: false
    },
    {
      name: 'defcon-levels',
      uri: 'quox://system/defcon-levels',
      title: 'DEFCON Levels',
      description: 'Operational risk classification: GREEN through RED with approval requirements',
      mimeType: 'application/json',
      content: generateDefconLevels(),
      live: false
    },
    {
      name: 'fleet-topology',
      uri: 'quox://fleet/topology',
      title: 'Fleet Topology',
      description: 'Live host inventory with health, resources, and connectivity status',
      mimeType: 'application/json',
      content: generateFleetTopology(deps.agentsMap),
      live: true  // Content refreshed on each read
    },
    {
      name: 'active-alerts',
      uri: 'quox://alerts/active',
      title: 'Active Alerts',
      description: 'Currently firing Prometheus alerts grouped by severity (critical/warning/info)',
      mimeType: 'application/json',
      // generatePrometheusAlerts is async; callers that need fresh data should await it.
      // For synchronous API responses, serve cached data or empty fallback.
      get content() {
        const cached = _alertsCache.get(promUrl);
        if (cached) return cached.data;
        // Trigger async refresh without blocking; return empty skeleton for this call
        generatePrometheusAlerts(promUrl).catch(() => {});
        return JSON.stringify({ critical: [], warning: [], info: [], total: 0, error: 'loading' }, null, 2);
      },
      live: true
    },
    {
      name: 'plugin-status',
      uri: 'quox://plugins/status',
      title: 'Plugin Status',
      description: 'Which QuoxFlow plugins are enabled and their license tier',
      mimeType: 'application/json',
      content: generatePluginStatus(),
      live: true
    },
    {
      name: 'audit-history',
      uri: 'quox://audit/history',
      title: 'Audit History',
      description: 'Last 20 AEE envelopes from the audit trail (id, ts, type, intent, from, to, corr)',
      mimeType: 'application/json',
      content: generateAuditHistory(deps.aeeDb || null),
      live: true
    }
  ];

  return resources;
}

// ============================================================================
// Prompt definitions
// ============================================================================

/**
 * Build the list of MCP prompt definitions.
 * @returns {Array} Prompt definitions for the API response
 */
function buildPromptDefs() {
  return [
    {
      name: 'fleet-health',
      title: 'Fleet Health Check',
      description: 'Check infrastructure health across all or specific hosts. Returns fleet status, resource usage, and alerts.',
      arguments: [
        { name: 'hosts', description: 'Comma-separated host filter (e.g., "docker01,docker02"). Leave empty for all hosts.', required: false }
      ],
      messages: [
        {
          role: 'user',
          text: 'Run a fleet health check{{#hosts}} focusing on hosts: {{hosts}}{{/hosts}}{{^hosts}} across all managed infrastructure{{/hosts}}. Use the fleet_status tool to get current data, then summarize:\n\n1. Overall health (healthy/warning/critical counts)\n2. Resource usage highlights (any host above 80% CPU, memory, or disk)\n3. Any stale or disconnected agents\n4. Recommended actions for any issues found'
        }
      ]
    },
    {
      name: 'security-sweep',
      title: 'Security Sweep',
      description: 'Run a security audit across infrastructure. Checks for vulnerabilities, SSL certificates, and open ports.',
      arguments: [
        { name: 'scope', description: 'Audit scope: "auth" (authentication), "network" (ports/firewall), "ssl" (certificates), or "all" (comprehensive)', required: false }
      ],
      messages: [
        {
          role: 'user',
          text: 'Run a {{scope|all}} security sweep on the infrastructure. Use security_audit and ssl_certificates tools to:\n\n1. Check for known vulnerabilities\n2. Verify SSL certificate expiry dates\n3. Scan for unauthorized open ports\n4. Review authentication configurations\n5. Provide a risk summary with DEFCON level assessment\n\nPrioritize findings by severity and include remediation steps.'
        }
      ]
    },
    {
      name: 'deploy-check',
      title: 'Deployment Health Check',
      description: 'Check container and service status on a specific host. Identifies stopped services and recent errors.',
      arguments: [
        { name: 'host', description: 'Target host to check (e.g., "docker01")', required: true },
        { name: 'service', description: 'Specific service/container to focus on (optional)', required: false }
      ],
      messages: [
        {
          role: 'user',
          text: 'Check deployment health on {{host}}{{#service}} for service {{service}}{{/service}}. Use docker_status and docker_extended tools to:\n\n1. List all containers and their status (running/stopped/restarting)\n2. Check resource usage per container\n3. Look for recent error logs (last 50 lines)\n4. Identify any stopped or unhealthy containers\n5. Report uptime and restart counts\n\nFlag any containers that need attention.'
        }
      ]
    },
    {
      name: 'defcon-assess',
      title: 'DEFCON Assessment',
      description: 'Assess the risk level of a proposed operation and determine what approval is needed.',
      arguments: [
        { name: 'operation', description: 'Description of the proposed operation', required: true }
      ],
      messages: [
        {
          role: 'user',
          text: 'Assess the DEFCON level for this proposed operation: "{{operation}}"\n\nUsing the Quox DEFCON classification system:\n- GREEN (Level 5): Safe, auto-run — status queries, metric lookups\n- BLUE (Level 4): Low risk, auto-run with logging — single-host queries, analysis\n- AMBER (Level 3): Medium risk, needs confirmation — multi-host ops, VM operations\n- YELLOW (Level 2.5): Elevated risk, confirmation + audit — bulk operations, network changes\n- ORANGE (Level 2): High risk, explicit approval — production changes, data modifications\n- RED (Level 1): Critical, manual only — firewall changes, key rotations, destructive ops\n\nProvide:\n1. Assigned DEFCON level with justification\n2. Required approval type\n3. Potential blast radius\n4. Recommended safeguards or pre-checks\n5. Rollback strategy if the operation fails'
        }
      ]
    },
    {
      name: 'incident-triage',
      title: 'Incident Triage',
      description: 'Given an alert or outage description, diagnose the incident by correlating alerts, metrics, logs, and recent changes; then suggest remediation steps.',
      arguments: [
        { name: 'description', description: 'Description of the alert or outage (e.g., "high CPU on docker01, response times spiking")', required: true },
        { name: 'host', description: 'Primary affected host or service (optional — narrows scope)', required: false }
      ],
      messages: [
        {
          role: 'user',
          text: 'Triage the following incident{{#host}} on host {{host}}{{/host}}:\n\n"{{description}}"\n\nWork through these steps systematically:\n\n1. **Baseline — get current state.**\n   Call `fleet_status`{{#host}} filtering to {{host}}{{/host}} to check CPU, memory, disk, and connectivity. Note any hosts already in warning or critical state.\n\n2. **Correlate with active alerts.**\n   Call `prometheus_query` with `ALERTS{alertstate="firing"}` to see every currently firing alert. Group by severity. Cross-reference alert labels (instance, job, severity) against the incident description. Identify whether this is an isolated spike or part of a wider pattern.\n\n3. **Pull relevant metrics.**\n   For the affected service, run targeted `prometheus_query` calls:\n   - CPU: `100 - (avg by (instance) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`\n   - Memory: `(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100`\n   - Network error rate if applicable\n   - Process-specific metrics if the incident names a service\n   Report p50/p95/p99 if range data is available.\n\n4. **Inspect containers and processes.**\n   Call `docker_status`{{#host}} on {{host}}{{/host}} to list container states, restart counts, and last exit codes. Flag any container that has restarted more than 3 times in the last 10 minutes or is in a non-running state.\n\n5. **Check recent changes — the #1 cause of incidents.**\n   Call `git_log_recent`{{#host}} on {{host}}{{/host}} to surface deployments or config changes in the last 2 hours. If a deploy timestamp correlates with incident onset, flag it as the probable cause.\n\n6. **Execute targeted diagnostic commands.**\n   Use `ssh_exec`{{#host}} on {{host}}{{/host}} to run:\n   - `journalctl -u <service> --since "30 minutes ago" --no-pager | tail -100` for the affected service logs\n   - `dmesg | tail -50` for kernel-level issues (OOM killer, disk errors)\n   - `netstat -tlnp` or `ss -tlnp` if network connectivity is suspect\n\n7. **Synthesize and recommend.**\n   Produce a structured triage report:\n   - **Probable root cause** (with evidence links to the data gathered above)\n   - **Blast radius** (what else is at risk if this escalates)\n   - **Immediate mitigation** (safe, low-DEFCON steps to stop the bleeding now)\n   - **Permanent fix** (what needs changing to prevent recurrence)\n   - **DEFCON classification** of each recommended action\n   - **Escalation trigger** (conditions under which a human must intervene immediately)\n\nDo not skip steps even if early findings look definitive — multi-factor incidents are common.'
        }
      ]
    },
    {
      name: 'config-audit',
      title: 'Configuration Audit',
      description: 'Verify configuration consistency across matching hosts; flag drift, outdated packages, and insecure defaults.',
      arguments: [
        { name: 'host_pattern', description: 'Host name prefix or glob to match (e.g., "docker", "pve", "all")', required: true },
        { name: 'categories', description: 'Comma-separated audit categories: "security", "packages", "disks", "services". Leave empty for all.', required: false }
      ],
      messages: [
        {
          role: 'user',
          text: 'Run a configuration audit across hosts matching "{{host_pattern}}"{{#categories}}, focusing on categories: {{categories}}{{/categories}}.\n\nWork through these steps:\n\n1. **Enumerate hosts.**\n   Call `fleet_status` and filter to hosts whose hostname starts with or matches "{{host_pattern}}". Build the target list. If "all" is specified, include every connected host. Log the final list before proceeding.\n\n2. **Collect system state.**\n   For each host in the target list, call `ssh_exec` to gather:\n   - OS version: `lsb_release -a 2>/dev/null || cat /etc/os-release`\n   - Kernel: `uname -r`\n   - Last reboot: `who -b`\n   - Timezone: `timedatectl show --property=Timezone --value`\n   Build a comparison table. Flag any host that differs from the majority on OS version or kernel.\n\n3. **Package audit{{#categories}} (if "packages" in categories){{/categories}}.**\n   Call `package_audit` on each host to check:\n   - Number of pending security updates\n   - Any package held back from auto-update\n   - End-of-life package versions (especially OpenSSL, curl, libssl)\n   Flag hosts with >10 pending updates or any known-CVE packages.\n\n4. **Security baseline{{#categories}} (if "security" in categories){{/categories}}.**\n   Call `security_audit` on each host or use `ssh_exec` to check:\n   - SSH config: `grep -E "PermitRootLogin|PasswordAuthentication|Port" /etc/ssh/sshd_config`\n   - Firewall status: `ufw status verbose` or `iptables -L -n --line-numbers | head -40`\n   - World-writable files: `find /etc /usr/bin /usr/sbin -perm -o+w -not -type l 2>/dev/null | head -20`\n   - SUID/SGID binaries changed in last 30 days: `find / -perm /6000 -newer /etc/passwd 2>/dev/null`\n   Flag any host that allows root login, password auth, or has an inactive firewall.\n\n5. **Disk health{{#categories}} (if "disks" in categories){{/categories}}.**\n   Use `ssh_exec` to run `df -h` and `smartctl -a /dev/sda 2>/dev/null | grep -E "Reallocated|Pending|Uncorrectable|Temperature"` on each host. Flag any filesystem above 80% usage or any SMART attribute outside healthy range.\n\n6. **Report — drift matrix.**\n   Produce a table with one row per host and columns for: OS version, kernel, pending updates, root-login-allowed, firewall-active, disk-usage-max. Mark deviating cells. Conclude with:\n   - **Drift summary**: which hosts are out of the baseline configuration\n   - **Critical findings**: issues requiring immediate remediation\n   - **Recommended actions**: ordered by severity, with DEFCON level for each'
        }
      ]
    },
    {
      name: 'backup-verify',
      title: 'Backup Verification',
      description: 'Validate backup integrity across Proxmox and Docker volumes; report snapshot age, coverage gaps, and restore testability.',
      arguments: [
        { name: 'scope', description: 'What to check: "proxmox" (VMs/CTs only), "docker" (volumes only), or "all" (default)', required: false }
      ],
      messages: [
        {
          role: 'user',
          text: 'Run a backup verification sweep. Scope: {{scope|all}}.\n\n1. **Proxmox snapshots{{#scope}} (skip if scope is "docker"){{/scope}}.**\n   Call `proxmox_backup_list` to retrieve all VM and container backups across hyp-01-hyp-07. For each node:\n   - List backups by VMID with `volid`, `ctime`, `size`, and `format`\n   - Identify VMs/CTs with no backup in the last 24 hours\n   - Identify VMs/CTs with no backup at all (compare against active VM list)\n   - Flag any backup older than 48 hours as a gap\n   - Check whether offsite/PBS copies exist (storage name contains "pbs" or "remote")\n\n2. **Docker volumes{{#scope}} (skip if scope is "proxmox"){{/scope}}.**\n   Call `docker_volume_list` on each Docker host (docker01-04) to enumerate named volumes and their associated containers. Then use `ssh_exec` to check:\n   - Which volumes are bind-mounted vs. managed volumes\n   - Whether any backup agent (restic, borgbackup, velero) is present: `which restic borg 2>/dev/null`\n   - Last backup timestamp if a `.backup_last_run` sentinel file exists in `/var/lib/docker-backup/`\n   Flag any stateful volume with no backup mechanism.\n\n3. **Restic repository integrity{{#scope}} (if scope is "all" or restic is found){{/scope}}.**\n   Call `restic_check` on each configured repository to run `restic check --read-data-subset=1%`. A non-zero exit code means repository corruption. Report:\n   - Repository path\n   - Last snapshot timestamp\n   - Check result (healthy / corrupted / unreachable)\n\n4. **Restore testability assessment.**\n   For the 3 most critical VMs (quox-core-dev, auth service host, database host), confirm:\n   - Latest backup exists and is <24h old\n   - Backup file size is non-zero\n   - Estimated restore time (size / typical restore rate of ~100 MB/s)\n\n5. **Coverage report.**\n   Produce a final table: Host/VMID | Last Backup | Age | Offsite | Restore Tested. Summarize coverage percentage and list all gaps with recommended actions to close them.'
        }
      ]
    }
  ];
}

/** Test helper — clear all resource caches. Not for production use. */
function __clearResourceCaches() {
  _alertsCache.clear();
  _pluginStatusCache.clear();
  _auditHistoryCache.clear();
}

module.exports = {
  buildResourceDefs,
  buildPromptDefs,
  generateSystemIdentity,
  generateAgentRegistry,
  generateToolPermissions,
  generateDefconLevels,
  generateFleetTopology,
  generatePrometheusAlerts,
  generatePluginStatus,
  generateAuditHistory,
  __clearResourceCaches
};
