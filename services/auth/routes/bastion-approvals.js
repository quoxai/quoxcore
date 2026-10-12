/**
 * Bastion Approval Routes for Quox Auth Service
 * Phase C.1: Human-in-the-Loop (HITL) for bastion command execution
 *
 * Provides endpoints for:
 * - Command validation against denylist
 * - Request approval for dangerous commands
 * - View and manage pending approvals
 * - Approve/deny with HMAC execution tokens
 */

import { Router } from 'express';
import crypto from 'crypto';
import { prepare, transaction, getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgRole } from '../middleware/org.js';
import { requireHumanDecider } from '../utils/principal.js';
import { createAuditEvent, ulid, getPagination, formatPaginatedResponse, generateToken } from '../utils/helpers.js';
import { appendApprovalEvent, getApprovalEvents, verifyApprovalChain } from '../lib/approvalEvents.js';
import { witnessApprovalEvent } from '../lib/wardAdapter.js';

// AUDIT-REAL-1 — append a durable, hash-chained, signed approval_events row
// and best-effort witness it into WARD. NEVER throws — a failure here must
// never break the operational approval flow (pending_command_approvals is
// unaffected either way). Fire-and-forget by design, same contract as the
// existing WARD witnessing call sites (see wardAdapter.js).
function recordApprovalEvent({ orgId, approvalId, action, actorId, payload }) {
    try {
        const event = appendApprovalEvent({ orgId, approvalId, action, actorType: 'user', actorId, payload: payload || {} });
        witnessApprovalEvent(event).catch((err) => {
            console.warn('[AUDIT-REAL-1] approval WARD witness failed (non-fatal):', err.message);
        });
        return event;
    } catch (err) {
        console.error('[AUDIT-REAL-1] Failed to append approval_event (non-fatal, operational flow unaffected):', err.message);
        return null;
    }
}

const router = Router();

router.use(requireAuth);

// ============================================================================
// COMMAND DENYLIST PATTERNS
// ============================================================================

const DENIED_PATTERNS = [
    // CRITICAL - Always blocked (RED)
    {
        pattern: /rm\s+-rf\s+[\/~]/i,
        severity: 'RED',
        description: 'Recursive delete from root or home',
        blocked: true
    },
    {
        pattern: /rm\s+-rf\s+\/\*/i,
        severity: 'RED',
        description: 'Delete all files from root',
        blocked: true
    },
    {
        pattern: /dd\s+if=.*of=\/dev\/[sh]d/i,
        severity: 'RED',
        description: 'Direct disk write operation',
        blocked: true
    },
    {
        pattern: /mkfs\./i,
        severity: 'RED',
        description: 'Filesystem format operation',
        blocked: true
    },
    {
        pattern: />\s*\/dev\/[sh]d/i,
        severity: 'RED',
        description: 'Overwrite disk device',
        blocked: true
    },
    {
        pattern: /:\(\)\{.*:\|:.*\}/,
        severity: 'RED',
        description: 'Fork bomb detected',
        blocked: true
    },

    // VM/Container Destruction (RED - requires override)
    {
        pattern: /qm\s+destroy\s+\d+/i,
        severity: 'RED',
        description: 'VM destruction command',
        blocked: false,
        requires_override: true
    },
    {
        pattern: /pct\s+destroy\s+\d+/i,
        severity: 'RED',
        description: 'Container destruction command',
        blocked: false,
        requires_override: true
    },
    {
        pattern: /pvesh\s+delete/i,
        severity: 'RED',
        description: 'Proxmox resource deletion via API',
        blocked: false,
        requires_override: true
    },

    // Firewall/Network (RED - requires override)
    {
        pattern: /iptables\s+-F/i,
        severity: 'RED',
        description: 'Firewall flush - will drop all rules',
        blocked: false,
        requires_override: true
    },
    {
        pattern: /iptables\s+--flush/i,
        severity: 'RED',
        description: 'Firewall flush - will drop all rules',
        blocked: false,
        requires_override: true
    },
    {
        pattern: /ufw\s+disable/i,
        severity: 'RED',
        description: 'Disable firewall completely',
        blocked: false,
        requires_override: true
    },

    // System Power (ORANGE - requires approval)
    {
        pattern: /shutdown\s/i,
        severity: 'ORANGE',
        description: 'System shutdown command',
        blocked: false,
        requires_approval: true
    },
    {
        pattern: /reboot/i,
        severity: 'ORANGE',
        description: 'System reboot command',
        blocked: false,
        requires_approval: true
    },
    {
        pattern: /poweroff/i,
        severity: 'ORANGE',
        description: 'System power off command',
        blocked: false,
        requires_approval: true
    },
    {
        pattern: /init\s+0/i,
        severity: 'ORANGE',
        description: 'System halt via init',
        blocked: false,
        requires_approval: true
    },
    {
        pattern: /init\s+6/i,
        severity: 'ORANGE',
        description: 'System reboot via init',
        blocked: false,
        requires_approval: true
    },

    // Dangerous Permissions (ORANGE - requires approval)
    {
        pattern: /chmod\s+-R\s+777/i,
        severity: 'ORANGE',
        description: 'Recursive world-writable permissions',
        blocked: false,
        requires_approval: true
    },
    {
        pattern: /chown\s+-R\s+.*:/i,
        severity: 'ORANGE',
        description: 'Recursive ownership change',
        blocked: false,
        requires_approval: true
    },

    // Service Destruction (AMBER - warning only)
    {
        pattern: /systemctl\s+stop\s+/i,
        severity: 'AMBER',
        description: 'Service stop command',
        blocked: false,
        requires_warning: true
    },
    {
        pattern: /systemctl\s+disable\s+/i,
        severity: 'AMBER',
        description: 'Service disable command',
        blocked: false,
        requires_warning: true
    },
    {
        pattern: /docker\s+rm\s+-f/i,
        severity: 'AMBER',
        description: 'Force remove Docker container',
        blocked: false,
        requires_warning: true
    },
    {
        pattern: /docker\s+stop/i,
        severity: 'AMBER',
        description: 'Docker container stop',
        blocked: false,
        requires_warning: true
    },

    // Package Management (AMBER - warning only)
    {
        pattern: /apt\s+(remove|purge)\s+/i,
        severity: 'AMBER',
        description: 'Package removal',
        blocked: false,
        requires_warning: true
    },
    {
        pattern: /yum\s+(remove|erase)\s+/i,
        severity: 'AMBER',
        description: 'Package removal',
        blocked: false,
        requires_warning: true
    }
];

// Approval statuses
const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'cancelled'];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validate a command against the denylist
 * @param {string} command - Command to validate
 * @returns {Object} Validation result
 */
function validateCommand(command) {
    if (!command || typeof command !== 'string') {
        return {
            can_execute: false,
            requires_approval: false,
            requires_warning: false,
            severity: 'RED',
            description: 'Invalid command'
        };
    }

    for (const rule of DENIED_PATTERNS) {
        if (rule.pattern.test(command)) {
            if (rule.blocked) {
                return {
                    can_execute: false,
                    requires_approval: false,
                    requires_warning: false,
                    severity: rule.severity,
                    description: rule.description,
                    blocked: true
                };
            }

            if (rule.requires_override) {
                return {
                    can_execute: false,
                    requires_approval: true,
                    requires_warning: false,
                    severity: rule.severity,
                    description: rule.description,
                    requires_override: true
                };
            }

            if (rule.requires_approval) {
                return {
                    can_execute: false,
                    requires_approval: true,
                    requires_warning: false,
                    severity: rule.severity,
                    description: rule.description
                };
            }

            if (rule.requires_warning) {
                return {
                    can_execute: true,
                    requires_approval: false,
                    requires_warning: true,
                    severity: rule.severity,
                    description: rule.description
                };
            }
        }
    }

    // No matching rule - command is allowed
    return {
        can_execute: true,
        requires_approval: false,
        requires_warning: false,
        severity: 'GREEN',
        description: null
    };
}

/**
 * Ensure the pending_command_approvals table exists
 */
function ensureApprovalTable() {
    const db = getDb();

    // Check if table exists
    const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='pending_command_approvals'
    `).get();

    if (!tableExists) {
        console.log('Creating pending_command_approvals table...');
        db.exec(`
            CREATE TABLE IF NOT EXISTS pending_command_approvals (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                inbox_item_id TEXT REFERENCES inbox_items(id) ON DELETE SET NULL,

                -- Command details
                command TEXT NOT NULL,
                host_id TEXT NOT NULL,
                host_name TEXT,
                context_json TEXT DEFAULT '{}',

                -- Request metadata
                requested_by TEXT NOT NULL REFERENCES users(id),
                requested_at TEXT NOT NULL DEFAULT (datetime('now')),

                -- Approval status
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),

                -- Approval/denial details
                reviewed_by TEXT REFERENCES users(id),
                reviewed_at TEXT,
                review_comment TEXT,
                denial_reason TEXT,

                -- Execution token (HMAC signed, only valid after approval)
                execution_token_hash TEXT,
                token_expires_at TEXT,
                token_used_at TEXT,

                -- Timestamps
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_cmd_approvals_org ON pending_command_approvals(org_id);
            CREATE INDEX IF NOT EXISTS idx_cmd_approvals_status ON pending_command_approvals(status);
            CREATE INDEX IF NOT EXISTS idx_cmd_approvals_host ON pending_command_approvals(host_id);
            CREATE INDEX IF NOT EXISTS idx_cmd_approvals_inbox ON pending_command_approvals(inbox_item_id);
            CREATE INDEX IF NOT EXISTS idx_cmd_approvals_requested ON pending_command_approvals(requested_by);
            CREATE INDEX IF NOT EXISTS idx_cmd_approvals_expires ON pending_command_approvals(expires_at);
        `);
        console.log('pending_command_approvals table created');
    }
}

/**
 * Ensure user has a personal inbox in the org
 */
function ensurePersonalInbox(orgId, userId) {
    const existing = prepare(`
        SELECT id FROM inboxes
        WHERE org_id = ? AND owner_id = ? AND inbox_type = 'personal'
    `).get(orgId, userId);

    if (existing) {
        return existing.id;
    }

    const inboxId = ulid();
    prepare(`
        INSERT INTO inboxes (id, org_id, inbox_type, name, owner_id)
        VALUES (?, ?, 'personal', 'Personal Inbox', ?)
    `).run(inboxId, orgId, userId);

    return inboxId;
}

/**
 * Generate HMAC execution token for approved command
 * @param {string} approvalId - Approval record ID
 * @param {string} command - The approved command
 * @param {string} hostId - Target host ID
 * @returns {Object} Token and hash
 */
function generateExecutionToken(approvalId, command, hostId) {
    const secret = process.env.BASTION_TOKEN_SECRET || process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('BASTION_TOKEN_SECRET or JWT_SECRET must be set for execution token signing');
    }
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');

    // Create HMAC signature
    const data = `${approvalId}:${command}:${hostId}:${timestamp}:${nonce}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(data);
    const signature = hmac.digest('hex');

    // Create token (base64 encoded JSON)
    const tokenData = {
        aid: approvalId,
        ts: timestamp,
        n: nonce,
        sig: signature
    };
    const token = Buffer.from(JSON.stringify(tokenData)).toString('base64url');

    // Hash for storage
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    return {
        token,
        hash: tokenHash,
        expiresAt: new Date(timestamp + 60 * 60 * 1000).toISOString() // 1 hour expiry
    };
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * POST /orgs/:orgId/bastion/validate
 * Validate a command against the denylist
 *
 * Body: { command, host_id }
 * Returns: { can_execute, requires_approval, requires_warning, severity, description }
 */
router.post('/orgs/:orgId/bastion/validate', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { command, host_id } = req.body;
        const userId = req.user.id;

        if (!command) {
            return res.status(400).json({ error: 'Command is required' });
        }

        const result = validateCommand(command);

        // Audit the validation request
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'bastion.command_validated',
            targetType: 'host',
            targetId: host_id,
            metadata: {
                command: command.substring(0, 100), // Truncate for audit
                severity: result.severity,
                can_execute: result.can_execute,
                requires_approval: result.requires_approval
            }
        });

        res.json(result);
    } catch (error) {
        console.error('Error validating command:', error);
        res.status(500).json({ error: 'Failed to validate command' });
    }
});

/**
 * POST /orgs/:orgId/bastion/request-approval
 * Request approval for a dangerous command
 *
 * Body: { command, host_id, host_name, context }
 * Returns: { approval_id, inbox_item_id }
 */
router.post('/orgs/:orgId/bastion/request-approval', requireOrgMembership, async (req, res) => {
    try {
        ensureApprovalTable();

        const { orgId } = req.params;
        const { command, host_id, host_name, context } = req.body;
        const userId = req.user.id;

        if (!command || !host_id) {
            return res.status(400).json({ error: 'Command and host_id are required' });
        }

        // Validate the command first
        const validation = validateCommand(command);

        // Don't allow blocked commands
        if (validation.blocked) {
            return res.status(403).json({
                error: 'Command is blocked',
                severity: validation.severity,
                description: validation.description
            });
        }

        // Determine inbox item kind based on severity
        const itemKind = validation.requires_override ? 'override_required' : 'approval';
        const priority = validation.severity === 'RED' ? 'urgent' : 'high';

        const approvalId = ulid();
        const inboxItemId = ulid();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hour expiry

        // Get user's display name for the request
        const requester = prepare(`SELECT display_name FROM users WHERE id = ?`).get(userId);

        transaction(() => {
            // Get or create admin inbox for the org (approvals go to admins)
            // For now, use the requester's personal inbox - in production, route to admin team
            const targetInboxId = ensurePersonalInbox(orgId, userId);

            // Create inbox item
            const title = validation.requires_override
                ? `Override Required: ${validation.description}`
                : `Approval Required: ${validation.description || 'Command execution'}`;

            const body = `**Requested by:** ${requester?.display_name || 'Unknown'}\n` +
                `**Host:** ${host_name || host_id}\n` +
                `**Severity:** ${validation.severity}\n\n` +
                `**Command:**\n\`\`\`\n${command}\n\`\`\`\n\n` +
                (context ? `**Context:**\n${context}\n` : '');

            prepare(`
                INSERT INTO inbox_items (
                    id, org_id, inbox_id, kind, priority, title, body_md,
                    payload_json, due_at, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                inboxItemId, orgId, targetInboxId,
                itemKind, priority, title, body,
                JSON.stringify({
                    type: 'bastion_approval',
                    approval_id: approvalId,
                    command,
                    host_id,
                    host_name,
                    severity: validation.severity,
                    description: validation.description,
                    requires_override: validation.requires_override || false
                }),
                expiresAt,
                userId
            );

            // Assign to requester initially (should be routed to admins in production)
            prepare(`
                INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode)
                VALUES (?, ?, 'user', ?, 'anyone')
            `).run(ulid(), inboxItemId, userId);

            // Create pending approval record
            prepare(`
                INSERT INTO pending_command_approvals (
                    id, org_id, inbox_item_id, command, host_id, host_name,
                    context_json, requested_by, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                approvalId, orgId, inboxItemId, command, host_id, host_name,
                JSON.stringify(context || {}), userId, expiresAt
            );
        });

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'bastion.approval_requested',
            targetType: 'pending_command_approval',
            targetId: approvalId,
            metadata: {
                command: command.substring(0, 100),
                host_id,
                severity: validation.severity,
                inbox_item_id: inboxItemId
            }
        });

        // AUDIT-REAL-1 — durable, hash-chained, signed audit record of the
        // "created" lifecycle transition (in addition to the operational
        // pending_command_approvals row and the mutable audit_events row above).
        recordApprovalEvent({
            orgId,
            approvalId,
            action: 'created',
            actorId: userId,
            payload: {
                host_id,
                host_name: host_name || null,
                severity: validation.severity,
                description: validation.description || null,
                requires_override: validation.requires_override || false,
                command_hash: crypto.createHash('sha256').update(command).digest('hex'),
            },
        });

        res.status(201).json({
            approval_id: approvalId,
            inbox_item_id: inboxItemId,
            status: 'pending',
            expires_at: expiresAt,
            severity: validation.severity,
            description: validation.description
        });
    } catch (error) {
        console.error('Error requesting approval:', error);
        res.status(500).json({ error: 'Failed to request approval' });
    }
});

/**
 * GET /orgs/:orgId/bastion/approvals
 * List pending approvals for the org
 *
 * Query: status, host_id
 * Returns: Paginated list of approvals
 */
router.get('/orgs/:orgId/bastion/approvals', requireOrgMembership, async (req, res) => {
    try {
        ensureApprovalTable();

        const { orgId } = req.params;
        const { status, host_id, page, limit } = req.query;
        const pagination = getPagination({ page, limit });

        let conditions = ['pca.org_id = ?'];
        let params = [orgId];

        if (status) {
            conditions.push('pca.status = ?');
            params.push(status);
        }

        if (host_id) {
            conditions.push('pca.host_id = ?');
            params.push(host_id);
        }

        // Count total
        const countResult = prepare(`
            SELECT COUNT(*) as total FROM pending_command_approvals pca
            WHERE ${conditions.join(' AND ')}
        `).get(...params);

        // Get approvals with user info
        const approvals = prepare(`
            SELECT pca.*,
                   req.display_name as requester_name,
                   req.primary_email as requester_email,
                   rev.display_name as reviewer_name,
                   ii.status as inbox_status
            FROM pending_command_approvals pca
            LEFT JOIN users req ON pca.requested_by = req.id
            LEFT JOIN users rev ON pca.reviewed_by = rev.id
            LEFT JOIN inbox_items ii ON pca.inbox_item_id = ii.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY pca.created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        // Parse JSON fields and redact sensitive data
        const enrichedApprovals = approvals.map(approval => ({
            id: approval.id,
            org_id: approval.org_id,
            inbox_item_id: approval.inbox_item_id,
            command: approval.command,
            host_id: approval.host_id,
            host_name: approval.host_name,
            context: approval.context_json ? JSON.parse(approval.context_json) : {},
            status: approval.status,
            requester: {
                id: approval.requested_by,
                name: approval.requester_name,
                email: approval.requester_email
            },
            reviewer: approval.reviewed_by ? {
                id: approval.reviewed_by,
                name: approval.reviewer_name
            } : null,
            review_comment: approval.review_comment,
            denial_reason: approval.denial_reason,
            requested_at: approval.requested_at,
            reviewed_at: approval.reviewed_at,
            expires_at: approval.expires_at,
            created_at: approval.created_at
        }));

        res.json(formatPaginatedResponse(enrichedApprovals, countResult.total, pagination));
    } catch (error) {
        console.error('Error listing approvals:', error);
        res.status(500).json({ error: 'Failed to list approvals' });
    }
});

/**
 * GET /orgs/:orgId/bastion/approvals/:id
 * Get a single approval with full details
 */
router.get('/orgs/:orgId/bastion/approvals/:id', requireOrgMembership, async (req, res) => {
    try {
        ensureApprovalTable();

        const { orgId, id } = req.params;

        const approval = prepare(`
            SELECT pca.*,
                   req.display_name as requester_name,
                   req.primary_email as requester_email,
                   rev.display_name as reviewer_name,
                   ii.status as inbox_status,
                   ii.title as inbox_title,
                   ii.body_md as inbox_body,
                   ii.priority as inbox_priority
            FROM pending_command_approvals pca
            LEFT JOIN users req ON pca.requested_by = req.id
            LEFT JOIN users rev ON pca.reviewed_by = rev.id
            LEFT JOIN inbox_items ii ON pca.inbox_item_id = ii.id
            WHERE pca.id = ? AND pca.org_id = ?
        `).get(id, orgId);

        if (!approval) {
            return res.status(404).json({ error: 'Approval not found' });
        }

        res.json({
            id: approval.id,
            org_id: approval.org_id,
            inbox_item_id: approval.inbox_item_id,
            command: approval.command,
            host_id: approval.host_id,
            host_name: approval.host_name,
            context: approval.context_json ? JSON.parse(approval.context_json) : {},
            status: approval.status,
            requester: {
                id: approval.requested_by,
                name: approval.requester_name,
                email: approval.requester_email
            },
            reviewer: approval.reviewed_by ? {
                id: approval.reviewed_by,
                name: approval.reviewer_name
            } : null,
            review_comment: approval.review_comment,
            denial_reason: approval.denial_reason,
            requested_at: approval.requested_at,
            reviewed_at: approval.reviewed_at,
            expires_at: approval.expires_at,
            token_expires_at: approval.token_expires_at,
            token_used_at: approval.token_used_at,
            created_at: approval.created_at,
            inbox: approval.inbox_item_id ? {
                id: approval.inbox_item_id,
                status: approval.inbox_status,
                title: approval.inbox_title,
                priority: approval.inbox_priority
            } : null
        });
    } catch (error) {
        console.error('Error getting approval:', error);
        res.status(500).json({ error: 'Failed to get approval' });
    }
});

/**
 * POST /orgs/:orgId/bastion/approvals/:id/approve
 * Approve a pending command execution request
 *
 * Body: { comment }
 * Returns: { approved: true, execution_token }
 */
router.post('/orgs/:orgId/bastion/approvals/:id/approve', requireOrgMembership, requireOrgRole('admin'), async (req, res) => {
    try {
        if (!requireHumanDecider(req, res)) return;
        ensureApprovalTable();

        const { orgId, id } = req.params;
        const { comment } = req.body;
        const userId = req.user.id;

        const approval = prepare(`
            SELECT * FROM pending_command_approvals
            WHERE id = ? AND org_id = ?
        `).get(id, orgId);

        if (!approval) {
            return res.status(404).json({ error: 'Approval not found' });
        }

        if (approval.status !== 'pending') {
            return res.status(400).json({
                error: 'Approval is not pending',
                current_status: approval.status
            });
        }

        // Check if expired
        if (new Date(approval.expires_at) < new Date()) {
            prepare(`
                UPDATE pending_command_approvals SET status = 'expired', updated_at = datetime('now')
                WHERE id = ?
            `).run(id);

            recordApprovalEvent({
                orgId,
                approvalId: id,
                action: 'expired',
                actorId: userId,
                payload: { host_id: approval.host_id, expires_at: approval.expires_at },
            });

            return res.status(400).json({ error: 'Approval has expired' });
        }

        // Generate execution token
        const { token, hash, expiresAt } = generateExecutionToken(
            approval.id,
            approval.command,
            approval.host_id
        );

        transaction(() => {
            // Update approval record
            prepare(`
                UPDATE pending_command_approvals
                SET status = 'approved',
                    reviewed_by = ?,
                    reviewed_at = datetime('now'),
                    review_comment = ?,
                    execution_token_hash = ?,
                    token_expires_at = ?,
                    updated_at = datetime('now')
                WHERE id = ?
            `).run(userId, comment || null, hash, expiresAt, id);

            // Update inbox item
            if (approval.inbox_item_id) {
                prepare(`
                    UPDATE inbox_items
                    SET status = 'resolved',
                        response_json = ?,
                        resolved_by = ?,
                        resolved_at = datetime('now')
                    WHERE id = ?
                `).run(JSON.stringify({
                    action: 'approve',
                    comment,
                    responded_by: userId,
                    responded_at: new Date().toISOString()
                }), userId, approval.inbox_item_id);
            }
        });

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'bastion.approval_approved',
            targetType: 'pending_command_approval',
            targetId: id,
            metadata: {
                command: approval.command.substring(0, 100),
                host_id: approval.host_id,
                requested_by: approval.requested_by,
                comment
            }
        });

        recordApprovalEvent({
            orgId,
            approvalId: id,
            action: 'approved',
            actorId: userId,
            payload: {
                host_id: approval.host_id,
                requested_by: approval.requested_by,
                comment: comment || null,
                command_hash: crypto.createHash('sha256').update(approval.command).digest('hex'),
            },
        });

        res.json({
            approved: true,
            execution_token: token,
            token_expires_at: expiresAt,
            approval_id: id,
            host_id: approval.host_id,
            command: approval.command
        });
    } catch (error) {
        console.error('Error approving request:', error);
        res.status(500).json({ error: 'Failed to approve request' });
    }
});

/**
 * POST /orgs/:orgId/bastion/approvals/:id/deny
 * Deny a pending command execution request
 *
 * Body: { reason }
 * Returns: { denied: true }
 */
router.post('/orgs/:orgId/bastion/approvals/:id/deny', requireOrgMembership, requireOrgRole('admin'), async (req, res) => {
    try {
        if (!requireHumanDecider(req, res)) return;
        ensureApprovalTable();

        const { orgId, id } = req.params;
        const { reason } = req.body;
        const userId = req.user.id;

        if (!reason) {
            return res.status(400).json({ error: 'Denial reason is required' });
        }

        const approval = prepare(`
            SELECT * FROM pending_command_approvals
            WHERE id = ? AND org_id = ?
        `).get(id, orgId);

        if (!approval) {
            return res.status(404).json({ error: 'Approval not found' });
        }

        if (approval.status !== 'pending') {
            return res.status(400).json({
                error: 'Approval is not pending',
                current_status: approval.status
            });
        }

        transaction(() => {
            // Update approval record
            prepare(`
                UPDATE pending_command_approvals
                SET status = 'denied',
                    reviewed_by = ?,
                    reviewed_at = datetime('now'),
                    denial_reason = ?,
                    updated_at = datetime('now')
                WHERE id = ?
            `).run(userId, reason, id);

            // Update inbox item
            if (approval.inbox_item_id) {
                prepare(`
                    UPDATE inbox_items
                    SET status = 'resolved',
                        response_json = ?,
                        resolved_by = ?,
                        resolved_at = datetime('now')
                    WHERE id = ?
                `).run(JSON.stringify({
                    action: 'deny',
                    reason,
                    responded_by: userId,
                    responded_at: new Date().toISOString()
                }), userId, approval.inbox_item_id);
            }
        });

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'bastion.approval_denied',
            targetType: 'pending_command_approval',
            targetId: id,
            metadata: {
                command: approval.command.substring(0, 100),
                host_id: approval.host_id,
                requested_by: approval.requested_by,
                reason
            }
        });

        recordApprovalEvent({
            orgId,
            approvalId: id,
            action: 'rejected',
            actorId: userId,
            payload: {
                host_id: approval.host_id,
                requested_by: approval.requested_by,
                reason,
                command_hash: crypto.createHash('sha256').update(approval.command).digest('hex'),
            },
        });

        res.json({
            denied: true,
            approval_id: id,
            reason
        });
    } catch (error) {
        console.error('Error denying request:', error);
        res.status(500).json({ error: 'Failed to deny request' });
    }
});

/**
 * POST /orgs/:orgId/bastion/approvals/:id/cancel
 * Cancel a pending approval request (by requester)
 */
router.post('/orgs/:orgId/bastion/approvals/:id/cancel', requireOrgMembership, async (req, res) => {
    try {
        ensureApprovalTable();

        const { orgId, id } = req.params;
        const userId = req.user.id;

        const approval = prepare(`
            SELECT * FROM pending_command_approvals
            WHERE id = ? AND org_id = ?
        `).get(id, orgId);

        if (!approval) {
            return res.status(404).json({ error: 'Approval not found' });
        }

        // Only requester or admin can cancel
        if (approval.requested_by !== userId && req.orgMembership.role !== 'admin' && req.orgMembership.role !== 'owner') {
            return res.status(403).json({ error: 'Only the requester or an admin can cancel this request' });
        }

        if (approval.status !== 'pending') {
            return res.status(400).json({
                error: 'Approval is not pending',
                current_status: approval.status
            });
        }

        transaction(() => {
            prepare(`
                UPDATE pending_command_approvals
                SET status = 'cancelled',
                    reviewed_by = ?,
                    reviewed_at = datetime('now'),
                    updated_at = datetime('now')
                WHERE id = ?
            `).run(userId, id);

            if (approval.inbox_item_id) {
                prepare(`
                    UPDATE inbox_items
                    SET status = 'cancelled',
                        deleted_at = datetime('now')
                    WHERE id = ?
                `).run(approval.inbox_item_id);
            }
        });

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'bastion.approval_cancelled',
            targetType: 'pending_command_approval',
            targetId: id,
            metadata: {
                command: approval.command.substring(0, 100),
                host_id: approval.host_id
            }
        });

        recordApprovalEvent({
            orgId,
            approvalId: id,
            action: 'cancelled',
            actorId: userId,
            payload: {
                host_id: approval.host_id,
                command_hash: crypto.createHash('sha256').update(approval.command).digest('hex'),
            },
        });

        res.json({
            cancelled: true,
            approval_id: id
        });
    } catch (error) {
        console.error('Error cancelling request:', error);
        res.status(500).json({ error: 'Failed to cancel request' });
    }
});

/**
 * POST /orgs/:orgId/bastion/verify-token
 * Verify an execution token is valid (used by bastion service)
 *
 * Body: { token, command, host_id }
 * Returns: { valid: true, approval_id } or { valid: false, reason }
 */
router.post('/orgs/:orgId/bastion/verify-token', requireOrgMembership, async (req, res) => {
    try {
        ensureApprovalTable();

        const { orgId } = req.params;
        const { token, command, host_id } = req.body;

        if (!token) {
            return res.status(400).json({ valid: false, reason: 'Token is required' });
        }

        // Decode token
        let tokenData;
        try {
            tokenData = JSON.parse(Buffer.from(token, 'base64url').toString());
        } catch {
            return res.json({ valid: false, reason: 'Invalid token format' });
        }

        // Hash token for lookup
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        // Find approval by token hash
        const approval = prepare(`
            SELECT * FROM pending_command_approvals
            WHERE execution_token_hash = ? AND org_id = ?
        `).get(tokenHash, orgId);

        if (!approval) {
            return res.json({ valid: false, reason: 'Token not found' });
        }

        if (approval.status !== 'approved') {
            return res.json({ valid: false, reason: 'Approval not approved' });
        }

        if (approval.token_used_at) {
            return res.json({ valid: false, reason: 'Token already used' });
        }

        if (new Date(approval.token_expires_at) < new Date()) {
            return res.json({ valid: false, reason: 'Token expired' });
        }

        // Verify command and host match
        if (command && approval.command !== command) {
            return res.json({ valid: false, reason: 'Command mismatch' });
        }

        if (host_id && approval.host_id !== host_id) {
            return res.json({ valid: false, reason: 'Host mismatch' });
        }

        // Verify HMAC signature
        const secret = process.env.BASTION_TOKEN_SECRET || process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('BASTION_TOKEN_SECRET or JWT_SECRET must be set for execution token signing');
    }
        const data = `${tokenData.aid}:${approval.command}:${approval.host_id}:${tokenData.ts}:${tokenData.n}`;
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(data);
        const expectedSig = hmac.digest('hex');

        if (tokenData.sig !== expectedSig) {
            return res.json({ valid: false, reason: 'Invalid signature' });
        }

        // Mark token as used
        prepare(`
            UPDATE pending_command_approvals
            SET token_used_at = datetime('now'),
                updated_at = datetime('now')
            WHERE id = ?
        `).run(approval.id);

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user.id,
            action: 'bastion.token_verified',
            targetType: 'pending_command_approval',
            targetId: approval.id,
            metadata: {
                command: approval.command.substring(0, 100),
                host_id: approval.host_id
            }
        });

        res.json({
            valid: true,
            approval_id: approval.id,
            command: approval.command,
            host_id: approval.host_id,
            approved_by: approval.reviewed_by,
            approved_at: approval.reviewed_at
        });
    } catch (error) {
        console.error('Error verifying token:', error);
        res.status(500).json({ valid: false, reason: 'Verification failed' });
    }
});

// ============================================================================
// AUDIT-REAL-1 — durable approval audit log (read-only)
// ============================================================================

/**
 * GET /orgs/:orgId/bastion/approval-events
 * List the org's append-only approval audit log.
 *
 * Query: approval_id (optional filter to one approval's lifecycle)
 */
router.get('/orgs/:orgId/bastion/approval-events', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { approval_id } = req.query;

        const events = getApprovalEvents(orgId, { approvalId: approval_id || undefined });

        res.json({
            events: events.map(e => ({
                id: e.id,
                approval_id: e.approval_id,
                seq: e.seq,
                action: e.action,
                actor_type: e.actor_type,
                actor_id: e.actor_id,
                payload: JSON.parse(e.payload_json || '{}'),
                payload_hash: e.payload_hash,
                prev_hash: e.prev_hash,
                event_hash: e.event_hash,
                signed: !!e.signature,
                key_id: e.key_id,
                created_at: e.created_at,
            })),
        });
    } catch (error) {
        console.error('Error listing approval events:', error);
        res.status(500).json({ error: 'Failed to list approval events' });
    }
});

/**
 * GET /orgs/:orgId/bastion/approval-events/verify
 * Verify the org's approval audit chain: recomputes every hash, checks
 * prev_hash linkage and sequence contiguity, and Ed25519-verifies every
 * signature. Returns INTACT only if no event was altered, reordered, or
 * removed since it was appended.
 */
router.get('/orgs/:orgId/bastion/approval-events/verify', requireOrgMembership, requireOrgRole('admin'), async (req, res) => {
    try {
        const { orgId } = req.params;
        const result = verifyApprovalChain(orgId);
        res.status(result.status === 'INTACT' ? 200 : 409).json(result);
    } catch (error) {
        console.error('Error verifying approval chain:', error);
        res.status(500).json({ error: 'Failed to verify approval chain' });
    }
});

export default router;
