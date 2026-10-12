#!/usr/bin/env node
/**
 * Seed Test Custom Agent (SysCheck)
 *
 * Creates a test custom agent with system tools assigned to prove
 * the end-to-end custom agent pipeline works:
 *   DB agent → internal API → collector async lookup → tool execution
 *
 * Prerequisites:
 *   - Phase B.2 schema applied (agents, tool_definitions, tool_installations, agent_tool_assignments)
 *   - seed-tools.js already run (populates tool_definitions from JSON manifests)
 *
 * Usage:
 *   node scripts/seed-test-agent.js
 *   AUTH_DB_PATH=/path/to/db node scripts/seed-test-agent.js
 *
 * Creates:
 *   1. Agent: syscheck (L2 specialist, domains: ["system", "monitoring"])
 *   2. Tool installations for system.services, system.uptime (if not already installed)
 *   3. Agent-tool assignments linking syscheck → those tools
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';

// Database path
const DB_PATH = process.env.AUTH_DB_PATH || '/var/lib/quox/auth.db';

// Generate ULID-like ID
function ulid() {
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const time = Date.now().toString(32).toUpperCase().padStart(10, '0');
    const randomBytes = crypto.randomBytes(16);
    let rand = '';
    for (let i = 0; i < 16; i++) {
        rand += chars[randomBytes[i] % 32];
    }
    return time + rand;
}

// Tool entity IDs to assign to syscheck
const TOOL_IDS = ['system.services', 'system.uptime'];

async function seedTestAgent() {
    console.log('Seed Test Agent: SysCheck');
    console.log('========================');
    console.log(`Database: ${DB_PATH}`);
    console.log('');

    const db = new Database(DB_PATH);
    db.pragma('foreign_keys = ON');

    // Verify required tables exist
    const requiredTables = ['agents', 'tool_definitions', 'tool_installations', 'agent_tool_assignments'];
    for (const table of requiredTables) {
        const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
        if (!exists) {
            console.error(`Error: Table '${table}' does not exist. Run Phase B.2 migration first.`);
            db.close();
            process.exit(1);
        }
    }

    // Find the first org (for multi-tenant scoping)
    const org = db.prepare(`SELECT id FROM orgs LIMIT 1`).get();
    if (!org) {
        console.error('Error: No organization found. Create an org first.');
        db.close();
        process.exit(1);
    }
    console.log(`Using org: ${org.id}`);

    // 1. Create or update the SysCheck agent
    const existingAgent = db.prepare(`SELECT id FROM agents WHERE agent_id = ? AND org_id = ?`).get('syscheck', org.id);
    const agentDbId = existingAgent ? existingAgent.id : ulid();

    if (existingAgent) {
        console.log(`Agent 'syscheck' already exists (${agentDbId}), updating...`);
        db.prepare(`
            UPDATE agents SET
                name = 'SysCheck',
                description = 'System health checker — monitors services, uptime, and basic system status.',
                level = 2,
                domains_json = ?,
                capabilities_json = ?,
                system_prompt_additions = ?,
                status = 'active',
                updated_at = datetime('now')
            WHERE id = ?
        `).run(
            JSON.stringify(['system', 'monitoring']),
            JSON.stringify(['check_services', 'check_uptime', 'system_health']),
            'You specialize in checking system health. Use system_services to list running/stopped services and system_uptime to check how long hosts have been running. Be concise and report anomalies clearly.',
            agentDbId
        );
    } else {
        console.log('Creating agent: syscheck');
        db.prepare(`
            INSERT INTO agents (id, org_id, agent_id, name, description, level,
                domains_json, capabilities_json, system_prompt_additions, status)
            VALUES (?, ?, 'syscheck', 'SysCheck',
                'System health checker — monitors services, uptime, and basic system status.',
                2, ?, ?, ?, 'active')
        `).run(
            agentDbId,
            org.id,
            JSON.stringify(['system', 'monitoring']),
            JSON.stringify(['check_services', 'check_uptime', 'system_health']),
            'You specialize in checking system health. Use system_services to list running/stopped services and system_uptime to check how long hosts have been running. Be concise and report anomalies clearly.'
        );
    }
    console.log(`  + Agent 'syscheck' (id: ${agentDbId})`);

    // 2. Ensure tool_definitions exist for our tools
    let toolsMissing = false;
    for (const toolId of TOOL_IDS) {
        const toolDef = db.prepare(`SELECT id FROM tool_definitions WHERE tool_id = ?`).get(toolId);
        if (!toolDef) {
            console.error(`  ! Tool definition '${toolId}' not found. Run seed-tools.js first.`);
            toolsMissing = true;
        }
    }
    if (toolsMissing) {
        console.error('\nSome tool definitions are missing. Run: node scripts/seed-tools.js');
        db.close();
        process.exit(1);
    }

    // 3. Create tool_installations for each tool (if not already installed for this org)
    for (const toolId of TOOL_IDS) {
        const toolDef = db.prepare(`SELECT id FROM tool_definitions WHERE tool_id = ?`).get(toolId);

        const existingInstall = db.prepare(`
            SELECT id FROM tool_installations WHERE org_id = ? AND tool_definition_id = ?
        `).get(org.id, toolDef.id);

        let installId;
        if (existingInstall) {
            installId = existingInstall.id;
            console.log(`  ~ Tool '${toolId}' already installed (${installId})`);
        } else {
            installId = ulid();
            db.prepare(`
                INSERT INTO tool_installations (id, org_id, tool_definition_id, enabled)
                VALUES (?, ?, ?, 1)
            `).run(installId, org.id, toolDef.id);
            console.log(`  + Installed tool '${toolId}' (${installId})`);
        }

        // 4. Create agent_tool_assignment
        const existingAssignment = db.prepare(`
            SELECT id FROM agent_tool_assignments
            WHERE org_id = ? AND tool_installation_id = ? AND agent_id = 'syscheck'
        `).get(org.id, installId);

        if (existingAssignment) {
            // Re-enable if revoked
            db.prepare(`
                UPDATE agent_tool_assignments SET enabled = 1, revoked_at = NULL, updated_at = datetime('now')
                WHERE id = ?
            `).run(existingAssignment.id);
            console.log(`  ~ Assignment syscheck → ${toolId} already exists, re-enabled`);
        } else {
            const assignmentId = ulid();
            db.prepare(`
                INSERT INTO agent_tool_assignments (id, org_id, tool_installation_id, agent_id, access_mode, enabled)
                VALUES (?, ?, ?, 'syscheck', 'full', 1)
            `).run(assignmentId, org.id, installId);
            console.log(`  + Assigned syscheck → ${toolId} (${assignmentId})`);
        }
    }

    db.close();

    console.log('');
    console.log('Done! SysCheck agent is ready.');
    console.log('');
    console.log('Verify with:');
    console.log('  curl http://localhost:3101/internal/agents/syscheck/tools');
    console.log('  curl http://localhost:3101/internal/agents/syscheck/prompt');
}

seedTestAgent().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
