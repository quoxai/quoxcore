import { prepare } from '../db/index.js';
import { createAuditEvent, ulid } from '../utils/helpers.js';
import { MODEL_CATALOG } from '../../../src/config/modelCatalog.js';
import { getSeedLlmRoutingPolicy } from '../../../shared/llm-routing/seedPolicy.js';
import { validateLlmRoutingPolicy } from '../../../shared/llm-routing/validate.js';

function safeParseJson(raw, fallback = null) {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export function getEffectiveLlmRoutingPolicy(orgId) {
    const row = prepare(`
        SELECT id, org_id, name, policy_json, enabled, version, created_by, created_at, updated_at
        FROM llm_routing_policies
        WHERE org_id = ? AND enabled = 1
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
    `).get(orgId);

    if (!row) {
        const seedPolicy = getSeedLlmRoutingPolicy();
        return {
            source: 'seed',
            policy: seedPolicy,
            record: null,
        };
    }

    return {
        source: 'org',
        policy: safeParseJson(row.policy_json, getSeedLlmRoutingPolicy()),
        record: {
            id: row.id,
            org_id: row.org_id,
            name: row.name,
            enabled: !!row.enabled,
            version: row.version,
            created_by: row.created_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
        },
    };
}

export function validateStoredLlmRoutingPolicy(policy) {
    return validateLlmRoutingPolicy(policy, {
        modelCatalog: MODEL_CATALOG,
    });
}

export function saveLlmRoutingPolicy({ orgId, userId, policy, ipAddress = null, userAgent = null }) {
    const id = ulid();
    const now = new Date().toISOString();
    const validation = validateStoredLlmRoutingPolicy(policy);

    if (!validation.valid) {
        return {
            ok: false,
            errors: validation.errors,
        };
    }

    prepare(`
        INSERT INTO llm_routing_policies (
            id, org_id, name, policy_json, enabled, version, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(org_id) DO UPDATE SET
            name = excluded.name,
            policy_json = excluded.policy_json,
            enabled = excluded.enabled,
            version = excluded.version,
            created_by = excluded.created_by,
            updated_at = excluded.updated_at
    `).run(
        id,
        orgId,
        policy?.metadata?.label || 'Org Execution Policy',
        JSON.stringify(policy),
        policy.version,
        userId,
        now,
        now,
    );

    createAuditEvent({
        orgId,
        actorType: 'user',
        actorId: userId,
        action: 'llm_routing_policy.updated',
        targetType: 'llm_routing_policy',
        targetId: orgId,
        ipAddress,
        userAgent,
        metadata: {
            policy_id: policy.policy_id,
            version: policy.version,
            label: policy?.metadata?.label || 'Org Execution Policy',
        },
    });

    return {
        ok: true,
        policy,
    };
}

