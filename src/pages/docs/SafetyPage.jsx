import MarkdownPage from './MarkdownPage'

// User-friendly safety documentation that positions safety as a feature
const content = `
## Why Safety Matters

When AI manages real infrastructure, the stakes are high. A misunderstood command could restart production services, a misconfigured script could affect dozens of servers, or a simple typo could cascade into an outage.

**QuoxCORE's safety system exists so you can confidently delegate to AI** knowing that guardrails are in place. You get the speed and intelligence of AI automation while retaining complete control over what actually happens.

> **The philosophy:** Safety is not about limiting what QuoxCORE can do. It is about giving you confidence to let it do more. The better the guardrails, the more you can trust automation to handle.

---

## You Are Always in Control

QuoxCORE's safety architecture is built on one principle: **nothing happens without your awareness and consent**. Here is how that works in practice:

### The Kill Switch

A single button stops everything. Immediately.

| Feature | Description |
|---------|-------------|
| **Global Kill Switch** | One click halts all running workflows and blocks new ones |
| **Instant effect** | No waiting, no graceful shutdown - immediate stop |
| **Dashboard access** | Always visible in the top bar, always one click away |
| **Recoverable** | Turn it back on when you are ready, nothing is lost |

Think of it like an emergency stop button in a factory. You hope you never need it, but knowing it is there lets you work with confidence.

### Dry-Run Mode

Not sure what a command will do? Run it in preview mode first.

In dry-run mode, QuoxCORE plans and analyzes but does not execute. You see exactly what would happen without any actual changes to your infrastructure.

| What you get | What happens |
|--------------|--------------|
| Full command list | See every command that would run |
| Target hosts | Know exactly which servers are affected |
| Expected outcomes | Understand the intended result |
| Risk assessment | Review potential issues before committing |

**When to use dry-run:**
- Testing new workflows before going live
- Reviewing AI-generated plans before approval
- Training new team members safely
- Auditing what automation would do

---

## DEFCON Safety Levels

QuoxCORE uses a DEFCON-style system to classify operations by risk. Higher numbers are safer (just like the real DEFCON scale).

### Level Overview

| Level | Name | What happens | Use cases |
|-------|------|--------------|-----------|
| **5** | GREEN | Runs automatically | Health checks, status queries, log collection |
| **4** | BLUE | Runs automatically, logged | Single-host reads, metrics gathering |
| **3** | AMBER | Plan created, you approve | Service restarts, config updates |
| **2** | ORANGE | Plan created, two people approve | Production changes, deployments |
| **1** | RED | Manual only | Firewall rules, SSH keys, destructive operations |

### How Levels Work

**GREEN and BLUE (Automatic):** These are read-only or low-risk operations. QuoxCORE handles them without interrupting you. Perfect for monitoring, reporting, and routine health checks.

**AMBER (You Approve):** Before anything runs, you see a plan with full details. One click to approve, one click to reject. The workflow waits as long as needed for your decision.

**ORANGE (Two-Person Rule):** Critical operations require two approvers. This prevents any single person (or the AI) from making high-impact changes alone.

**RED (Manual Override):** Some operations are too sensitive for automation. QuoxCORE will not even attempt them. You must do these yourself, deliberately and carefully.

### Configuring Your Safety Level

You can adjust the default DEFCON level based on your comfort and needs:

\`\`\`javascript
// In your QuoxCORE settings
{
  "default_defcon": 4,     // Start at BLUE for most operations
  "require_approval_below": 3,  // Require approval at AMBER and below
  "two_person_below": 2,   // Require 2 approvers at ORANGE and below
  "disabled_below": 1      // Disable automation at RED
}
\`\`\`

**Recommendation for new users:** Start at DEFCON 3 (AMBER). This means you approve most operations while still getting AI assistance with planning. As you build confidence, you can shift to DEFCON 4 or 5 for routine tasks.

---

## What Gets Blocked (and Why)

QuoxCORE maintains a denylist of commands that are never executed automatically, regardless of DEFCON level. These require explicit manual action.

### Always Blocked

| Command pattern | Why it is blocked |
|-----------------|-------------------|
| \`rm -rf /\` | Could wipe entire filesystem |
| \`dd if=\` | Direct disk writes, data destruction risk |
| \`mkfs.\` | Filesystem formatting, irreversible |
| \`iptables -F\` | Could lock you out of servers |
| \`chmod -R 777\` | Security nightmare, opens everything |
| \`:(){:|:&};:\` | Fork bomb, crashes the system |
| \`shutdown\`, \`reboot\` | Service disruption without approval |

### Blocked Without Explicit Confirmation

| Action | Risk | How to proceed |
|--------|------|----------------|
| Affecting more than 5 hosts | Blast radius | Must confirm multi-host operation |
| Deleting configuration files | Hard to recover | Requires backup verification |
| Modifying SSH keys | Lockout risk | RED level, manual only |
| Changing firewall rules | Network access | RED level, manual only |
| Database operations | Data integrity | Requires explicit scope |

### Example: What Happens When Something Is Blocked

Say you ask QuoxCORE to "clean up old logs on all servers." Here is what happens:

1. QuoxCORE plans the operation
2. Detects it affects more than 5 hosts
3. **Pauses** and asks: "This will affect 47 hosts. Please confirm multi-host operation."
4. You review the exact command and host list
5. Only after your confirmation does it proceed

Nothing surprising. Nothing hidden. You see everything before it happens.

---

## Approval Workflows

For AMBER and higher-risk operations, QuoxCORE uses a structured approval flow.

### How Approvals Work

\`\`\`
You request an action
       ↓
QuoxCORE creates a plan
       ↓
Plan appears in your Approval Queue
       ↓
You review: commands, targets, expected outcome
       ↓
Approve → Executes
Reject → Cancelled, nothing happens
\`\`\`

### What You See in an Approval Request

| Field | Example |
|-------|---------|
| **Action** | Restart nginx on web servers |
| **Target hosts** | web01, web02, web03 |
| **Commands** | \`systemctl restart nginx\` |
| **Reason** | Memory leak detected in logs |
| **Risk level** | AMBER |
| **Rollback plan** | \`systemctl restart nginx\` (service will auto-recover) |

### Approval Queue Features

- **Mobile friendly** - Approve from your phone via Slack, Telegram, or email
- **Time limits** - Set expiration for time-sensitive approvals
- **Escalation** - Auto-escalate to backup approver if you are unavailable
- **Audit trail** - Every approval/rejection is logged with timestamp and approver

---

## Staged Rollouts (Canary Deployments)

For multi-host operations, QuoxCORE uses staged rollouts to catch problems early.

### How It Works

Instead of running on all hosts at once, QuoxCORE deploys in waves:

| Wave | Hosts | Wait time | What happens |
|------|-------|-----------|--------------|
| 1 | 1 host | 1 minute | Test on a single canary |
| 2 | 3 hosts | 2 minutes | Small batch verification |
| 3 | 10 hosts | 3 minutes | Medium batch |
| 4 | Remaining | - | Full rollout |

**After each wave:** QuoxCORE checks health. If anything fails, the rollout stops immediately. No cascade failures.

### Example Scenario

You want to update a package on 50 servers:

1. **Wave 1:** Updates \`server-01\`. Waits. Checks health. All good.
2. **Wave 2:** Updates \`server-02\`, \`server-03\`, \`server-04\`. Checks health. All good.
3. **Wave 3:** Updates 10 more servers. Checks health. \`server-12\` fails health check.
4. **Stops immediately.** 36 servers untouched. You investigate \`server-12\`.
5. **Your decision:** Fix the issue and resume, or roll back the 14 affected servers.

You caught a problem at 28% instead of discovering it after 100%.

---

## Audit Trail

Every action QuoxCORE takes is recorded. Nothing is hidden or lost.

### What Gets Logged

| Event | Details recorded |
|-------|------------------|
| Command execution | Full command, target host, exit code, output |
| Approval decisions | Who approved/rejected, when, any notes |
| Blocks and denials | What was blocked, why, who requested it |
| Configuration changes | Before and after states, who changed it |
| Safety events | Kill switch activations, DEFCON changes |

### Accessing the Audit Log

- **Dashboard:** View recent actions in the Activity feed
- **API:** Query the full audit log programmatically
- **Export:** Download logs for compliance or analysis

### Retention

Audit logs are retained for 90 days by default. Critical events (approvals, blocks, safety activations) are retained indefinitely.

---

## Preflight and Postflight Checks

QuoxCORE verifies conditions before and after every operation.

### Before Running (Preflight)

| Check | Purpose |
|-------|---------|
| Host reachable | Can we connect? |
| SSH working | Authentication valid? |
| Disk space | At least 10% free? |
| Load average | System not overloaded? |
| Recent backup | Backup within 24 hours? |

If any check fails, the operation is paused and you are notified. No surprises.

### After Running (Postflight)

| Check | Purpose |
|-------|---------|
| Service healthy | Did the target service come back up? |
| Ports responding | Are expected ports open? |
| No new errors | Any new errors in logs? |
| Connectivity | Can the host reach what it needs to? |

If postflight checks fail, QuoxCORE can automatically trigger rollback (if configured) or alert you for manual intervention.

---

## Best Practices

### For New Users

1. **Start with DEFCON 3 (AMBER)** - Approve everything until you trust the system
2. **Enable dry-run for new workflows** - Preview before committing
3. **Review the audit log regularly** - Understand what QuoxCORE does
4. **Set up mobile notifications** - Stay informed even when away from your desk

### For Production Environments

1. **Use two-person approval for production** - No single point of failure
2. **Enable staged rollouts** - Catch problems early
3. **Configure escalation policies** - Approvals should not block on one person
4. **Set up backup approvers** - Coverage during time off

### For High-Security Environments

1. **Set DEFCON 1-2 as default** - Require approval for nearly everything
2. **Use RED level for sensitive systems** - Manual only for critical infrastructure
3. **Enable comprehensive audit logging** - Keep everything for compliance
4. **Regular access reviews** - Ensure only authorized users can approve

---

## Quick Reference

| Situation | What to do |
|-----------|------------|
| Want to stop everything now | Hit the Kill Switch (top bar) |
| Want to preview without executing | Enable Dry-Run mode |
| Unsure about a planned action | Review in Approval Queue, ask questions |
| Need to allow a blocked command | Explicitly confirm in the approval dialog |
| Something went wrong | Check audit log, consider rollback |
| Building confidence | Start at DEFCON 3, work up to 4-5 over time |

---

## Summary

QuoxCORE's safety system is designed to give you confidence, not to limit you. With the kill switch, DEFCON levels, approval workflows, staged rollouts, and comprehensive audit logging, you have complete visibility and control over every action.

**The goal is simple:** You should feel comfortable letting AI handle your infrastructure because you know exactly what it will do and you can stop it at any time.

Safety is not a limitation. It is what makes powerful automation trustworthy.

*"I'm sorry Dave, I'm afraid I can't do that... without proper approval."*
`

export default function SafetyPage() {
  return (
    <MarkdownPage
      content={content}
      title="Safety and Guardrails"
      lead="QuoxCORE's safety system keeps you in control. With kill switches, approval workflows, staged rollouts, and comprehensive audit logging, you get the power of AI automation with complete peace of mind."
    />
  )
}
