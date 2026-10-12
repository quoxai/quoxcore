import MarkdownPage from './MarkdownPage'
import content from '../../../docs/QuoxAgent.md?raw'

// Beginner-friendly intro content prepended to the technical docs
const beginnerIntro = `
## What is QuoxAgent?

QuoxAgent stands for **QuoxCORE Helper Agent**. It is a lightweight program that runs on each server in your infrastructure, acting as QuoxCORE's eyes, ears, and hands on that machine.

**Think of it this way:** Imagine you are the captain of a large ship, but you cannot be everywhere at once. So you station a trusted crew member on each deck - someone who watches for problems, reports back immediately, and can carry out your orders on the spot. That is what QuoxAgent does for your servers.

Each QuoxAgent agent is like a **scout stationed at an outpost**. It is small, quiet, and always ready. When QuoxCORE needs information or wants to take action, your scouts are already there, waiting to help.

---

## Why QuoxAgent Changes Everything

Without QuoxAgent, managing servers is like sending messages by carrier pigeon - you have to establish a new SSH connection each time, wait for authentication, and hope everything works. With QuoxAgent, you have a **direct radio link** to every machine in your fleet.

### Before QuoxAgent

- Open SSH connection (2-3 seconds)
- Authenticate (1-2 seconds)
- Run command
- Close connection
- Repeat for every server, every time

### After QuoxAgent

- QuoxCORE says "go"
- Scout responds **instantly**
- Results stream back in real-time

| Capability | Without QuoxAgent | With QuoxAgent |
|------------|-------------|----------|
| Response time | 3-5 seconds | 10-50 milliseconds |
| Real-time monitoring | Poll-based | Continuous heartbeat |
| Fleet visibility | Query each host | Dashboard overview |
| Session tracking | Not available | Full agent activity |
| Parallel commands | Sequential SSH | Simultaneous execution |

---

## How It Works

Here is the architecture in simple terms:

\`\`\`
                    Your Browser
                         |
                         v
              +-------------------+
              |  QuoxCORE Dashboard |
              +-------------------+
                         |
                         v
              +-------------------+
              |  QuoxAgent Collector     |  <-- Central command hub (port 9848)
              |  (Your main host)  |
              +-------------------+
                    /    |    \\
           heartbeat  heartbeat  heartbeat
              /         |          \\
             v          v           v
      +----------+ +----------+ +----------+
      | QuoxAgent Scout| | QuoxAgent Scout| | QuoxAgent Scout|   <-- Agents on each server
      | docker01 | | docker02 | | kuma01   |       (port 9847)
      +----------+ +----------+ +----------+
\`\`\`

**The flow:**

1. **Scouts check in** - Every 30 seconds, each QuoxAgent agent sends a heartbeat to the Collector: "I am alive, here is my status"
2. **Collector tracks everyone** - The Collector maintains a live map of all your servers and their health
3. **You give commands** - When you ask QuoxCORE to do something on a server, it talks directly to that server's scout
4. **Scouts report back** - Results, logs, and metrics flow back instantly through the Collector to your dashboard

---

## Installation: It Takes 30 Seconds

Installing QuoxAgent on any server is a single command. No packages to install, no dependencies to manage.

### Quick Install (on any server you want to manage)

\`\`\`bash
curl -sSL http://10.0.0.126:9848/install | sudo bash -s -- --host-id $(hostname)
\`\`\`

That is it. The command:
1. Downloads the QuoxAgent binary for your architecture
2. Creates a systemd service
3. Configures the agent with your Collector's address
4. Starts the service immediately

Within seconds, the new server appears in your QuoxCORE dashboard.

### Deploy Multiple Servers from QuoxCORE

Already have SSH access configured? Deploy QuoxAgent to multiple hosts at once:

\`\`\`bash
# Check QuoxAgent status on specific hosts
quoxagent-deploy --check kuma01 gw-01 docker01

# Install QuoxAgent on specific hosts
quoxagent-deploy kuma01 gw-01

# Install QuoxAgent on ALL known hosts at once
quoxagent-deploy all

# Remove QuoxAgent from a host
quoxagent-deploy --uninstall docker03
\`\`\`

### Verify Installation

After installing, confirm your scout is reporting in:

\`\`\`bash
# On the server itself
systemctl status quoxagent

# From your QuoxCORE host
curl -s http://10.0.0.126:9848/api/v1/agents | jq '.[] | .host_id'
\`\`\`

---

## What Your Scouts Can Do

Once installed, each QuoxAgent agent enables:

### Real-Time Health Monitoring
Your dashboard shows which servers are healthy, degraded, or offline - updated every 30 seconds without any polling from your side.

### Execute Commands Instantly
Run any command on any server through QuoxCORE. No SSH delays, no connection timeouts.

### Track AI Agent Activity
The Universal Agent Monitor (UAM) shows all Claude, GPT, or Ollama sessions running across your fleet in real-time. See what your AI agents are working on, which files they are modifying, and how much they are costing.

### Collect Metrics
CPU usage, memory, disk space, running processes - all collected and reported automatically.

---

## Troubleshooting

### QuoxAgent not appearing in dashboard

**Check if the service is running:**
\`\`\`bash
systemctl status quoxagent
\`\`\`

**Check if it can reach the Collector:**
\`\`\`bash
curl -v http://10.0.0.126:9848/health
\`\`\`

**Check the QuoxAgent logs:**
\`\`\`bash
journalctl -u quoxagent -f --no-pager
\`\`\`

### QuoxAgent shows as "stale" or "offline"

This means the Collector has not received a heartbeat recently. Common causes:

- **Network issue:** The server cannot reach your Collector host
- **Firewall blocking port 9848:** Ensure outbound connections are allowed
- **QuoxAgent service stopped:** Run \`systemctl start quoxagent\`
- **Wrong Collector URL in config:** Check \`/etc/quoxagent/quoxagent.yaml\`

### Permission denied during install

The install script requires sudo to:
- Copy the binary to \`/usr/local/bin/\`
- Create the systemd service file
- Set up the \`/etc/quoxagent/\` configuration directory

Run the curl command with \`sudo\` as shown in the examples above.

### Updating QuoxAgent to a new version

\`\`\`bash
# Stop the service
sudo systemctl stop quoxagent

# Re-run the install (it will replace the binary)
curl -sSL http://10.0.0.126:9848/install | sudo bash -s -- --host-id $(hostname)

# The service auto-starts after install
\`\`\`

---

## Fleet Power: What You Can Build

With QuoxAgent deployed across your infrastructure, you unlock powerful fleet-wide capabilities:

### One Command, Many Servers
\`\`\`
"Update nginx configuration on all web servers"
\`\`\`
QuoxCORE identifies your web servers and executes the update in parallel through each scout.

### Fleet-Wide Health Dashboard
See CPU, memory, and disk usage across 50 servers at a glance. Spot the one server running hot before it becomes a problem.

### Universal Agent Monitor
Every AI coding session, every Claude agent, every GPT call - visible in one stream. Know what your AI fleet is doing at all times.

### Instant Incident Response
When something breaks at 2 AM, you do not SSH into 20 servers looking for the problem. Your scouts are already watching, and QuoxCORE knows exactly which host is misbehaving.

---

> **The bottom line:** Every server with QuoxAgent installed becomes a smarter, more connected part of your infrastructure. The more scouts you deploy, the more powerful your QuoxCORE becomes. Start with one or two servers to see the difference, then deploy to your entire fleet.

---

`;

export default function QuoxAgentPage() {
  return (
    <MarkdownPage
      content={beginnerIntro + content}
      title="QuoxAgent: Your Fleet of Scouts"
      lead="QuoxAgent (QuoxCORE Helper Agent) places a lightweight scout on each server in your infrastructure. These agents report back continuously, execute commands instantly, and transform your servers into a unified, responsive fleet."
    />
  )
}
