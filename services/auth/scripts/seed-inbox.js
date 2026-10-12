#!/usr/bin/env node
/**
 * Seed Inbox with Rich Demo Data
 *
 * Creates 22 sample inbox items demonstrating every kind, priority,
 * payload pattern, and state. Tests PayloadRenderer pattern detection,
 * folder filtering, and response mechanisms.
 *
 * Run: AUTH_DB_PATH=/var/lib/quox/auth.db node scripts/seed-inbox.js
 */

import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

const DB_PATH = process.env.AUTH_DB_PATH || '/var/lib/quox/auth.db';
const db = new Database(DB_PATH);

// Generate ULID-like ID
function ulid() {
    const timestamp = Date.now().toString(36).toUpperCase().padStart(10, '0');
    const random = randomBytes(10).toString('hex').toUpperCase().slice(0, 16);
    return timestamp + random;
}

// Get first org and user
const org = db.prepare('SELECT id, name FROM orgs LIMIT 1').get();
const user = db.prepare('SELECT id, display_name FROM users LIMIT 1').get();
const user2 = db.prepare('SELECT id, display_name FROM users WHERE id != ? LIMIT 1').get(user?.id || '');

if (!org) {
    console.error('No organization found. Create one first.');
    process.exit(1);
}
if (!user) {
    console.error('No user found. Create one first.');
    process.exit(1);
}

console.log(`Seeding inbox for org: ${org.name} (${org.id})`);
console.log(`Using user: ${user.display_name} (${user.id})`);
if (user2) console.log(`Secondary user: ${user2.display_name} (${user2.id})`);

// Check if personal inbox exists, create if not
let inbox = db.prepare(`
    SELECT id FROM inboxes WHERE org_id = ? AND owner_id = ? AND inbox_type = 'personal'
`).get(org.id, user.id);

if (!inbox) {
    const inboxId = ulid();
    db.prepare(`
        INSERT INTO inboxes (id, org_id, inbox_type, name, owner_id)
        VALUES (?, ?, 'personal', ?, ?)
    `).run(inboxId, org.id, `${user.display_name}'s Inbox`, user.id);
    inbox = { id: inboxId };
    console.log('Created personal inbox:', inboxId);
}

const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const oneDayFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const threeHoursFromNow = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

// ─── 22 Demo Items ──────────────────────────────────────────────────

const items = [
    // 1. approval | urgent — Emergency DB Migration (key-value pattern)
    {
        kind: 'approval',
        priority: 'urgent',
        title: 'Emergency Database Migration — CVE-2026-1847',
        body_md: `An emergency schema migration is required to patch a critical SQL injection vulnerability.\n\n**CVE:** [CVE-2026-1847](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2026-1847)\n**Affected Tables:** \`users\`, \`sessions\`, \`api_keys\`\n**Downtime:** Estimated 3-5 minutes\n**Rollback Plan:** Snapshot taken at 14:22 UTC\n\nThis migration adds parameterized query enforcement at the schema level. Approve to proceed immediately.`,
        payload: { migration_id: 'mig_042', cve: 'CVE-2026-1847', affected_tables: ['users', 'sessions', 'api_keys'], estimated_downtime_seconds: 240, rollback_available: true },
        due_at: twoHoursFromNow,
        status: 'open',
        assignee: user.id
    },
    // 2. approval | high — Deploy Production v2.4.0 (deployment pattern)
    {
        kind: 'approval',
        priority: 'high',
        title: 'Deploy Production Release v2.4.0',
        body_md: `A production deployment is ready for release.\n\n**Changes in this release:**\n- Fixed authentication session leak (H17)\n- Added inbox folder sidebar\n- Performance: 40% faster list rendering\n- 12 bug fixes from audit passes\n\n**Test Results:** 85/85 passing\n**Docker Image:** \`quox-dashboard:2.4.0-rc3\``,
        payload: {
            version: 'v2.4.0',
            environment: 'production',
            commit: 'a7f2c3e8b1d4f6a9',
            changelog: ['Fixed auth session leak (H17)', 'Inbox folder sidebar', '40% faster list rendering', '12 bug fixes'],
            docker_image: 'quox-dashboard:2.4.0-rc3',
            tests_passed: 85,
            tests_total: 85,
            custom_actions: [
                { action: 'approve_staging', label: 'Approve for Staging', style: 'warning' },
                { action: 'approve_production', label: 'Approve for Production', style: 'danger' },
                { action: 'request_changes', label: 'Request Changes', style: 'secondary' }
            ]
        },
        status: 'open',
        assignee: user.id,
        is_flagged: 1
    },
    // 3. approval | normal — New Team Member Access (with response_schema)
    {
        kind: 'approval',
        priority: 'normal',
        title: 'New Team Member Access Request — Sarah Chen',
        body_md: `Sarah Chen (sarah.chen@example.com) has requested access to the organization.\n\n**Role Requested:** Developer\n**Referred By:** James Wilson\n**Department:** Platform Engineering\n\nPlease review the requested permissions and approve or deny.`,
        payload: {
            user_email: 'sarah.chen@example.com',
            requested_role: 'developer',
            department: 'Platform Engineering',
            referred_by: 'James Wilson',
            response_schema: {
                fields: [
                    { name: 'role', type: 'select', label: 'Assigned Role', options: ['viewer', 'developer', 'admin'], required: true },
                    { name: 'can_deploy', type: 'checkbox', label: 'Allow production deployments' },
                    { name: 'can_manage_secrets', type: 'checkbox', label: 'Allow secrets management' },
                    { name: 'notes', type: 'text', label: 'Onboarding Notes', placeholder: 'Any special instructions...' }
                ]
            }
        },
        status: 'open',
        assignee: user.id
    },
    // 4. approval | low — Update DNS Records (before/after)
    {
        kind: 'approval',
        priority: 'low',
        title: 'Update DNS Records — api.quox.ai',
        body_md: `DNS record changes have been requested for the API subdomain.\n\n| Record | Current | Proposed |\n|--------|---------|----------|\n| A | 198.51.100.10 | 198.51.100.20 |\n| CNAME | — | api-lb.quox.ai |\n| TTL | 3600 | 300 |\n\n**Reason:** Migration to new load balancer. TTL lowered temporarily for fast rollback.`,
        payload: { domain: 'api.quox.ai', record_type: 'A', current_value: '198.51.100.10', proposed_value: '198.51.100.20', ttl_current: 3600, ttl_proposed: 300, reason: 'Load balancer migration' },
        status: 'open',
        assignee: user.id
    },
    // 5. question | high — SSL Provider Selection (with response_schema)
    {
        kind: 'question',
        priority: 'high',
        title: 'SSL Certificate Provider Selection',
        body_md: `The automated SSL renewal workflow needs your decision on certificate provider.\n\n**Current provider:** Let's Encrypt (expires in 12 days)\n\n**Options:**\n\n| Provider | Cost | Validity | Features |\n|----------|------|----------|----------|\n| Let's Encrypt | Free | 90 days | Auto-renewal, wildcard |\n| DigiCert | $299/yr | 1 year | EV, warranty, support |\n| ZeroSSL | $10/mo | 90 days | REST API, monitoring |\n\nWorkflow is paused at step 3 awaiting your decision.`,
        payload: {
            workflow: 'ssl-renewal',
            step: 3,
            current_provider: "Let's Encrypt",
            days_until_expiry: 12,
            response_schema: {
                fields: [
                    { name: 'provider', type: 'radio', label: 'Select Provider', options: ["Let's Encrypt", 'DigiCert', 'ZeroSSL'], required: true },
                    { name: 'justification', type: 'textarea', label: 'Justification', placeholder: 'Why this provider?' }
                ]
            }
        },
        status: 'open',
        assignee: user.id
    },
    // 6. question | normal — Database Engine (custom_actions)
    {
        kind: 'question',
        priority: 'normal',
        title: 'Database Engine for Analytics Service',
        body_md: `The analytics pipeline needs a time-series database. Please choose the engine.\n\n**Requirements:**\n- Ingest 50k events/sec\n- 90-day retention\n- Sub-second aggregation queries\n- Compatible with Grafana\n\n**Evaluation Results:**\n\n| Engine | Write Speed | Query Speed | Storage | Grafana |\n|--------|-------------|-------------|---------|----------|\n| ClickHouse | 120k/s | 15ms p95 | 42GB/mo | Native |\n| TimescaleDB | 80k/s | 45ms p95 | 68GB/mo | Native |\n| PostgreSQL | 30k/s | 200ms p95 | 95GB/mo | Native |`,
        payload: {
            evaluation_id: 'eval-db-2026-02',
            requirements: { events_per_sec: 50000, retention_days: 90 },
            custom_actions: [
                { action: 'clickhouse', label: 'ClickHouse', style: 'primary' },
                { action: 'timescaledb', label: 'TimescaleDB', style: 'secondary' },
                { action: 'postgresql', label: 'PostgreSQL', style: 'secondary' },
                { action: 'need_more_info', label: 'Need More Info', style: 'warning' }
            ]
        },
        status: 'open',
        assignee: user.id
    },
    // 7. question | low — Color Scheme (with image)
    {
        kind: 'question',
        priority: 'low',
        title: 'Color Scheme for Status Dashboard',
        body_md: `The design team has proposed two color schemes for the new status dashboard.\n\n**Option A — Dark Teal:**\n![Dark Teal mockup](https://placehold.co/600x300/0d1b2a/4ecdc4?text=Dark+Teal+Theme)\n\n**Option B — Midnight Blue:**\n![Midnight Blue mockup](https://placehold.co/600x300/1a1a2e/e94560?text=Midnight+Blue+Theme)\n\nBoth options maintain WCAG AA contrast ratios. Which do you prefer?`,
        payload: { design_ticket: 'DES-142', options: ['Dark Teal', 'Midnight Blue'], wcag_compliant: true },
        status: 'open',
        assignee: user.id
    },
    // 8. task | high — Rotate API Keys
    {
        kind: 'task',
        priority: 'high',
        title: 'Rotate Expiring API Keys',
        body_md: `The following API keys expire within 48 hours and must be rotated.\n\n| Service | Key Prefix | Expires | Status |\n|---------|-----------|---------|--------|\n| Anthropic | sk-ant-...x4f | Feb 28 | **Critical** |\n| ElevenLabs | el-...k2m | Feb 28 | **Critical** |\n| Stripe | sk_test_...p9 | Mar 1 | Warning |\n\nRotate each key in Settings > Integrations, then update the Docker secrets.\n\n**Important:** Do NOT commit new keys to git.`,
        payload: { keys_expiring: 3, critical_count: 2, services: ['Anthropic', 'ElevenLabs', 'Stripe'] },
        due_at: oneDayFromNow,
        status: 'open',
        assignee: user.id
    },
    // 9. task | normal — Review API Docs
    {
        kind: 'task',
        priority: 'normal',
        title: 'Review API Documentation v2.0',
        body_md: `The updated API documentation is ready for review before publishing.\n\n**Sections to review:**\n- Authentication (OAuth 2.0 flows)\n- Inbox endpoints (new bulk actions)\n- Webhook event schemas\n- Rate limiting changes\n\n**Preview:** [docs.quox.ai/preview/v2](https://docs.quox.ai/preview/v2)\n\nPlease mark complete when reviewed. Flag any issues in the comment.`,
        payload: { doc_version: '2.0', sections: 4, total_pages: 48, preview_url: 'https://docs.quox.ai/preview/v2' },
        status: 'in_progress',
        assignee: user.id
    },
    // 10. task | low — Clean Up Docker Images
    {
        kind: 'task',
        priority: 'low',
        title: 'Clean Up Unused Docker Images',
        body_md: `Docker disk usage on docker01 is at 78%. The following unused images can be removed:\n\n| Image | Tag | Size | Last Used |\n|-------|-----|------|-----------|\n| quox-dashboard | 2.1.0 | 412 MB | 45 days ago |\n| quox-dashboard | 2.2.0-beta | 398 MB | 30 days ago |\n| collector | 1.8.0 | 245 MB | 60 days ago |\n| redis | 6.2 | 113 MB | 90 days ago |\n| postgres | 13 | 374 MB | 90 days ago |\n\n**Total reclaimable:** 1.54 GB`,
        payload: { host: 'docker01', disk_usage_pct: 78, reclaimable_gb: 1.54, images_count: 5 },
        status: 'open',
        assignee: user2?.id || user.id
    },
    // 11. incident | urgent — DB Connection Pool Exhausted (metrics pattern)
    {
        kind: 'incident',
        priority: 'urgent',
        title: 'Database Connection Pool Exhausted',
        body_md: `All database connections are in use. New requests are being queued and timing out.\n\n**Impact:** API latency increased 20x, 503 errors for 15% of requests\n**Started:** 2 minutes ago\n**Affected Services:** auth, collector, memory\n\nImmediate investigation required. Consider restarting the connection pool or scaling the database.`,
        payload: {
            host: 'docker02',
            metric: 'db_connections',
            value: 100,
            threshold: 100,
            unit: 'connections',
            latency_ms: 4200,
            error_rate_pct: 15.2,
            affected_services: ['auth', 'collector', 'memory'],
            sections: [
                { title: 'Error Logs', content_md: '```\n2026-02-26T14:22:01Z ERROR [auth] connection pool exhausted: timeout after 5000ms\n2026-02-26T14:22:02Z ERROR [collector] SQLITE_BUSY: database is locked\n2026-02-26T14:22:03Z WARN  [memory] retrying query (attempt 3/5)\n2026-02-26T14:22:04Z ERROR [auth] 23 requests queued, oldest: 4.2s\n```', collapsed: true },
                { title: 'Connection Metrics', content_md: '| Metric | Value |\n|--------|-------|\n| Active Connections | 100/100 |\n| Queued Requests | 23 |\n| Avg Wait Time | 4.2s |\n| Longest Running Query | 12.8s |', collapsed: false },
                { title: 'Remediation Steps', content_md: '1. Kill long-running queries: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE duration > interval \'10 seconds\'`\n2. Increase pool size: `ALTER SYSTEM SET max_connections = 150`\n3. Restart connection pooler: `systemctl restart pgbouncer`\n4. Monitor for 15 minutes', collapsed: false }
            ]
        },
        status: 'open',
        assignee: user.id,
        is_flagged: 1
    },
    // 12. incident | high — High Memory (metrics pattern)
    {
        kind: 'incident',
        priority: 'high',
        title: 'High Memory Usage on docker01',
        body_md: `Memory usage on docker01 has exceeded the 90% threshold for over 15 minutes.\n\n**Top processes by memory:**\n1. \`collector\` — 2.1 GB (n8n worker pool)\n2. \`quox-dashboard\` — 1.4 GB (Node.js heap)\n3. \`postgres\` — 890 MB (shared buffers)\n\nConsider restarting the collector service or investigating the n8n worker pool for leaked processes.`,
        payload: {
            host: 'docker01',
            metric: 'memory_usage',
            value: 94,
            threshold: 90,
            unit: '%',
            total_memory_gb: 8,
            used_memory_gb: 7.52,
            sections: [
                { title: 'Process List', content_md: '| Process | Memory | CPU | Uptime |\n|---------|--------|-----|--------|\n| collector | 2.1 GB | 45% | 14 days |\n| quox-dashboard | 1.4 GB | 12% | 14 days |\n| postgres | 890 MB | 8% | 28 days |\n| redis | 210 MB | 2% | 28 days |\n| nginx | 45 MB | 1% | 28 days |', collapsed: true },
                { title: 'Memory Timeline', content_md: '- **14:00** — 82% (normal)\n- **14:15** — 87% (rising)\n- **14:22** — 90% (threshold crossed)\n- **14:30** — 94% (current, alert fired)', collapsed: false }
            ]
        },
        status: 'open',
        assignee: user.id
    },
    // 13. incident | normal — SSL Certificate Expiring (cert pattern)
    {
        kind: 'incident',
        priority: 'normal',
        title: 'SSL Certificate Expiring in 7 Days',
        body_md: `The SSL certificate for \`quox.ai\` will expire in 7 days.\n\n**Domain:** quox.ai (and *.quox.ai)\n**Issuer:** Let's Encrypt\n**Expiry:** March 5, 2026\n\nAuto-renewal is configured but the last attempt failed. Check the ACME logs for errors.`,
        payload: {
            domain: 'quox.ai',
            certificate: 'quox.ai + *.quox.ai',
            expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            issuer: "Let's Encrypt",
            type: 'Wildcard',
            auto_renewal: true,
            last_renewal_error: 'DNS-01 challenge failed: NXDOMAIN for _acme-challenge.quox.ai'
        },
        status: 'open',
        assignee: user.id
    },
    // 14. incident | low — Disk Usage Warning
    {
        kind: 'incident',
        priority: 'low',
        title: 'Disk Usage Warning on hyp-02',
        body_md: `Disk usage on hyp-02 has crossed the 80% warning threshold.\n\n| Partition | Used | Total | % |\n|-----------|------|-------|---|\n| /dev/sda1 (/) | 38 GB | 50 GB | 76% |\n| /dev/sdb1 (/data) | 162 GB | 200 GB | **81%** |\n| /dev/sdc1 (/backup) | 410 GB | 500 GB | **82%** |\n\nConsider archiving old VM snapshots on /backup.`,
        payload: { host: 'hyp-02', metric: 'disk_usage', value: 81, threshold: 80, unit: '%', partitions: [{ mount: '/', used_gb: 38, total_gb: 50 }, { mount: '/data', used_gb: 162, total_gb: 200 }, { mount: '/backup', used_gb: 410, total_gb: 500 }] },
        status: 'open',
        assignee: user2?.id || user.id
    },
    // 15. info | normal — Weekly System Report (with image and sections)
    {
        kind: 'info',
        priority: 'normal',
        title: 'Weekly System Report — Feb 17-24, 2026',
        body_md: `Your weekly system report is ready.\n\n![Uptime Chart](https://placehold.co/600x200/1a1a2e/22c55e?text=99.97%25+Uptime)\n\n**Highlights:**\n- **Uptime:** 99.97% (8 min downtime — planned maintenance)\n- **API Calls:** 48,291 (+12% from last week)\n- **Incidents:** 2 resolved, 0 unresolved\n- **Deployments:** 3 successful\n\nNo action required.`,
        payload: {
            report_id: 'weekly-2026-08',
            period: '2026-02-17 to 2026-02-24',
            uptime_pct: 99.97,
            api_calls: 48291,
            incidents_resolved: 2,
            deployments: 3,
            sections: [
                { title: 'Performance Summary', content_md: '| Metric | This Week | Last Week | Change |\n|--------|-----------|-----------|--------|\n| Avg Latency | 42ms | 48ms | -12.5% |\n| P95 Latency | 180ms | 210ms | -14.3% |\n| Error Rate | 0.02% | 0.05% | -60% |\n| Cache Hit Rate | 94.2% | 92.1% | +2.3% |', collapsed: false },
                { title: 'Incidents This Week', content_md: '1. **High Memory on docker01** — Resolved by collector restart (14 min)\n2. **DNS propagation delay** — Self-resolved after TTL expiry (8 min)', collapsed: false },
                { title: 'Upcoming Maintenance', content_md: '- **Feb 28:** Proxmox cluster firmware update (hyp-01 to hyp-03)\n- **Mar 1:** Postgres 16 upgrade on docker02\n- **Mar 3:** SSL certificate renewal (auto)', collapsed: true }
            ],
            attachments: [
                { name: 'weekly-report-2026-08.pdf', url: '/api/orgs/placeholder/files/report-pdf', type: 'application/pdf', size: 245760 }
            ]
        },
        status: 'open',
        assignee: user.id
    },
    // 16. info | low — Backup Completed
    {
        kind: 'info',
        priority: 'low',
        title: 'Backup Completed Successfully',
        body_md: `Daily backup completed for all services.\n\n**Backup Summary:**\n- Auth DB: 12.4 MB (compressed)\n- Memory DB: 48.2 MB (compressed)\n- n8n workflows: 3.1 MB\n- Config files: 0.8 MB\n\n**Location:** /backup/daily/2026-02-26\n**Retention:** 30 days`,
        payload: { backup_id: 'daily-2026-02-26', total_size_mb: 64.5, services_backed_up: 4, retention_days: 30, location: '/backup/daily/2026-02-26' },
        status: 'open',
        assignee: user.id
    },
    // 17. override_required | urgent — Delete Protected Resource (resource pattern)
    {
        kind: 'override_required',
        priority: 'urgent',
        title: 'Safety Override: Delete Protected Production Database',
        body_md: `A workflow is attempting to delete a critically protected resource.\n\n**Resource:** \`prod-postgres-main\`\n**Protection Level:** Critical\n**Requested By:** cleanup-workflow-v3\n**Reason:** "End-of-life database migration completed"\n\n> **Warning:** This action is irreversible. The database contains 2.4 million records across 47 tables. Ensure all data has been migrated before granting override.`,
        payload: { resource_type: 'database', resource_id: 'prod-postgres-main', protection: 'critical', record_count: 2400000, table_count: 47, requested_by: 'cleanup-workflow-v3' },
        status: 'open',
        assignee: user.id
    },
    // 18. override_required | high — Bypass Rate Limit (resource pattern)
    {
        kind: 'override_required',
        priority: 'high',
        title: 'Bypass Rate Limit for Data Migration',
        body_md: `The data migration workflow has hit the API rate limit and is requesting a temporary override.\n\n**Current Limit:** 100 req/min\n**Requested Limit:** 1,000 req/min\n**Duration:** 2 hours\n**Workflow:** data-migration-v2\n\nThe migration needs to transfer 500,000 records. At current limits this would take ~83 hours vs ~8 hours with the override.`,
        payload: { resource_type: 'rate_limit', resource_id: 'api-gateway-main', protection: 'medium', current_limit: 100, requested_limit: 1000, duration_hours: 2, records_to_migrate: 500000 },
        status: 'open',
        assignee: user.id
    },
    // 19. approval | high — Budget Approval (budget pattern + response_schema)
    {
        kind: 'approval',
        priority: 'high',
        title: 'Budget Approval: Cloud Infrastructure Q2',
        body_md: `Cloud infrastructure budget request for Q2 2026.\n\n**Department:** Platform Engineering\n**Period:** April - June 2026\n**Increase from Q1:** +18%\n\nThe increase is driven by:\n- New analytics database cluster\n- Additional monitoring nodes\n- Projected traffic growth (15%)\n\nPlease review the breakdown and approve or adjust.`,
        payload: {
            total_cost: 12450,
            currency: 'USD',
            breakdown: [
                { name: 'Hetzner VPS (4 nodes)', amount: 4800 },
                { name: 'ClickHouse Cloud (analytics)', amount: 3200 },
                { name: 'Monitoring (Grafana Cloud)', amount: 1500 },
                { name: 'Backup storage (S3)', amount: 950 },
                { name: 'DNS & CDN (Cloudflare)', amount: 600 },
                { name: 'SSL certificates', amount: 400 },
                { name: 'Miscellaneous', amount: 1000 }
            ],
            response_schema: {
                fields: [
                    { name: 'approved_amount', type: 'number', label: 'Approved Amount (USD)', min: 0, max: 50000, required: true },
                    { name: 'payment_terms', type: 'select', label: 'Payment Terms', options: ['monthly', 'quarterly', 'annual'], required: true },
                    { name: 'finance_review', type: 'checkbox', label: 'Requires additional finance review' },
                    { name: 'notes', type: 'textarea', label: 'Comments', placeholder: 'Adjustments or conditions...' }
                ]
            }
        },
        status: 'open',
        assignee: user.id
    },
    // 20. task | normal — Acknowledge Maintenance Window (response_schema)
    {
        kind: 'task',
        priority: 'normal',
        title: 'Acknowledge Maintenance Window — Proxmox Firmware',
        body_md: `Scheduled maintenance window for Proxmox cluster firmware update.\n\n**Scope:** hyp-01, hyp-02, hyp-03 (rolling update)\n**Proposed Date:** February 28, 2026\n**Proposed Time:** 02:00 - 04:00 UTC\n**Expected Impact:** VMs will live-migrate between nodes. Brief network hiccups possible.\n\nPlease confirm the date/time or suggest an alternative.`,
        payload: {
            affected_hosts: ['hyp-01', 'hyp-02', 'hyp-03'],
            maintenance_type: 'firmware_update',
            proposed_date: '2026-02-28',
            proposed_time: '02:00-04:00 UTC',
            response_schema: {
                fields: [
                    { name: 'preferred_date', type: 'date', label: 'Preferred Date', required: true },
                    { name: 'preferred_window', type: 'select', label: 'Time Window', options: ['02:00-04:00 UTC', '04:00-06:00 UTC', '22:00-00:00 UTC'], required: true },
                    { name: 'notify_team', type: 'checkbox', label: 'Send Slack notification to team' }
                ]
            }
        },
        status: 'open',
        assignee: user.id
    },
    // 21. incident | high — Failed Deployment (with image, sections, attachments)
    {
        kind: 'incident',
        priority: 'high',
        title: 'Failed Deployment — Rollback Needed',
        body_md: `The collector service deployment failed during health check.\n\n![Deployment Timeline](https://placehold.co/600x150/1a1a2e/ef4444?text=Deployment+Failed+at+Health+Check)\n\n**Service:** collector (v1.9.2 → v1.10.0)\n**Failed At:** Health check (step 4/5)\n**Previous Version:** v1.9.2 (stable)\n\nThe service is currently running the failed version. Automatic rollback was not configured. Manual rollback is recommended.`,
        payload: {
            version: 'v1.10.0',
            environment: 'production',
            commit: 'f8e2d1c3a5b7',
            previous_version: 'v1.9.2',
            failed_at_step: 'health_check',
            sections: [
                { title: 'Deployment Diff', content_md: '```diff\n- collector: v1.9.2\n+ collector: v1.10.0\n\nFiles changed: 12\n+ services/collector/server.js (23 additions, 8 deletions)\n+ services/collector/routes/mcp.js (new file)\n- services/collector/legacy-handler.js (deleted)\n```', collapsed: true },
                { title: 'Error Output', content_md: '```\nStep 4/5: Health check\nGET http://localhost:9848/health → 503 Service Unavailable\nResponse: {"status":"error","message":"MCP bridge initialization failed: ECONNREFUSED 127.0.0.1:3103"}\nRetry 1/3... 503\nRetry 2/3... 503\nRetry 3/3... 503\nHealth check FAILED after 3 retries (30s timeout)\n```', collapsed: true },
                { title: 'Rollback Steps', content_md: '1. `docker compose pull collector:v1.9.2`\n2. `docker compose up -d collector`\n3. Verify health: `curl http://localhost:9848/health`\n4. Check logs: `docker logs collector --tail 50`', collapsed: false }
            ],
            attachments: [
                { name: 'deploy-log-v1.10.0.txt', url: '/api/orgs/placeholder/files/deploy-log', type: 'text/plain', size: 8192 },
                { name: 'health-check-error.png', url: 'https://placehold.co/800x400/1a1a2e/ef4444?text=Health+Check+Error', type: 'image/png', size: 45056 }
            ]
        },
        status: 'open',
        assignee: user.id
    },
    // 22. question | normal — Architecture Decision
    {
        kind: 'question',
        priority: 'normal',
        title: 'Architecture Decision: Microservices Split',
        body_md: `The collector service has grown to 4,200 lines and handles 3 distinct concerns:\n\n1. **Chat pipeline** (OAuth, MCP, API key paths)\n2. **Fleet management** (QuoxAgent coordination)\n3. **Inbox webhooks** (item creation, SSE streaming)\n\n**Proposal:** Split into 3 microservices on separate ports.\n\n**Trade-offs:**\n- **Pro:** Independent scaling, isolated failures, clearer ownership\n- **Con:** Inter-service communication overhead, Docker complexity, shared auth\n\nWhat is your preference?`,
        payload: {
            current_loc: 4200,
            proposed_services: ['chat-gateway', 'fleet-coordinator', 'inbox-service'],
            custom_actions: [
                { action: 'split_all', label: 'Split All Three', style: 'primary' },
                { action: 'split_inbox', label: 'Split Inbox Only', style: 'secondary' },
                { action: 'keep_monolith', label: 'Keep Monolith', style: 'secondary' },
                { action: 'defer', label: 'Defer Decision', style: 'warning' }
            ]
        },
        status: 'open',
        assignee: user.id
    }
];

// ─── Insert Items ──────────────────────────────────────────────────

const insertItem = db.prepare(`
    INSERT INTO inbox_items (id, org_id, inbox_id, kind, status, priority, title, body_md, payload_json, due_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAssignee = db.prepare(`
    INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode, status, is_flagged)
    VALUES (?, ?, 'user', ?, 'anyone', 'pending', ?)
`);

// Clear existing seed data (items created by this user in this inbox)
const existingCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM inbox_items WHERE org_id = ? AND inbox_id = ?
`).get(org.id, inbox.id);

if (existingCount.cnt > 0) {
    console.log(`Clearing ${existingCount.cnt} existing items from inbox...`);
    const existingIds = db.prepare(`
        SELECT id FROM inbox_items WHERE org_id = ? AND inbox_id = ?
    `).all(org.id, inbox.id).map(r => r.id);

    for (const id of existingIds) {
        db.prepare('DELETE FROM inbox_item_assignees WHERE inbox_item_id = ?').run(id);
        db.prepare('DELETE FROM inbox_items WHERE id = ?').run(id);
    }
}

let created = 0;
for (const item of items) {
    const itemId = ulid();
    const assigneeId = item.assignee || user.id;

    insertItem.run(
        itemId,
        org.id,
        inbox.id,
        item.kind,
        item.status || 'open',
        item.priority,
        item.title,
        item.body_md,
        JSON.stringify(item.payload),
        item.due_at || null,
        user.id
    );

    insertAssignee.run(ulid(), itemId, assigneeId, item.is_flagged || 0);

    created++;
    console.log(`  [${item.priority.toUpperCase().padEnd(6)}] ${item.kind.padEnd(18)} ${item.title}`);

    // Small delay to ensure unique ULIDs
    const start = Date.now();
    while (Date.now() - start < 2) { /* spin */ }
}

console.log(`\nCreated ${created} inbox items`);
console.log(`\nTo test:`);
console.log(`1. Open the dashboard`);
console.log(`2. Log in and select "${org.name}"`);
console.log(`3. Click "Inbox" in the sidebar`);
console.log(`4. Browse folders to see items filtered by kind/status`);
console.log(`5. Click an item to see PayloadRenderer cards`);

db.close();
