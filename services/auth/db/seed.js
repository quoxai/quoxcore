/**
 * Database seed script for Quox Auth Service
 * HITL Phase C Testing - Comprehensive Test Data
 *
 * Run with: node services/auth/db/seed.js
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'crypto';
import argon2 from 'argon2';
import { ulid } from 'ulid';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.AUTH_DB_PATH || '/var/lib/quox/auth.db';

// ============================================================================
// UTILITIES
// ============================================================================

function generateId() {
    return ulid();
}

function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

async function hashPassword(password) {
    return argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4
    });
}

function slugify(text) {
    return text.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

// ============================================================================
// TEST DATA DEFINITIONS
// ============================================================================

// Users - Generic test data (customize for your environment)
const USERS = [
    { email: 'admin@example.com', name: 'Admin User', role: 'owner' },
    { email: 'alice@example.com', name: 'Alice Chen', role: 'admin' },
    { email: 'bob@example.com', name: 'Bob Martinez', role: 'builder' },
    { email: 'carol@example.com', name: 'Carol Johnson', role: 'runner' },
    { email: 'dave@example.com', name: 'Dave Wilson', role: 'viewer' },
    { email: 'eve@example.com', name: 'Eve Anderson', role: 'builder' },
    { email: 'frank@example.com', name: 'Frank Lee', role: 'runner' },
    { email: 'grace@acme-example.com', name: 'Grace Kim', role: 'admin' },
    { email: 'helen@example.com', name: 'Helen Wang', role: 'builder' },
    { email: 'ivan@example.com', name: 'Ivan Petrov', role: 'member' },
    { email: 'julia@example.com', name: 'Julia Torres', role: 'runner' },
    { email: 'kevin@example.com', name: "Kevin O'Brien", role: 'viewer' },
    { email: 'lisa@example.com', name: 'Lisa Nakamura', role: 'builder' },
    { email: 'mark@example.com', name: 'Mark Stevens', role: 'runner' },
];

// Organizations - Generic test data
const ORGS = [
    {
        name: 'Example Organization',
        slug: 'example-org',
        plan: 'enterprise',
        isPrimary: true
    },
    {
        name: 'Acme Corp',
        slug: 'acme-corp',
        plan: 'team',
        isPrimary: false
    }
];

// Divisions (for Example Organization)
const DIVISIONS = [
    { name: 'Engineering', slug: 'engineering', description: 'Product and platform engineering' },
    { name: 'Operations', slug: 'operations', description: 'Infrastructure and site reliability' },
    { name: 'Security', slug: 'security', description: 'Security operations and compliance' }
];

// Departments (mapped to divisions)
const DEPARTMENTS = [
    { name: 'Platform', slug: 'platform', divisionSlug: 'engineering', description: 'Core platform development' },
    { name: 'Infrastructure', slug: 'infrastructure', divisionSlug: 'operations', description: 'Infrastructure management' },
    { name: 'DevOps', slug: 'devops', divisionSlug: 'engineering', description: 'CI/CD and automation' },
    { name: 'SOC', slug: 'soc', divisionSlug: 'security', description: 'Security Operations Center' },
    { name: 'NOC', slug: 'noc', divisionSlug: 'operations', description: 'Network Operations Center' }
];

// Teams
const TEAMS = [
    { name: 'Platform Team', slug: 'platform-team', divisionSlug: 'engineering', description: 'Core platform development team' },
    { name: 'Infrastructure Team', slug: 'infrastructure-team', divisionSlug: 'operations', description: 'Infrastructure and SRE team' },
    { name: 'Security Team', slug: 'security-team', divisionSlug: 'security', description: 'Security operations team' },
    { name: 'DevOps Team', slug: 'devops-team', divisionSlug: 'engineering', description: 'CI/CD and automation team' },
    { name: 'Automation Team', slug: 'automation-team', divisionSlug: 'operations', description: 'Runbook and workflow automation' }
];

// Assistants (from config/assistants.js)
const ASSISTANTS = [
    { id: 'quox', name: 'QuoxCORE', shortName: 'M', color: '#38bdf8', specialty: 'Infrastructure Orchestration', role: 'orchestrator', level: 0 },
    { id: 'sentinel', name: 'WARDEN', shortName: 'S', color: '#3090ff', specialty: 'Security Operations', role: 'manager', level: 1 },
    { id: 'cipher', name: 'CIPHER', shortName: 'C', color: '#9d4edd', specialty: 'Network Operations', role: 'manager', level: 1 },
    { id: 'nova', name: 'DAEDALUS', shortName: 'N', color: '#30ff90', specialty: 'Automation & DevOps', role: 'manager', level: 1 },
    { id: 'gemini', name: 'GEMINI', shortName: 'G', color: '#4285f4', specialty: 'Analysis & Classification', role: 'analyst', level: 1 },
    { id: 'atlas', name: 'HYPERION', shortName: 'A', color: '#ff8c00', specialty: 'Proxmox Virtualization', role: 'specialist', level: 2 },
    { id: 'metrics', name: 'METRICS', shortName: 'P', color: '#e6522c', specialty: 'Prometheus & Monitoring', role: 'specialist', level: 2 },
    { id: 'insight', name: 'INSIGHT', shortName: 'I', color: '#f46800', specialty: 'Grafana Dashboards', role: 'specialist', level: 2 },
    { id: 'oracle', name: 'ORACLE', shortName: 'O', color: '#20b2aa', specialty: 'Research & Documentation', role: 'specialist', level: 2 },
    { id: 'beacon', name: 'VIGIL', shortName: 'B', color: '#00c853', specialty: 'Uptime & Availability', role: 'specialist', level: 2 },
    { id: 'codex', name: 'CODEX', shortName: 'X', color: '#10a37f', specialty: 'Code Generation', role: 'specialist', level: 2 }
];

// Tools
const TOOLS = [
    { name: 'SSH Terminal', slug: 'ssh-terminal', description: 'Secure shell access to managed hosts', toolType: 'mcp', riskLevel: 'high', icon: 'terminal' },
    { name: 'File Browser', slug: 'file-browser', description: 'Browse and manage files on hosts', toolType: 'mcp', riskLevel: 'medium', icon: 'folder' },
    { name: 'Log Viewer', slug: 'log-viewer', description: 'View and search system logs', toolType: 'api', riskLevel: 'low', icon: 'file-text' },
    { name: 'Metrics Dashboard', slug: 'metrics-dashboard', description: 'Real-time metrics and monitoring', toolType: 'api', riskLevel: 'low', icon: 'activity' },
    { name: 'Backup Manager', slug: 'backup-manager', description: 'Manage system backups and snapshots', toolType: 'workflow', riskLevel: 'high', icon: 'archive' },
    { name: 'Container Manager', slug: 'container-manager', description: 'Docker and container orchestration', toolType: 'mcp', riskLevel: 'high', icon: 'box' },
    { name: 'Network Scanner', slug: 'network-scanner', description: 'Scan and discover network resources', toolType: 'script', riskLevel: 'medium', icon: 'wifi' },
    { name: 'Config Editor', slug: 'config-editor', description: 'Edit configuration files with validation', toolType: 'mcp', riskLevel: 'high', icon: 'settings' },
    { name: 'Certificate Manager', slug: 'cert-manager', description: 'SSL/TLS certificate management', toolType: 'workflow', riskLevel: 'critical', icon: 'shield' },
    { name: 'DNS Manager', slug: 'dns-manager', description: 'DNS zone and record management', toolType: 'api', riskLevel: 'high', icon: 'globe' }
];

// Workflows
const WORKFLOWS = [
    { name: 'Daily Backup', slug: 'daily-backup', description: 'Automated daily backup of critical systems', triggerType: 'schedule', status: 'active' },
    { name: 'Security Scan', slug: 'security-scan', description: 'Run security vulnerability scans', triggerType: 'schedule', status: 'active' },
    { name: 'Health Check', slug: 'health-check', description: 'System health and availability check', triggerType: 'schedule', status: 'active' },
    { name: 'Deploy Application', slug: 'deploy-application', description: 'Standard application deployment workflow', triggerType: 'manual', status: 'active' },
    { name: 'Scale Infrastructure', slug: 'scale-infrastructure', description: 'Auto-scale infrastructure resources', triggerType: 'event', status: 'active' },
    { name: 'Incident Response', slug: 'incident-response', description: 'Automated incident response runbook', triggerType: 'event', status: 'active' },
    { name: 'Certificate Renewal', slug: 'cert-renewal', description: 'Automated SSL certificate renewal', triggerType: 'schedule', status: 'active' },
    { name: 'User Onboarding', slug: 'user-onboarding', description: 'New user account provisioning', triggerType: 'manual', status: 'active' },
    { name: 'Log Rotation', slug: 'log-rotation', description: 'Automated log rotation and archival', triggerType: 'schedule', status: 'active' },
    { name: 'Disaster Recovery', slug: 'disaster-recovery', description: 'DR failover procedures', triggerType: 'manual', status: 'draft' }
];

// Tags
const TAGS = [
    { name: 'Production', slug: 'production', color: '#e74c3c', description: 'Production environment resources' },
    { name: 'Staging', slug: 'staging', color: '#f39c12', description: 'Staging environment resources' },
    { name: 'Development', slug: 'development', color: '#27ae60', description: 'Development environment resources' },
    { name: 'Critical', slug: 'critical', color: '#9b59b6', description: 'Mission-critical resources' },
    { name: 'Automated', slug: 'automated', color: '#3498db', description: 'Fully automated processes' },
    { name: 'Manual', slug: 'manual', color: '#95a5a6', description: 'Requires manual intervention' },
    { name: 'Security', slug: 'security', color: '#1abc9c', description: 'Security-related resources' },
    { name: 'Monitoring', slug: 'monitoring', color: '#e67e22', description: 'Monitoring and observability' }
];

// ============================================================================
// SEED FUNCTIONS
// ============================================================================

async function seed() {
    console.log('='.repeat(60));
    console.log('QuoxCORE AUTH SERVICE - DATABASE SEEDER');
    console.log('HITL Phase C Testing Data');
    console.log('='.repeat(60));
    console.log(`\nDatabase: ${DB_PATH}\n`);

    // Ensure database directory exists
    const dbDir = dirname(DB_PATH);
    if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
        console.log(`Created directory: ${dbDir}`);
    }

    // Check if database exists - if not, apply schema first
    const isNew = !existsSync(DB_PATH);

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    if (isNew) {
        console.log('New database - applying schema...');
        const schemaPath = join(__dirname, 'schema.sql');
        const schema = readFileSync(schemaPath, 'utf-8');
        db.exec(schema);

        // Apply Phase B schema
        const schemaB1Path = join(__dirname, 'schema-b1.sql');
        if (existsSync(schemaB1Path)) {
            const schemaB1 = readFileSync(schemaB1Path, 'utf-8');
            db.exec(schemaB1);
        }
        console.log('Schema applied.\n');
    }

    // Store created IDs for relationships
    const ids = {
        users: {},
        orgs: {},
        divisions: {},
        departments: {},
        teams: {},
        scopes: {},
        sharePolicies: {},
        tools: {},
        workflows: {},
        assistants: {},
        tags: {}
    };

    const stats = {
        users: 0,
        orgs: 0,
        divisions: 0,
        departments: 0,
        teams: 0,
        scopes: 0,
        tools: 0,
        workflows: 0,
        assistants: 0,
        tags: 0,
        memberships: 0
    };

    try {
        // Begin transaction
        db.exec('BEGIN TRANSACTION');

        // ========================================
        // 1. SEED USERS
        // ========================================
        console.log('Seeding users...');
        if (process.env.NODE_ENV === 'production') {
            console.error('ERROR: seed.js must not be run in production. Set NODE_ENV=development.');
            process.exit(1);
        }
        // TRUST-GATE-OPS: never a fixed literal — a known default password on
        // any reachable box is a credential, not a placeholder. Use
        // TEST_PASSWORD or a random per-seed value printed exactly once.
        const testPassword = process.env.TEST_PASSWORD || randomBytes(12).toString('base64url');
        if (!process.env.TEST_PASSWORD) {
            console.log(`  TEST_PASSWORD not set — seeded users get random password: ${testPassword}`);
        }
        const defaultPassword = await hashPassword(testPassword);

        for (const user of USERS) {
            const userId = generateId();
            ids.users[user.email] = userId;

            // Check if user exists
            const existing = db.prepare('SELECT id FROM users WHERE primary_email = ?').get(user.email);
            if (existing) {
                ids.users[user.email] = existing.id;
                console.log(`  - ${user.email} (exists)`);
                continue;
            }

            // Create user
            db.prepare(`
                INSERT INTO users (id, primary_email, display_name, status)
                VALUES (?, ?, ?, 'active')
            `).run(userId, user.email, user.name);

            // Create email record
            db.prepare(`
                INSERT INTO user_emails (id, user_id, email, is_primary, verified_at)
                VALUES (?, ?, ?, 1, datetime('now'))
            `).run(generateId(), userId, user.email);

            // Create password identity
            db.prepare(`
                INSERT INTO auth_identities (id, user_id, provider, password_hash)
                VALUES (?, ?, 'password', ?)
            `).run(generateId(), userId, defaultPassword);

            stats.users++;
            console.log(`  + ${user.email} (${user.role})`);
        }

        // ========================================
        // 2. SEED ORGANIZATIONS
        // ========================================
        console.log('\nSeeding organizations...');

        for (const org of ORGS) {
            const orgId = generateId();
            ids.orgs[org.slug] = orgId;

            // Check if org exists
            const existing = db.prepare('SELECT id FROM orgs WHERE slug = ?').get(org.slug);
            if (existing) {
                ids.orgs[org.slug] = existing.id;
                console.log(`  - ${org.name} (exists)`);
                continue;
            }

            // Owner is admin@example.com for primary, grace@acme-example.com for secondary
            const ownerEmail = org.isPrimary ? 'admin@example.com' : 'grace@acme-example.com';
            const ownerId = ids.users[ownerEmail];

            // Create org
            db.prepare(`
                INSERT INTO orgs (id, name, slug, plan, owner_user_id, mfa_policy)
                VALUES (?, ?, ?, ?, ?, 'optional')
            `).run(orgId, org.name, org.slug, org.plan, ownerId);

            // Create org scope
            const orgScopeId = generateId();
            ids.scopes[`org:${org.slug}`] = orgScopeId;
            db.prepare(`
                INSERT INTO scopes (id, org_id, scope_type, ref_id, path, name_cache, depth)
                VALUES (?, ?, 'org', ?, ?, ?, 0)
            `).run(orgScopeId, orgId, orgId, `/${org.slug}`, org.name);
            stats.scopes++;

            // Create owner membership
            db.prepare(`
                INSERT INTO org_memberships (id, org_id, user_id, role, status, accepted_at)
                VALUES (?, ?, ?, 'owner', 'active', datetime('now'))
            `).run(generateId(), orgId, ownerId);
            stats.memberships++;

            // Create default share policies
            const systemPolicies = [
                { name: 'Private', mode: 'private', description: 'Only visible to creator' },
                { name: 'Team Only', mode: 'team', description: 'Visible to team members' },
                { name: 'Department', mode: 'department', description: 'Visible to department members' },
                { name: 'Division', mode: 'division', description: 'Visible to division members' },
                { name: 'Org-Wide', mode: 'org', description: 'Visible to all org members' }
            ];

            for (const policy of systemPolicies) {
                const policyId = generateId();
                ids.sharePolicies[`${org.slug}:${policy.mode}`] = policyId;
                db.prepare(`
                    INSERT INTO share_policies (id, org_id, name, description, mode, is_system)
                    VALUES (?, ?, ?, ?, ?, 1)
                `).run(policyId, orgId, policy.name, policy.description, policy.mode);
            }

            stats.orgs++;
            console.log(`  + ${org.name} (${org.plan})`);
        }

        // ========================================
        // 3. SEED MEMBERSHIPS FOR PRIMARY ORG
        // ========================================
        console.log('\nSeeding memberships...');
        const primaryOrgId = ids.orgs['example-org'];

        // Add all users to primary org (except owner and Acme-only users)
        for (const user of USERS) {
            if (user.email === 'admin@example.com') continue; // Owner already added
            if (user.email === 'grace@acme-example.com') continue; // Grace is Acme only

            const existing = db.prepare(`
                SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ?
            `).get(primaryOrgId, ids.users[user.email]);

            if (existing) {
                console.log(`  - ${user.email} -> Example Organization (exists)`);
                continue;
            }

            db.prepare(`
                INSERT INTO org_memberships (id, org_id, user_id, role, status, accepted_at)
                VALUES (?, ?, ?, ?, 'active', datetime('now'))
            `).run(generateId(), primaryOrgId, ids.users[user.email], user.role);
            stats.memberships++;
            console.log(`  + ${user.email} -> Example Organization (${user.role})`);
        }

        // ========================================
        // 4. SEED DIVISIONS (Primary Org Only)
        // ========================================
        console.log('\nSeeding divisions...');

        for (const div of DIVISIONS) {
            const divId = generateId();
            ids.divisions[div.slug] = divId;

            // Check if exists
            const existing = db.prepare(`
                SELECT id FROM divisions WHERE org_id = ? AND slug = ?
            `).get(primaryOrgId, div.slug);

            if (existing) {
                ids.divisions[div.slug] = existing.id;
                console.log(`  - ${div.name} (exists)`);
                continue;
            }

            // Create division
            db.prepare(`
                INSERT INTO divisions (id, org_id, name, slug, description, created_by)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(divId, primaryOrgId, div.name, div.slug, div.description, ids.users['admin@example.com']);

            // Create scope for division
            const scopeId = generateId();
            ids.scopes[`div:${div.slug}`] = scopeId;
            db.prepare(`
                INSERT INTO scopes (id, org_id, scope_type, ref_id, parent_scope_id, path, name_cache, depth)
                VALUES (?, ?, 'division', ?, ?, ?, ?, 1)
            `).run(scopeId, primaryOrgId, divId, ids.scopes['org:example-org'], `/example-org/${div.slug}`, div.name);
            stats.scopes++;

            stats.divisions++;
            console.log(`  + ${div.name}`);
        }

        // ========================================
        // 5. SEED DEPARTMENTS
        // ========================================
        console.log('\nSeeding departments...');

        for (const dept of DEPARTMENTS) {
            const deptId = generateId();
            ids.departments[dept.slug] = deptId;

            const divisionId = ids.divisions[dept.divisionSlug];

            // Check if exists
            const existing = db.prepare(`
                SELECT id FROM departments WHERE division_id = ? AND slug = ?
            `).get(divisionId, dept.slug);

            if (existing) {
                ids.departments[dept.slug] = existing.id;
                console.log(`  - ${dept.name} (exists)`);
                continue;
            }

            // Create department
            db.prepare(`
                INSERT INTO departments (id, org_id, division_id, name, slug, description, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(deptId, primaryOrgId, divisionId, dept.name, dept.slug, dept.description, ids.users['admin@example.com']);

            // Create scope for department
            const scopeId = generateId();
            ids.scopes[`dept:${dept.slug}`] = scopeId;
            db.prepare(`
                INSERT INTO scopes (id, org_id, scope_type, ref_id, parent_scope_id, path, name_cache, depth)
                VALUES (?, ?, 'department', ?, ?, ?, ?, 2)
            `).run(scopeId, primaryOrgId, deptId, ids.scopes[`div:${dept.divisionSlug}`],
                   `/example-org/${dept.divisionSlug}/${dept.slug}`, dept.name);
            stats.scopes++;

            stats.departments++;
            console.log(`  + ${dept.name} (${dept.divisionSlug})`);
        }

        // ========================================
        // 6. SEED TEAMS
        // ========================================
        console.log('\nSeeding teams...');

        for (const team of TEAMS) {
            const teamId = generateId();
            ids.teams[team.slug] = teamId;

            // Check if exists
            const existing = db.prepare(`
                SELECT id FROM teams WHERE org_id = ? AND slug = ?
            `).get(primaryOrgId, team.slug);

            if (existing) {
                ids.teams[team.slug] = existing.id;
                console.log(`  - ${team.name} (exists)`);
                continue;
            }

            // Create team
            db.prepare(`
                INSERT INTO teams (id, org_id, name, slug, description)
                VALUES (?, ?, ?, ?, ?)
            `).run(teamId, primaryOrgId, team.name, team.slug, team.description);

            // Create scope for team
            const scopeId = generateId();
            ids.scopes[`team:${team.slug}`] = scopeId;
            db.prepare(`
                INSERT INTO scopes (id, org_id, scope_type, ref_id, parent_scope_id, path, name_cache, depth)
                VALUES (?, ?, 'team', ?, ?, ?, ?, 3)
            `).run(scopeId, primaryOrgId, teamId, ids.scopes[`div:${team.divisionSlug}`],
                   `/example-org/${team.divisionSlug}/${team.slug}`, team.name);
            stats.scopes++;

            stats.teams++;
            console.log(`  + ${team.name}`);
        }

        // ========================================
        // 7. SEED TEAM MEMBERSHIPS
        // ========================================
        console.log('\nSeeding team memberships...');

        const teamAssignments = [
            { team: 'platform-team', users: ['alice@example.com', 'bob@example.com', 'helen@example.com', 'ivan@example.com'], lead: 'alice@example.com' },
            { team: 'infrastructure-team', users: ['carol@example.com', 'frank@example.com', 'julia@example.com', 'kevin@example.com'], lead: 'carol@example.com' },
            { team: 'security-team', users: ['alice@example.com', 'eve@example.com', 'kevin@example.com', 'lisa@example.com'], lead: 'alice@example.com' },
            { team: 'devops-team', users: ['bob@example.com', 'eve@example.com', 'lisa@example.com', 'mark@example.com'], lead: 'bob@example.com' },
            { team: 'automation-team', users: ['frank@example.com', 'dave@example.com', 'helen@example.com', 'mark@example.com'], lead: 'frank@example.com' }
        ];

        for (const assignment of teamAssignments) {
            const teamId = ids.teams[assignment.team];
            for (const userEmail of assignment.users) {
                const userId = ids.users[userEmail];
                const role = userEmail === assignment.lead ? 'admin' : 'member';

                const existing = db.prepare(`
                    SELECT id FROM team_memberships WHERE team_id = ? AND user_id = ?
                `).get(teamId, userId);

                if (existing) continue;

                db.prepare(`
                    INSERT INTO team_memberships (id, team_id, user_id, role, status)
                    VALUES (?, ?, ?, ?, 'active')
                `).run(generateId(), teamId, userId, role);
                console.log(`  + ${userEmail} -> ${assignment.team} (${role})`);
            }
        }

        // ========================================
        // 8. SEED TAGS
        // ========================================
        console.log('\nSeeding tags...');

        for (const tag of TAGS) {
            const tagId = generateId();
            ids.tags[tag.slug] = tagId;

            const existing = db.prepare(`
                SELECT id FROM tags WHERE org_id = ? AND slug = ?
            `).get(primaryOrgId, tag.slug);

            if (existing) {
                ids.tags[tag.slug] = existing.id;
                console.log(`  - ${tag.name} (exists)`);
                continue;
            }

            db.prepare(`
                INSERT INTO tags (id, org_id, name, slug, description, color, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(tagId, primaryOrgId, tag.name, tag.slug, tag.description, tag.color, ids.users['admin@example.com']);

            stats.tags++;
            console.log(`  + ${tag.name}`);
        }

        // ========================================
        // 9. SEED TOOLS
        // ========================================
        console.log('\nSeeding tools...');
        const orgWidePolicy = ids.sharePolicies['example-org:org'];

        for (const tool of TOOLS) {
            const toolId = generateId();
            ids.tools[tool.slug] = toolId;

            const existing = db.prepare(`
                SELECT id FROM tools WHERE org_id = ? AND slug = ?
            `).get(primaryOrgId, tool.slug);

            if (existing) {
                ids.tools[tool.slug] = existing.id;
                console.log(`  - ${tool.name} (exists)`);
                continue;
            }

            const requiresApproval = ['high', 'critical'].includes(tool.riskLevel) ? 1 : 0;
            const specJson = JSON.stringify({
                type: tool.toolType,
                config: {},
                metadata: { icon: tool.icon }
            });

            db.prepare(`
                INSERT INTO tools (id, org_id, name, slug, description, tool_type, spec_json, risk_level,
                                   requires_approval, share_policy_id, status, created_by, published_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
            `).run(toolId, primaryOrgId, tool.name, tool.slug, tool.description, tool.toolType,
                   specJson, tool.riskLevel, requiresApproval, orgWidePolicy, ids.users['admin@example.com']);

            stats.tools++;
            console.log(`  + ${tool.name} (${tool.riskLevel})`);
        }

        // ========================================
        // 10. SEED WORKFLOWS
        // ========================================
        console.log('\nSeeding workflows...');

        for (const wf of WORKFLOWS) {
            const wfId = generateId();
            ids.workflows[wf.slug] = wfId;

            const existing = db.prepare(`
                SELECT id FROM workflows WHERE org_id = ? AND slug = ?
            `).get(primaryOrgId, wf.slug);

            if (existing) {
                ids.workflows[wf.slug] = existing.id;
                console.log(`  - ${wf.name} (exists)`);
                continue;
            }

            const definitionJson = JSON.stringify({
                nodes: [],
                edges: [],
                config: { version: 1 }
            });

            const triggerConfigJson = JSON.stringify({
                type: wf.triggerType,
                schedule: wf.triggerType === 'schedule' ? '0 0 * * *' : null
            });

            db.prepare(`
                INSERT INTO workflows (id, org_id, name, slug, description, definition_json,
                                       trigger_type, trigger_config_json, status, share_policy_id, created_by, published_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            `).run(wfId, primaryOrgId, wf.name, wf.slug, wf.description, definitionJson,
                   wf.triggerType, triggerConfigJson, wf.status, orgWidePolicy, ids.users['admin@example.com']);

            stats.workflows++;
            console.log(`  + ${wf.name} (${wf.triggerType})`);
        }

        // ========================================
        // 11. SEED ASSISTANTS
        // ========================================
        console.log('\nSeeding assistants...');

        for (const asst of ASSISTANTS) {
            const asstId = generateId();
            ids.assistants[asst.id] = asstId;

            const existing = db.prepare(`
                SELECT id FROM assistants WHERE org_id = ? AND slug = ?
            `).get(primaryOrgId, asst.id);

            if (existing) {
                ids.assistants[asst.id] = existing.id;
                console.log(`  - ${asst.name} (exists)`);
                continue;
            }

            const personaJson = JSON.stringify({
                shortName: asst.shortName,
                color: asst.color,
                specialty: asst.specialty,
                role: asst.role,
                level: asst.level,
                system_prompt: `You are ${asst.name}, a specialist in ${asst.specialty}.`
            });

            db.prepare(`
                INSERT INTO assistants (id, org_id, name, slug, description, persona_json,
                                        status, share_policy_id, created_by, published_at)
                VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, datetime('now'))
            `).run(asstId, primaryOrgId, asst.name, asst.id, asst.specialty, personaJson,
                   orgWidePolicy, ids.users['admin@example.com']);

            stats.assistants++;
            console.log(`  + ${asst.name} (${asst.role})`);
        }

        // ========================================
        // 11b. SEED SCOPE ASSISTANTS
        // ========================================
        console.log('\nSeeding scope assistants...');

        const scopeAssistants = [
            {
                slug: 'example-org-assistant',
                name: 'Example Organization Assistant',
                description: 'AI assistant for Example Organization',
                scopeKey: 'org:example-org',
                persona: {
                    system_prompt: 'You are the AI assistant for Example Organization. You help with organization-wide topics including strategic planning, company-wide policies, cross-division coordination, org-wide metrics and reporting, and executive-level decision support.',
                    role: 'specialist', level: 2, shortName: 'E', color: '#8b5cf6',
                    specialty: 'Example Organization', model: 'claude-sonnet-4-20250514', temperature: 0.7,
                    voice: null, tools: [], knowledge: []
                }
            },
            ...DIVISIONS.map(div => ({
                slug: `${div.slug}-assistant`,
                name: `${div.name} Assistant`,
                description: `AI assistant for ${div.name} division`,
                scopeKey: `div:${div.slug}`,
                persona: {
                    system_prompt: `You are the AI assistant for the ${div.name} division within Example Organization. You specialize in division-level operations including division strategy, departmental coordination, and resource allocation.`,
                    role: 'specialist', level: 2, shortName: div.name.charAt(0), color: '#a78bfa',
                    specialty: `${div.name} Division`, model: 'claude-sonnet-4-20250514', temperature: 0.7,
                    voice: null, tools: [], knowledge: []
                }
            })),
            ...DEPARTMENTS.map(dept => {
                const div = DIVISIONS.find(d => d.slug === dept.divisionSlug);
                return {
                    slug: `${dept.slug}-assistant`,
                    name: `${dept.name} Assistant`,
                    description: `AI assistant for ${dept.name} department`,
                    scopeKey: `dept:${dept.slug}`,
                    persona: {
                        system_prompt: `You are the AI assistant for the ${dept.name} department in the ${div?.name || 'Unknown'} division of Example Organization. You focus on department operations including daily workflows, team coordination, and project tracking.`,
                        role: 'specialist', level: 2, shortName: dept.name.charAt(0), color: '#3b82f6',
                        specialty: `${dept.name} Department`, model: 'claude-sonnet-4-20250514', temperature: 0.7,
                        voice: null, tools: [], knowledge: []
                    }
                };
            })
        ];

        for (const sa of scopeAssistants) {
            const scopeId = ids.scopes[sa.scopeKey];
            if (!scopeId) {
                console.log(`  ! ${sa.name} — scope ${sa.scopeKey} not found, skipping`);
                continue;
            }

            const existing = db.prepare(
                'SELECT id FROM assistants WHERE org_id = ? AND slug = ?'
            ).get(primaryOrgId, sa.slug);

            if (existing) {
                console.log(`  - ${sa.name} (exists)`);
                continue;
            }

            const saId = generateId();
            db.prepare(`
                INSERT INTO assistants (id, org_id, home_scope_id, name, slug, description,
                    persona_json, status, created_by, published_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
            `).run(saId, primaryOrgId, scopeId, sa.name, sa.slug, sa.description,
                   JSON.stringify(sa.persona), ids.users['admin@example.com']);

            stats.assistants++;
            console.log(`  + ${sa.name} (scope: ${sa.scopeKey})`);
        }

        // ========================================
        // 12. TAG ASSIGNMENTS
        // ========================================
        console.log('\nAssigning tags to assets...');

        const tagAssignments = [
            { assetType: 'tool', assetSlug: 'ssh-terminal', tags: ['production', 'critical'] },
            { assetType: 'tool', assetSlug: 'container-manager', tags: ['production', 'critical'] },
            { assetType: 'tool', assetSlug: 'metrics-dashboard', tags: ['monitoring', 'production'] },
            { assetType: 'tool', assetSlug: 'log-viewer', tags: ['monitoring'] },
            { assetType: 'workflow', assetSlug: 'daily-backup', tags: ['automated', 'production', 'critical'] },
            { assetType: 'workflow', assetSlug: 'security-scan', tags: ['automated', 'security'] },
            { assetType: 'workflow', assetSlug: 'incident-response', tags: ['security', 'critical'] },
            { assetType: 'workflow', assetSlug: 'deploy-application', tags: ['manual', 'production'] },
            { assetType: 'workflow', assetSlug: 'disaster-recovery', tags: ['manual', 'critical'] }
        ];

        for (const assignment of tagAssignments) {
            const assetId = assignment.assetType === 'tool'
                ? ids.tools[assignment.assetSlug]
                : ids.workflows[assignment.assetSlug];

            for (const tagSlug of assignment.tags) {
                const tagId = ids.tags[tagSlug];

                const existing = db.prepare(`
                    SELECT id FROM asset_tags WHERE asset_type = ? AND asset_id = ? AND tag_id = ?
                `).get(assignment.assetType, assetId, tagId);

                if (existing) continue;

                db.prepare(`
                    INSERT INTO asset_tags (id, asset_type, asset_id, tag_id)
                    VALUES (?, ?, ?, ?)
                `).run(generateId(), assignment.assetType, assetId, tagId);
            }
            console.log(`  + ${assignment.assetSlug}: ${assignment.tags.join(', ')}`);
        }

        // Commit transaction
        db.exec('COMMIT');

        // ========================================
        // PRINT SUMMARY
        // ========================================
        console.log('\n' + '='.repeat(60));
        console.log('SEED COMPLETE - SUMMARY');
        console.log('='.repeat(60));
        console.log(`
  Users:        ${stats.users} created
  Organizations: ${stats.orgs} created
  Divisions:    ${stats.divisions} created
  Departments:  ${stats.departments} created
  Teams:        ${stats.teams} created
  Scopes:       ${stats.scopes} created
  Tools:        ${stats.tools} created
  Workflows:    ${stats.workflows} created
  Assistants:   ${stats.assistants} created
  Tags:         ${stats.tags} created
  Memberships:  ${stats.memberships} created
`);

        console.log('Test Credentials:');
        console.log(`  All users password: ${testPassword}`);
        console.log('');
        console.log('Primary Organization: Example Organization');
        console.log('Secondary Organization: Acme Corp');
        console.log('');

    } catch (err) {
        db.exec('ROLLBACK');
        console.error('\nERROR:', err.message);
        throw err;
    } finally {
        db.close();
    }
}

// Run seed
seed().catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
});
