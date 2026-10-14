# QuoxCORE Architecture - Comprehensive Plan

## Current State Audit

### What Works
- Dashboard loads and displays 50 hosts from inventory
- Chat endpoint (`/webhook/chat`) works - sends prompts to Claude on gw-01
- Tab-based UI with SOC/NOC separation
- Session continuity via session_id

### What's Broken
1. **Activity Feed** - Chat workflow doesn't log activity (missing file write)
2. **Quick Actions** - Fire-and-forget with no visual feedback
3. **No Intelligence** - Claude on gw-01 has zero context about infrastructure

### Root Cause Analysis
Claude on gw-01 is a **generic Claude instance** with:
- No CLAUDE.md (infrastructure knowledge)
- No MCP servers (tool access)
- No awareness of other hosts
- No orchestration capabilities

When you ask "How's my rack?", Claude literally doesn't know:
- What hosts exist
- How to check them
- What "the rack" means

---

## Future Architecture Vision

### The QuoxCORE Hierarchy

```
                          ┌─────────────────────────────┐
                          │      QuoxCORE MASTER         │
                          │    (Orchestrator Agent)     │
                          │                             │
                          │  - Knows entire inventory   │
                          │  - Routes to specialists    │
                          │  - Aggregates results       │
                          │  - Maintains context        │
                          └─────────────┬───────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
    ┌─────────▼─────────┐    ┌─────────▼─────────┐    ┌─────────▼─────────┐
    │   NOC MANAGER     │    │   SOC MANAGER     │    │  DEVOPS MANAGER   │
    │                   │    │                   │    │                   │
    │ - Infrastructure  │    │ - Security focus  │    │ - CI/CD, Deploy   │
    │ - Health checks   │    │ - Threat detect   │    │ - Containers      │
    │ - Performance     │    │ - Compliance      │    │ - Automation      │
    └─────────┬─────────┘    └─────────┬─────────┘    └─────────┬─────────┘
              │                         │                         │
    ┌─────────▼─────────┐    ┌─────────▼─────────┐    ┌─────────▼─────────┐
    │    ASSISTANTS     │    │    ASSISTANTS     │    │    ASSISTANTS     │
    │                   │    │                   │    │                   │
    │ - Proxmox Agent   │    │ - Wazuh Agent     │    │ - Docker Agent    │
    │ - Network Agent   │    │ - Firewall Agent  │    │ - Git Agent       │
    │ - Backup Agent    │    │ - Auth Agent      │    │ - Build Agent     │
    └───────────────────┘    └───────────────────┘    └───────────────────┘
              │                         │                         │
              └─────────────────────────┼─────────────────────────┘
                                        │
                          ┌─────────────▼─────────────┐
                          │        TOOLS LAYER        │
                          │                           │
                          │  - SSH to any host        │
                          │  - API integrations       │
                          │  - Scripts library        │
                          │  - MCP servers            │
                          └───────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Foundation Fixes (Immediate)
**Goal**: Make current system functional

1. **Fix Activity Logging**
   - Update chat workflow to write activity to JSON file
   - Activity feed will populate

2. **Quick Action Feedback**
   - Show real-time output in dedicated panel
   - Visual status indicators (running/success/error)
   - Output appears in chat or modal

3. **Basic Context Injection**
   - Pass inventory to Claude with each request
   - System prompt explaining what QuoxCORE can do

### Phase 2: Context-Aware QuoxCORE (Week 1-2)
**Goal**: Claude knows about the infrastructure

1. **Create CLAUDE.md for gw-01**
   ```markdown
   # QuoxCORE Infrastructure Context

   You are QuoxCORE, the master orchestrator for Adam's rack infrastructure.

   ## Your Capabilities
   - SSH to any host in the inventory
   - Run health checks across systems
   - Monitor security status
   - Execute maintenance tasks

   ## Infrastructure Overview
   - 6 Proxmox nodes (hyp-01 to hyp-06)
   - 50 total hosts/VMs
   - Monitoring: Prometheus, Grafana, Wazuh
   - Security: Kali, Security Onion

   ## Available Commands
   - `ping_all_hosts.sh` - Check connectivity
   - `health_check.sh` - System health summary
   - `security_scan.sh` - Quick security audit
   ```

2. **Pre-flight Context Injection**
   - n8n workflow fetches inventory before Claude request
   - Injects host list into system prompt
   - Claude knows what's available

3. **Result Aggregation**
   - Claude can SSH to multiple hosts
   - Results combined into coherent response

### Phase 3: Multi-Agent Architecture (Week 2-4)
**Goal**: Specialized agents for different domains

1. **NOC Agent**
   - Specialized prompts for infrastructure
   - Health check tools
   - Performance monitoring
   - Runs on hyp-01 or dedicated VM

2. **SOC Agent**
   - Security-focused prompts
   - Threat detection workflows
   - Compliance checking
   - Runs on kali or wazuh01

3. **Agent Router**
   - QuoxCORE Master decides which agent to use
   - Routes based on query intent
   - Aggregates multi-agent responses

### Phase 4: Tool Integration (Week 4-6)
**Goal**: Direct API access, not just SSH

1. **MCP Servers**
   - Proxmox API server
   - Wazuh API server
   - Docker API server
   - Custom script execution

2. **Script Library**
   ```
   /tools/
   ├── health/
   │   ├── ping_all.sh
   │   ├── disk_check.sh
   │   └── service_status.sh
   ├── security/
   │   ├── auth_audit.sh
   │   ├── firewall_check.sh
   │   └── vuln_scan.sh
   └── maintenance/
       ├── backup_status.sh
       ├── update_check.sh
       └── log_rotate.sh
   ```

3. **n8n Workflow Library**
   - Pre-built workflows for common tasks
   - Triggered by QuoxCORE
   - Results fed back

### Phase 5: Intelligence Layer (Week 6-8)
**Goal**: Proactive monitoring and learning

1. **Scheduled Health Checks**
   - Automatic daily/hourly checks
   - Anomaly detection
   - Alert generation

2. **Knowledge Base**
   - History of issues and resolutions
   - Infrastructure documentation
   - Runbooks for common problems

3. **Incident Response**
   - Automatic playbook execution
   - Escalation rules
   - Post-incident reports

### Phase 6: Department Expansion (Ongoing)
**Goal**: Extend to other business areas

1. **Marketing Tab**
   - Website analytics
   - SEO monitoring
   - Content automation

2. **Accounts Tab**
   - Invoice generation
   - Financial reports
   - Budget tracking

3. **Custom Departments**
   - Plugin architecture for new tabs
   - Department-specific agents
   - Custom workflows

---

## Technical Implementation Details

### Immediate Fix: Activity Logging

```javascript
// Updated chat workflow - Parse & Log node
const fs = require('fs');
const cmdData = $('Build Command').first().json;
const sshOutput = $input.first().json;

// Parse response...

// Log activity
const activityFile = '/home/node/.n8n/quox-activity.json';
let activity = [];
try {
  if (fs.existsSync(activityFile)) {
    activity = JSON.parse(fs.readFileSync(activityFile, 'utf8'));
  }
} catch (e) { activity = []; }

activity.push({
  id: Date.now().toString(36),
  timestamp: new Date().toISOString(),
  host: cmdData.targetHost || 'gw-01',
  prompt: cmdData.originalPrompt.substring(0, 100),
  success: response.success,
  cost_usd: response.cost_usd || 0
});

if (activity.length > 500) activity = activity.slice(-500);
fs.writeFileSync(activityFile, JSON.stringify(activity, null, 2));

return [{ json: response }];
```

### Context-Aware Prompt Template

```javascript
// Before sending to Claude, inject context
const inventory = await fetchInventory();
const systemPrompt = `
You are QuoxCORE, the master orchestrator for this infrastructure.

## Current Infrastructure Status
${inventory.map(h => `- ${h.hostname} (${h.ip_address}) - ${h.category}`).join('\n')}

## Your Capabilities
- SSH to any host using: ssh ${host.ssh_user}@${host.ip_address}
- Run system commands
- Check health and status
- Coordinate multi-host operations

## When asked about "the rack" or "infrastructure"
Provide a comprehensive overview by checking multiple relevant hosts.
`;

const fullPrompt = systemPrompt + '\n\nUser Query: ' + userPrompt;
```

### Quick Action with Visual Feedback

```jsx
// QuickActions component with output display
function QuickActions({ onAction }) {
  const [output, setOutput] = useState(null);
  const [loading, setLoading] = useState(false);

  const executeAction = async (action) => {
    setLoading(true);
    setOutput({ status: 'running', action: action.label });

    try {
      const result = await onAction(action.prompt);
      setOutput({
        status: 'success',
        action: action.label,
        result: result.result,
        cost: result.cost_usd
      });
    } catch (e) {
      setOutput({ status: 'error', message: e.message });
    }
    setLoading(false);
  };

  return (
    <div className="quick-actions">
      {/* Action buttons */}
      {output && <ActionOutput output={output} />}
    </div>
  );
}
```

---

## Dashboard UI Improvements

### Quick Action Output Panel
- Real-time streaming output
- Expandable/collapsible results
- Copy to clipboard
- History of recent actions

### Activity Feed Enhancements
- Real-time updates via polling/websocket
- Filterable by host, status, time
- Expandable entries with full details
- Cost tracking and daily totals

### SOC/NOC Tab Improvements
- Live status indicators for relevant hosts
- Alert badges for issues
- Quick filters by severity
- Drill-down to individual hosts

---

## File Structure (Target)

```
/opt/quox/
├── dashboard/                 # React dashboard (current)
├── agents/
│   ├── master/               # QuoxCORE master agent config
│   ├── noc/                  # NOC manager agent
│   ├── soc/                  # SOC manager agent
│   └── assistants/           # Specialized assistants
├── tools/
│   ├── scripts/              # Bash/Python scripts
│   ├── mcp/                  # MCP server configs
│   └── workflows/            # n8n workflow exports
├── knowledge/
│   ├── inventory.csv         # Host inventory
│   ├── runbooks/             # Operational procedures
│   └── history/              # Issue history
└── config/
    ├── claude.md             # Master context file
    └── settings.json         # Configuration
```

---

## Success Metrics

### Phase 1 Complete When:
- [ ] Activity feed shows real-time data
- [ ] Quick actions show output
- [ ] Chat responds with infrastructure awareness

### Phase 2 Complete When:
- [ ] "How's my rack?" returns multi-host summary
- [ ] Claude knows all 50 hosts
- [ ] Context persists across sessions

### Phase 3 Complete When:
- [ ] SOC agent handles security queries
- [ ] NOC agent handles infrastructure queries
- [ ] Master routes appropriately

### Phase 4 Complete When:
- [ ] Direct Proxmox API integration
- [ ] Wazuh alerts in dashboard
- [ ] Script library accessible

---

## Estimated Timeline

| Phase | Duration | Key Deliverable |
|-------|----------|-----------------|
| 1     | 1-2 days | Working activity + quick actions |
| 2     | 1 week   | Context-aware Claude |
| 3     | 2 weeks  | Multi-agent routing |
| 4     | 2 weeks  | API/Tool integration |
| 5     | 2 weeks  | Proactive monitoring |
| 6     | Ongoing  | Department expansion |

---

## Next Immediate Steps

1. **Fix activity logging in chat workflow**
2. **Add output panel for quick actions**
3. **Create CLAUDE.md with infrastructure context**
4. **Inject inventory into system prompt**
5. **Test "How's my rack?" query**
