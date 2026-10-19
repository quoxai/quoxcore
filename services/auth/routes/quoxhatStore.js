/**
 * QUOXHAT P1 — authoritative hat store (auth service, SQLite).
 *
 * Follows the llm_routing_policies precedent (routes/llmRoutingPolicy.js):
 * org-scoped server-side records, validated on write, audited on change.
 * Three objects (QUOXHAT_STUDY.md §3): hat record -> immutable revisions
 * (definition + sha256 digest) -> selection state (org default, user pref,
 * conversation binding). P1 stores and selects; NOTHING here changes what
 * a chat turn executes until P2 wires the collector turn manifest.
 */

import { createHash } from 'crypto';
import { getDb, prepare, transaction } from '../db/index.js';
import { createAuditEvent, ulid } from '../utils/helpers.js';
import {
    validateHatDefinition,
    canonicalizeHatDefinition,
} from '../../../shared/quoxhat/contract.js';
import { HAT_TEMPLATES } from '../../../shared/quoxhat/templates.js';

function nowIso() { return new Date().toISOString(); }

function digestDefinition(definition) {
    return createHash('sha256').update(canonicalizeHatDefinition(definition)).digest('hex');
}

function safeParse(raw, fallback = null) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
}

/**
 * L2 — a concurrent writer can race the (hat_id, revision) INSERT between
 * reading current_revision and writing current_revision + 1. better-sqlite3
 * surfaces that as a thrown primary-key constraint error; callers should
 * return 409 (retryable) instead of letting it fall through as a 500.
 */
function isRevisionConflict(err) {
    return !!err && (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || /UNIQUE constraint failed: quoxhat_revisions/.test(err.message || ''));
}

function rowToHat(row, { withDefinition = false } = {}) {
    if (!row) return null;
    const hat = {
        id: row.id,
        org_id: row.org_id,
        key: row.key,
        name: row.name,
        purpose: row.purpose,
        owner_user_id: row.owner_user_id || null,
        visibility: row.visibility,
        status: row.status,
        template_key: row.template_key || null,
        template_version: row.template_version || null,
        // #721: the built-in template's latest version, so a reader can see an
        // org-customised built-in that is behind (fix via reset-to-template).
        template_latest: (row.template_key && HAT_TEMPLATES[row.template_key]?.template_version) || null,
        current_revision: row.current_revision,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
    if (withDefinition) {
        const rev = prepare(`
            SELECT revision, definition_json, digest, change_reason, created_by, created_at
            FROM quoxhat_revisions WHERE hat_id = ? AND revision = ?
        `).get(row.id, row.current_revision);
        hat.definition = safeParse(rev?.definition_json, null);
        hat.digest = rev?.digest || null;
    }
    return hat;
}

/** Every tool name a hat definition names (explicit + bundles), for audit diffs. */
function hatToolNames(def) {
    const explicit = Array.isArray(def?.tools?.explicit) ? def.tools.explicit : [];
    const bundled = Array.isArray(def?.tools?.bundles)
        ? def.tools.bundles.flatMap(b => (Array.isArray(b?.tools) ? b.tools : []))
        : [];
    return [...explicit, ...bundled];
}

/**
 * Lazily install built-in templates into org-owned records. Non-destructive
 * by construction: a hat whose latest revision was authored by an org user
 * is NEVER touched; a template upgrade appends a reviewable revision only
 * when every existing revision is still template-authored (study §3).
 */
export function ensureBuiltinHats(orgId) {
    const installed = [];
    const tx = getDb().transaction(() => {
        for (const [key, tpl] of Object.entries(HAT_TEMPLATES)) {
            const existing = prepare('SELECT * FROM quoxhat_hats WHERE org_id = ? AND key = ?').get(orgId, key);
            const templateAuthor = `template:${key}@${tpl.template_version}`;
            if (!existing) {
                const id = ulid();
                const now = nowIso();
                const digest = digestDefinition(tpl.definition);
                prepare(`
                    INSERT INTO quoxhat_hats (id, org_id, key, name, purpose, owner_user_id, visibility, status,
                        template_key, template_version, current_revision, created_by, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, NULL, 'org', 'preview', ?, ?, 1, ?, ?, ?)
                `).run(id, orgId, key, tpl.name, tpl.definition.purpose, key, tpl.template_version, templateAuthor, now, now);
                prepare(`
                    INSERT INTO quoxhat_revisions (hat_id, revision, definition_json, digest, change_reason, created_by, created_at)
                    VALUES (?, 1, ?, ?, 'built-in template install', ?, ?)
                `).run(id, JSON.stringify(tpl.definition), digest, templateAuthor, now);
                installed.push(key);
                continue;
            }
            // Upgrade path: only when the org has never authored a revision.
            if ((existing.template_version || 0) < tpl.template_version) {
                const orgAuthored = prepare(`
                    SELECT COUNT(*) AS n FROM quoxhat_revisions
                    WHERE hat_id = ? AND created_by NOT LIKE 'template:%'
                `).get(existing.id).n;
                if (orgAuthored === 0) {
                    const nextRev = existing.current_revision + 1;
                    const now = nowIso();
                    const digest = digestDefinition(tpl.definition);
                    const prevDef = safeParse(prepare(
                        'SELECT definition_json FROM quoxhat_revisions WHERE hat_id = ? AND revision = ?'
                    ).get(existing.id, existing.current_revision)?.definition_json, {});
                    prepare(`
                        INSERT INTO quoxhat_revisions (hat_id, revision, definition_json, digest, change_reason, created_by, created_at)
                        VALUES (?, ?, ?, ?, 'built-in template upgrade', ?, ?)
                    `).run(existing.id, nextRev, JSON.stringify(tpl.definition), digest, templateAuthor, now);
                    prepare(`
                        UPDATE quoxhat_hats SET current_revision = ?, template_version = ?, name = ?, purpose = ?, updated_at = ?
                        WHERE id = ?
                    `).run(nextRev, tpl.template_version, tpl.name, tpl.definition.purpose, now, existing.id);
                    // #721: a template upgrade changes what an org's turns are shown,
                    // so it is audited like every other hat mutation (it used to be
                    // silent). The next turn's quoxhat.manifest.resolved envelope
                    // (WARD-witnessed) then carries the new revision + digest.
                    const before = new Set(hatToolNames(prevDef));
                    const after = new Set(hatToolNames(tpl.definition));
                    createAuditEvent({
                        orgId, actorType: 'system', actorId: templateAuthor,
                        action: 'quoxhat.hat.template_upgraded', targetType: 'quoxhat_hat', targetId: existing.id,
                        metadata: {
                            key,
                            from_revision: existing.current_revision,
                            revision: nextRev,
                            from_template_version: existing.template_version || 0,
                            template_version: tpl.template_version,
                            digest,
                            tools_added: [...after].filter(t => !before.has(t)).sort(),
                            tools_removed: [...before].filter(t => !after.has(t)).sort(),
                        },
                    });
                    installed.push(`${key}@upgraded`);
                }
            }
        }
    });
    tx();
    return installed;
}

/** List hats visible to a user: org hats + their own private hats. */
export function listHats(orgId, userId) {
    ensureBuiltinHats(orgId);
    const rows = prepare(`
        SELECT * FROM quoxhat_hats
        WHERE org_id = ? AND (visibility = 'org' OR owner_user_id = ?)
        ORDER BY template_key IS NULL, key
    `).all(orgId, userId || '');
    return rows.map(r => rowToHat(r, { withDefinition: true }));
}

export function getHat(orgId, hatId, userId, { revision = null } = {}) {
    const row = prepare('SELECT * FROM quoxhat_hats WHERE org_id = ? AND id = ?').get(orgId, hatId);
    if (!row) return null;
    if (row.visibility === 'private' && row.owner_user_id !== userId) return null;
    const hat = rowToHat(row, { withDefinition: true });
    // #721 (b): read-only historical view for `quox hat show --rev n`.
    // current_revision still names the live revision; revision_shown says
    // which one the definition/digest below belong to.
    hat.revision_shown = hat.current_revision;
    if (revision !== null && revision !== undefined && Number(revision) !== row.current_revision) {
        const rev = prepare(`
            SELECT revision, definition_json, digest FROM quoxhat_revisions WHERE hat_id = ? AND revision = ?
        `).get(row.id, Number(revision));
        if (!rev) return null;
        hat.definition = safeParse(rev.definition_json, null);
        hat.digest = rev.digest;
        hat.revision_shown = rev.revision;
    }
    hat.revisions = prepare(`
        SELECT revision, digest, change_reason, created_by, created_at
        FROM quoxhat_revisions WHERE hat_id = ? ORDER BY revision DESC
    `).all(row.id);
    return hat;
}

/**
 * Create a custom hat (org-owned or user-private). Revision 1 is minted
 * atomically; validation failures reject the whole write.
 */
export function createHat({ orgId, userId, key, name, definition, visibility = 'org', ipAddress = null, userAgent = null }) {
    const validation = validateHatDefinition(definition);
    if (!validation.valid) return { ok: false, errors: validation.errors };
    if (!key || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(key)) {
        return { ok: false, errors: ['key must be a lowercase slug (a-z, 0-9, hyphen)'] };
    }
    if (!name || typeof name !== 'string') return { ok: false, errors: ['name is required'] };
    if (!['org', 'private'].includes(visibility)) return { ok: false, errors: ['visibility must be org or private'] };

    const existing = prepare('SELECT id FROM quoxhat_hats WHERE org_id = ? AND key = ?').get(orgId, key);
    if (existing) return { ok: false, errors: [`a hat with key '${key}' already exists in this org`] };

    const id = ulid();
    const now = nowIso();
    const digest = digestDefinition(definition);
    transaction(() => {
        prepare(`
            INSERT INTO quoxhat_hats (id, org_id, key, name, purpose, owner_user_id, visibility, status,
                template_key, template_version, current_revision, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'preview', NULL, NULL, 1, ?, ?, ?)
        `).run(id, orgId, key, name, definition.purpose, visibility === 'private' ? userId : null, visibility, userId, now, now);
        prepare(`
            INSERT INTO quoxhat_revisions (hat_id, revision, definition_json, digest, change_reason, created_by, created_at)
            VALUES (?, 1, ?, ?, 'created', ?, ?)
        `).run(id, JSON.stringify(definition), digest, userId, now);
    });
    createAuditEvent({
        orgId, actorType: 'user', actorId: userId,
        action: 'quoxhat.hat.created', targetType: 'quoxhat_hat', targetId: id,
        ipAddress, userAgent,
        metadata: { key, name, visibility, digest },
    });
    return { ok: true, hat: getHat(orgId, id, userId), warnings: validation.warnings };
}

/**
 * Update a hat's definition — appends an immutable revision; never rewrites
 * history. Template provenance is preserved but the hat becomes org-authored.
 */
export function updateHatDefinition({ orgId, userId, hatId, definition, name = undefined, changeReason = null, ipAddress = null, userAgent = null }) {
    const row = prepare('SELECT * FROM quoxhat_hats WHERE org_id = ? AND id = ?').get(orgId, hatId);
    if (!row) return { ok: false, errors: ['hat not found'], status: 404 };
    if (row.visibility === 'private' && row.owner_user_id !== userId) {
        return { ok: false, errors: ['hat not found'], status: 404 };
    }
    // CUSTOM-HATS: an optional rename rides the same audited, revisioned write. A built-in's
    // name tracks its template (ensureBuiltinHats/reset rewrite it), so only a custom hat renames.
    let nextName = row.name;
    if (name !== undefined && name !== null) {
        if (typeof name !== 'string' || !name.trim()) return { ok: false, errors: ['name must be a non-empty string'], status: 400 };
        if (name.trim().length > 80) return { ok: false, errors: ['name must be at most 80 characters'], status: 400 };
        if (name.trim() !== row.name && row.template_key) {
            return { ok: false, errors: ['a built-in hat cannot be renamed (its name follows the template); create a custom hat with --from instead'], status: 400 };
        }
        nextName = name.trim();
    }
    const validation = validateHatDefinition(definition);
    if (!validation.valid) return { ok: false, errors: validation.errors, status: 400 };

    const nextRev = row.current_revision + 1;
    const now = nowIso();
    const digest = digestDefinition(definition);
    try {
        transaction(() => {
            prepare(`
                INSERT INTO quoxhat_revisions (hat_id, revision, definition_json, digest, change_reason, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(hatId, nextRev, JSON.stringify(definition), digest, changeReason, userId, now);
            prepare('UPDATE quoxhat_hats SET current_revision = ?, purpose = ?, name = ?, updated_at = ? WHERE id = ?')
                .run(nextRev, definition.purpose, nextName, now, hatId);
        });
    } catch (err) {
        if (isRevisionConflict(err)) return { ok: false, errors: ['revision conflict, retry'], status: 409 };
        throw err;
    }
    const prevDef = safeParse(prepare('SELECT definition_json FROM quoxhat_revisions WHERE hat_id = ? AND revision = ?').get(hatId, row.current_revision)?.definition_json, {});
    const toolsBefore = new Set(hatToolNames(prevDef));
    const toolsAfter = new Set(hatToolNames(definition));
    const agentsOf = (d) => new Set(Array.isArray(d?.agents?.specialists) ? d.agents.specialists : []);
    const agentsBefore = agentsOf(prevDef);
    const agentsAfter = agentsOf(definition);
    createAuditEvent({
        orgId, actorType: 'user', actorId: userId,
        action: 'quoxhat.hat.updated', targetType: 'quoxhat_hat', targetId: hatId,
        ipAddress, userAgent,
        metadata: {
            revision: nextRev, digest, change_reason: changeReason,
            ...(nextName !== row.name ? { name_from: row.name, name_to: nextName } : {}),
            tools_added: [...toolsAfter].filter(t => !toolsBefore.has(t)).sort(),
            tools_removed: [...toolsBefore].filter(t => !toolsAfter.has(t)).sort(),
            agents_added: [...agentsAfter].filter(a => !agentsBefore.has(a)).sort(),
            agents_removed: [...agentsBefore].filter(a => !agentsAfter.has(a)).sort(),
        },
    });
    return { ok: true, hat: getHat(orgId, hatId, userId), warnings: validation.warnings };
}

/**
 * CUSTOM-HATS (owner 2026-10-17) — delete a CUSTOM hat. Built-ins are never
 * deleted (they can be reset to their template instead). The org default
 * cannot be deleted while it is the default (409): move the default first.
 * Conversation bindings and user preferences that named the hat are cleared
 * in the same transaction, so a deleted hat can never resolve again; those
 * conversations fall back through the normal precedence. The audit event
 * keeps the final revision + digest (the hat's last witnessed state).
 */
export function deleteHat({ orgId, userId, hatId, ipAddress = null, userAgent = null }) {
    const row = prepare('SELECT * FROM quoxhat_hats WHERE org_id = ? AND id = ?').get(orgId, hatId);
    if (!row) return { ok: false, error: 'hat_not_found', status: 404 };
    if (row.visibility === 'private' && row.owner_user_id !== userId) return { ok: false, error: 'hat_not_found', status: 404 };
    if (row.template_key) return { ok: false, error: 'builtin_hat_cannot_be_deleted', status: 400 };
    const settings = getOrgSettings(orgId);
    if (settings.default_hat_id === hatId) return { ok: false, error: 'hat_is_org_default', status: 409 };
    const last = prepare('SELECT digest FROM quoxhat_revisions WHERE hat_id = ? AND revision = ?').get(hatId, row.current_revision);
    let bindingsCleared = 0;
    let prefsCleared = 0;
    transaction(() => {
        bindingsCleared = prepare('DELETE FROM quoxhat_bindings WHERE org_id = ? AND hat_id = ?').run(orgId, hatId).changes;
        prefsCleared = prepare('UPDATE quoxhat_user_prefs SET default_hat_id = NULL, updated_at = ? WHERE org_id = ? AND default_hat_id = ?').run(nowIso(), orgId, hatId).changes;
        prepare('DELETE FROM quoxhat_revisions WHERE hat_id = ?').run(hatId);
        prepare('DELETE FROM quoxhat_hats WHERE org_id = ? AND id = ?').run(orgId, hatId);
    });
    const deleted = {
        id: hatId, key: row.key, name: row.name, visibility: row.visibility,
        revision: row.current_revision, digest: last?.digest || null,
        bindings_cleared: bindingsCleared, user_prefs_cleared: prefsCleared,
    };
    createAuditEvent({
        orgId, actorType: 'user', actorId: userId,
        action: 'quoxhat.hat.deleted', targetType: 'quoxhat_hat', targetId: hatId,
        ipAddress, userAgent,
        metadata: { key: deleted.key, name: deleted.name, visibility: deleted.visibility, revision: deleted.revision, digest: deleted.digest, bindings_cleared: bindingsCleared, user_prefs_cleared: prefsCleared },
    });
    return { ok: true, deleted };
}

/**
 * M5 — reset an edited built-in hat back to its template, re-establishing
 * template authorship on the latest revision so the hat REJOINS automatic
 * ensureBuiltinHats() upgrades (study §3's freeze guard checks the LATEST
 * revision's created_by, not history — a template-authored reset revision
 * un-freezes it). Only valid for hats with a template_key naming a current
 * built-in; an org-created custom hat has nothing to reset to.
 */
export function resetHatToTemplate({ orgId, userId, hatId, ipAddress = null, userAgent = null }) {
    const row = prepare('SELECT * FROM quoxhat_hats WHERE org_id = ? AND id = ?').get(orgId, hatId);
    if (!row) return { ok: false, errors: ['hat not found'], status: 404 };
    if (row.visibility === 'private' && row.owner_user_id !== userId) {
        return { ok: false, errors: ['hat not found'], status: 404 };
    }
    const key = row.template_key;
    const tpl = key ? HAT_TEMPLATES[key] : null;
    if (!tpl) {
        return { ok: false, errors: ['hat has no built-in template to reset to'], status: 400 };
    }

    const nextRev = row.current_revision + 1;
    const now = nowIso();
    const digest = digestDefinition(tpl.definition);
    const templateAuthor = `template:${key}@${tpl.template_version}`;
    try {
        transaction(() => {
            prepare(`
                INSERT INTO quoxhat_revisions (hat_id, revision, definition_json, digest, change_reason, created_by, created_at)
                VALUES (?, ?, ?, ?, 'reset to template', ?, ?)
            `).run(hatId, nextRev, JSON.stringify(tpl.definition), digest, templateAuthor, now);
            prepare(`
                UPDATE quoxhat_hats SET current_revision = ?, template_version = ?, name = ?, purpose = ?, updated_at = ?
                WHERE id = ?
            `).run(nextRev, tpl.template_version, tpl.name, tpl.definition.purpose, now, hatId);
        });
    } catch (err) {
        if (isRevisionConflict(err)) return { ok: false, errors: ['revision conflict, retry'], status: 409 };
        throw err;
    }
    createAuditEvent({
        orgId, actorType: 'user', actorId: userId,
        action: 'quoxhat.hat.reset_to_template', targetType: 'quoxhat_hat', targetId: hatId,
        ipAddress, userAgent,
        metadata: { key, revision: nextRev, digest, template_version: tpl.template_version },
    });
    return { ok: true, hat: getHat(orgId, hatId, userId) };
}

export function getOrgSettings(orgId) {
    const row = prepare('SELECT * FROM quoxhat_org_settings WHERE org_id = ?').get(orgId);
    return {
        org_id: orgId,
        default_hat_id: row?.default_hat_id || null,
        selection_mode: row?.selection_mode || 'manual',
        enforcement: row?.enforcement || 'preview',
        updated_by: row?.updated_by || null,
        updated_at: row?.updated_at || null,
    };
}

/**
 * QUOXHAT FND-3 (RPP brutaloop 2026-10-02): the set of orgs CONFIGURED to
 * enforce, independent of whether the collector has ever observed a successful
 * resolve for them. The collector pre-warms its durable enforcement store from
 * this list so a freshly-created or just-toggled enforce org fails CLOSED on its
 * first tool call, closing the cold-cache fail-open window.
 */
export function listEnforceOrgs() {
    return prepare("SELECT org_id FROM quoxhat_org_settings WHERE enforcement = 'enforce'")
        .all()
        .map(r => r.org_id);
}

export function setOrgSettings({ orgId, userId, defaultHatId = undefined, selectionMode = undefined, enforcement = undefined, ipAddress = null, userAgent = null }) {
    if (defaultHatId) {
        const hat = prepare("SELECT id FROM quoxhat_hats WHERE org_id = ? AND id = ? AND visibility = 'org'").get(orgId, defaultHatId);
        if (!hat) return { ok: false, errors: ['default_hat_id must name an org-visible hat in this org'] };
    }
    if (selectionMode !== undefined && !['manual', 'automatic', 'hybrid'].includes(selectionMode)) {
        return { ok: false, errors: ['selection_mode must be manual, automatic or hybrid'] };
    }
    if (enforcement !== undefined && !['preview', 'enforce'].includes(enforcement)) {
        return { ok: false, errors: ['enforcement must be preview or enforce'] };
    }
    const current = getOrgSettings(orgId);
    const next = {
        default_hat_id: defaultHatId === undefined ? current.default_hat_id : defaultHatId,
        selection_mode: selectionMode === undefined ? current.selection_mode : selectionMode,
        // P6 rollout control (owner-approved order, 2026-10-01): enforcement
        // changes ONLY via an explicit, validated, distinctly-audited value —
        // never as a side effect of other settings writes.
        enforcement: enforcement === undefined ? current.enforcement : enforcement,
    };
    const now = nowIso();
    prepare(`
        INSERT INTO quoxhat_org_settings (org_id, default_hat_id, selection_mode, enforcement, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(org_id) DO UPDATE SET
            default_hat_id = excluded.default_hat_id,
            selection_mode = excluded.selection_mode,
            enforcement = excluded.enforcement,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
    `).run(orgId, next.default_hat_id, next.selection_mode, next.enforcement, userId, now);
    createAuditEvent({
        orgId, actorType: 'user', actorId: userId,
        action: 'quoxhat.org_settings.updated', targetType: 'quoxhat_org_settings', targetId: orgId,
        ipAddress, userAgent,
        metadata: { default_hat_id: next.default_hat_id, selection_mode: next.selection_mode, enforcement: next.enforcement },
    });
    if (enforcement !== undefined && enforcement !== current.enforcement) {
        createAuditEvent({
            orgId, actorType: 'user', actorId: userId,
            action: 'quoxhat.enforcement.changed', targetType: 'quoxhat_org_settings', targetId: orgId,
            ipAddress, userAgent,
            metadata: { from: current.enforcement, to: enforcement },
        });
    }
    return { ok: true, settings: getOrgSettings(orgId) };
}

export function setUserPref({ orgId, userId, defaultHatId, ipAddress = null, userAgent = null }) {
    if (defaultHatId) {
        const hat = prepare('SELECT id, visibility, owner_user_id FROM quoxhat_hats WHERE org_id = ? AND id = ?').get(orgId, defaultHatId);
        if (!hat || (hat.visibility === 'private' && hat.owner_user_id !== userId)) {
            return { ok: false, errors: ['default_hat_id must name a hat you can see in this org'] };
        }
    }
    const now = nowIso();
    prepare(`
        INSERT INTO quoxhat_user_prefs (org_id, user_id, default_hat_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(org_id, user_id) DO UPDATE SET
            default_hat_id = excluded.default_hat_id,
            updated_at = excluded.updated_at
    `).run(orgId, userId, defaultHatId || null, now);
    createAuditEvent({
        orgId, actorType: 'user', actorId: userId,
        action: 'quoxhat.user_pref.updated', targetType: 'quoxhat_user_pref', targetId: `${orgId}:${userId}`,
        ipAddress, userAgent,
        metadata: { default_hat_id: defaultHatId || null },
    });
    return { ok: true };
}

/**
 * Resolve the effective hat for (org, user, conversation) by the study's
 * precedence: conversation binding > user default > org default > built-in
 * DEFAULT. Returns the hat WITH definition + digest, plus the source, so
 * the collector (P2) and the UI can display identical provenance.
 */
/**
 * QUOXHAT P5 — deterministic agent-match for automatic/hybrid selection.
 * Picks the most SPECIFIC non-archived, org-visible hat whose
 * definition.agents.specialists names the turn's agent (fewest specialists
 * wins = most focused profile; key ASC tie-break so the pick is stable).
 * Orchestrator matches are deliberately ignored: every builtin names 'quox'
 * as orchestrator, so matching it would make auto-selection a no-op constant.
 *
 * LOAD-BEARING GUARD: a privileged hat (transitions.privileged) is NEVER
 * auto-matched. Privilege is a human boundary — it is reached only by a
 * person wearing it (Mirror/Settings) or an approved hat_propose_switch.
 * Automation that could escalate privilege by routing a turn at the right
 * agent would bypass the HITL gate the privilege flag exists to create.
 */
function autoMatchHatForAgent(orgId, agent, userId = null) {
    if (!agent || typeof agent !== 'string') return null;
    const needle = agent.toLowerCase();
    const rows = prepare(
        "SELECT * FROM quoxhat_hats WHERE org_id = ? AND status != 'archived' ORDER BY key ASC"
    ).all(orgId);
    let best = null;
    for (const row of rows) {
        if (row.visibility === 'private' && row.owner_user_id !== userId) continue;
        const hat = rowToHat(row, { withDefinition: true });
        const def = hat?.definition;
        if (!def) continue;
        if (def.transitions?.privileged === true) continue;
        const specialists = Array.isArray(def.agents?.specialists)
            ? def.agents.specialists.map((s) => String(s).toLowerCase())
            : [];
        if (!specialists.includes(needle)) continue;
        if (!best || specialists.length < best.count) best = { hat, count: specialists.length };
    }
    return best?.hat || null;
}

export function resolveEffectiveHat({ orgId, userId = null, conversationId = null, agent = null }) {
    ensureBuiltinHats(orgId);
    // QUOXHAT P5 — selection_mode (org setting, audited on change):
    //   manual (default): binding → user default → org default → builtin.
    //   automatic: binding → AGENT-MATCH → user default → org default → builtin.
    //   hybrid: binding → user default → AGENT-MATCH → org default → builtin.
    // A conversation binding (a human or HITL-approved decision) wins in EVERY
    // mode — automation never overrides a person. Privileged hats are never
    // auto-matched (see autoMatchHatForAgent).
    const selectionMode = getOrgSettings(orgId).selection_mode || 'manual';

    if (conversationId) {
        const binding = prepare('SELECT * FROM quoxhat_bindings WHERE org_id = ? AND conversation_id = ?').get(orgId, conversationId);
        if (binding) {
            const hat = getHat(orgId, binding.hat_id, userId);
            if (hat) {
                return {
                    source: 'conversation',
                    hat,
                    binding: {
                        revision: binding.revision,
                        seq: binding.seq,
                        loaded_bundles: safeParse(binding.loaded_bundles, []) || [],
                    },
                };
            }
        }
    }
    if (selectionMode === 'automatic') {
        const match = autoMatchHatForAgent(orgId, agent, userId);
        if (match) return { source: 'auto_agent_match', hat: match };
    }
    if (userId) {
        const pref = prepare('SELECT default_hat_id FROM quoxhat_user_prefs WHERE org_id = ? AND user_id = ?').get(orgId, userId);
        if (pref?.default_hat_id) {
            const hat = getHat(orgId, pref.default_hat_id, userId);
            if (hat) return { source: 'user_default', hat };
        }
    }
    if (selectionMode === 'hybrid') {
        const match = autoMatchHatForAgent(orgId, agent, userId);
        if (match) return { source: 'auto_agent_match', hat: match };
    }
    const settings = getOrgSettings(orgId);
    if (settings.default_hat_id) {
        const hat = getHat(orgId, settings.default_hat_id, userId);
        if (hat) return { source: 'org_default', hat };
    }
    const builtin = prepare("SELECT * FROM quoxhat_hats WHERE org_id = ? AND key = 'default'").get(orgId);
    return { source: 'builtin_default', hat: rowToHat(builtin, { withDefinition: true }) };
}

/**
 * QUOXHAT P4 — load one of the bound hat's bundles into a conversation
 * (progressive disclosure). Validates the bundle exists on the EFFECTIVE
 * hat for the conversation, appends it to loaded_bundles (idempotent), and
 * bumps seq (a bundle load is a manifest transition). Creates the binding
 * row if the conversation was riding a default.
 */
export function loadBundleForConversation({ orgId, userId, conversationId, bundleKey, ipAddress = null, userAgent = null }) {
    if (!conversationId) return { ok: false, errors: ['conversation_id required'], status: 400 };
    if (!bundleKey || typeof bundleKey !== 'string') return { ok: false, errors: ['bundle_key required'], status: 400 };

    const effective = resolveEffectiveHat({ orgId, userId, conversationId });
    const hat = effective.hat;
    if (!hat?.definition) return { ok: false, errors: ['no effective hat for this conversation'], status: 404 };
    const bundles = Array.isArray(hat.definition.tools?.bundles) ? hat.definition.tools.bundles : [];
    const bundle = bundles.find(b => b?.key === bundleKey);
    if (!bundle) {
        return { ok: false, errors: [`hat '${hat.key}' has no bundle '${bundleKey}'`], status: 404, available: bundles.map(b => b.key) };
    }

    const existing = prepare('SELECT * FROM quoxhat_bindings WHERE org_id = ? AND conversation_id = ?').get(orgId, conversationId);
    const loaded = new Set(safeParse(existing?.loaded_bundles, []) || []);
    const already = loaded.has(bundleKey);
    loaded.add(bundleKey);
    const nextSeq = (existing?.seq ?? -1) + 1;
    const now = nowIso();
    prepare(`
        INSERT INTO quoxhat_bindings (org_id, conversation_id, hat_id, revision, seq, selected_by, updated_at, loaded_bundles)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(org_id, conversation_id) DO UPDATE SET
            seq = excluded.seq,
            selected_by = excluded.selected_by,
            updated_at = excluded.updated_at,
            loaded_bundles = excluded.loaded_bundles
    `).run(orgId, conversationId, hat.id, hat.current_revision, nextSeq, userId || null, now, JSON.stringify([...loaded]));
    if (!already) {
        createAuditEvent({
            orgId, actorType: userId ? 'user' : 'agent', actorId: userId || hat.definition.agents?.orchestrator || 'agent',
            action: 'quoxhat.bundle.loaded', targetType: 'quoxhat_binding', targetId: `${orgId}:${conversationId}`,
            ipAddress, userAgent,
            metadata: { hat_id: hat.id, hat_key: hat.key, bundle_key: bundleKey, seq: nextSeq },
        });
    }
    return { ok: true, hat_key: hat.key, bundle: { key: bundle.key, name: bundle.name || bundle.key }, loaded_bundles: [...loaded], already_loaded: already, seq: nextSeq };
}

/**
 * QUOXHAT P4/P5 — the catalogue an agent may see in-context: the active
 * hat with its bundles (+ loaded state) and a one-line index of the OTHER
 * hats this caller could switch to (name + purpose + transition
 * requirement; never another hat's tool schemas — study §6).
 */
/**
 * QUOXHAT #725 slice 1 (read-only catalogue): tool NAMES a hat definition
 * names, explicit first then bundles, deduped. Names only, never schemas
 * (study §6). This is hat MEMBERSHIP, not authority: a turn only ever sees
 * membership intersected with the agent's own grant, so listing a name here
 * grants nothing.
 */
function hatMembershipNames(def) {
    return [...new Set(hatToolNames(def))];
}

export function getCatalogueForConversation({ orgId, userId = null, conversationId = null, tool = null }) {
    const effective = resolveEffectiveHat({ orgId, userId, conversationId });
    const binding = conversationId
        ? prepare('SELECT loaded_bundles FROM quoxhat_bindings WHERE org_id = ? AND conversation_id = ?').get(orgId, conversationId)
        : null;
    const loaded = new Set(safeParse(binding?.loaded_bundles, []) || []);
    const active = effective.hat;
    const otherRows = prepare(`
        SELECT * FROM quoxhat_hats
        WHERE org_id = ? AND (visibility = 'org' OR owner_user_id = ?) AND status != 'archived' AND id != ?
        ORDER BY key
    `).all(orgId, userId || '', active?.id || '');
    const otherHats = otherRows.map(h => {
        const def = safeParse(prepare('SELECT definition_json FROM quoxhat_revisions WHERE hat_id = ? AND revision = ?').get(h.id, h.current_revision)?.definition_json, {});
        return {
            key: h.key,
            name: h.name,
            purpose: h.purpose,
            privileged: def?.transitions?.privileged === true,
            confirm: def?.transitions?.confirm || 'none',
            tools: hatMembershipNames(def), // #725 slice 1: names only, no schemas
        };
    });
    const result = {
        active: active ? {
            key: active.key,
            name: active.name,
            revision: active.current_revision,
            purpose: active.purpose,
            source: effective.source,
            bundles: (active.definition?.tools?.bundles || []).map(b => ({
                key: b.key,
                name: b.name || b.key,
                tools: Array.isArray(b.tools) ? b.tools.length : 0,
                tool_names: Array.isArray(b.tools) ? [...b.tools] : [], // #725 slice 1
                loaded: loaded.has(b.key),
            })),
            explicit_tools: Array.isArray(active.definition?.tools?.explicit) ? [...active.definition.tools.explicit] : [], // #725 slice 1
        } : null,
        other_hats: otherHats,
        enforcement: getOrgSettings(orgId).enforcement,
        // #725 slice 1: say plainly what the lists mean so a model does not read
        // a hat's membership as permission it already has.
        note: 'Tool names are hat membership, not permissions: on any hat you only get the tools your own grant holds. To get a tool on another hat, propose a switch (hat_propose_switch); you never switch yourself.',
    };
    if (tool) result.tool_lookup = lookupTool(String(tool).trim(), active, otherHats);
    return result;
}

/** #725 slice 1: where does a named tool live (active explicit, active bundle, other hats)? */
function lookupTool(tool, active, otherHats) {
    const def = active?.definition || {};
    const inActiveExplicit = Array.isArray(def.tools?.explicit) && def.tools.explicit.includes(tool);
    const activeBundle = (def.tools?.bundles || []).find(b => Array.isArray(b?.tools) && b.tools.includes(tool));
    return {
        tool,
        on_active_hat: inActiveExplicit ? 'explicit' : activeBundle ? `bundle:${activeBundle.key}` : null,
        other_hats: otherHats.filter(h => h.tools.includes(tool)).map(h => ({ key: h.key, privileged: h.privileged, confirm: h.confirm })),
    };
}

/**
 * Bind a hat to a conversation (manual selection). Compare-and-swap on seq
 * so two tabs cannot silently clobber each other's switch (study §6).
 */
export function bindConversationHat({ orgId, userId, conversationId, hatId, expectedSeq = null, ipAddress = null, userAgent = null }) {
    const hat = getHat(orgId, hatId, userId);
    if (!hat) return { ok: false, errors: ['hat not found'], status: 404 };
    const existing = prepare('SELECT seq FROM quoxhat_bindings WHERE org_id = ? AND conversation_id = ?').get(orgId, conversationId);
    if (existing && expectedSeq !== null && existing.seq !== expectedSeq) {
        return { ok: false, errors: [`binding moved (seq ${existing.seq}, expected ${expectedSeq})`], status: 409 };
    }
    const nextSeq = (existing?.seq ?? -1) + 1;
    const now = nowIso();
    // P4: a hat SWITCH resets progressive-disclosure state — the new hat
    // starts from its own initial manifest, never inherits loaded bundles.
    prepare(`
        INSERT INTO quoxhat_bindings (org_id, conversation_id, hat_id, revision, seq, selected_by, updated_at, loaded_bundles)
        VALUES (?, ?, ?, ?, ?, ?, ?, '[]')
        ON CONFLICT(org_id, conversation_id) DO UPDATE SET
            hat_id = excluded.hat_id,
            revision = excluded.revision,
            seq = excluded.seq,
            selected_by = excluded.selected_by,
            updated_at = excluded.updated_at,
            loaded_bundles = '[]'
    `).run(orgId, conversationId, hatId, hat.current_revision, nextSeq, userId, now);
    createAuditEvent({
        orgId, actorType: 'user', actorId: userId,
        action: 'quoxhat.binding.selected', targetType: 'quoxhat_binding', targetId: `${orgId}:${conversationId}`,
        ipAddress, userAgent,
        metadata: { hat_id: hatId, hat_key: hat.key, revision: hat.current_revision, seq: nextSeq },
    });
    return { ok: true, binding: { conversation_id: conversationId, hat_id: hatId, revision: hat.current_revision, seq: nextSeq } };
}
