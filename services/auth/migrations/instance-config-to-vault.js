/**
 * Instance Config → Vault Migration
 *
 * Migrates AI service keys stored in the instance_config table
 * into the vault (integration_credentials table) as proper encrypted credentials.
 *
 * This runs at auth service boot, after schema migrations.
 *
 * Behavior:
 *   - For each AI key in instance_config, checks if vault already has
 *     a default credential of that type for the org
 *   - If not, creates a vault credential and sets it as default
 *   - Idempotent: safe to run multiple times
 *   - Does NOT delete instance_config entries (they remain as fallback)
 *   - Does NOT touch claude_oauth_token (session token, not a credential)
 *   - Does NOT touch webhook secrets or non-credential config
 */

import { getDb } from '../db/index.js';
import { decrypt } from '../utils/encryption.js';
import { createCredential, getDefaultCredential } from '../db/integrations.js';
import { readInstanceSmtp, writeInstanceSmtp, getInstanceSmtpCredential } from '../services/instanceEmailCredential.js';
import { resolveInstanceOrgOwner } from '../lib/instanceScope.js';

// Map: instance_config key → { integration_type, credential_field }
const MIGRATABLE_KEYS = {
    anthropic_api_key:  { type: 'anthropic',  field: 'api_key' },
    openai_api_key:     { type: 'openai',     field: 'api_key' },
    elevenlabs_api_key: { type: 'elevenlabs', field: 'api_key' },
    perplexity_api_key: { type: 'perplexity', field: 'api_key' },
    gemini_api_key:     { type: 'gemini',     field: 'api_key' },
    codex_api_key:      { type: 'codex',      field: 'api_key' }
};

// VAULT-INTEG P9: the deliberate one-shot ops flag that gates the write loop
// below. Registered in services/shared/envRegistry.cjs as classification
// 'instance'. Default OFF: boot behaviour without the flag is a read-only
// dry-run report, never a write.
const WRITE_FLAG_ENV = 'QUOX_VAULT_MIGRATE_PROVIDER_KEYS';

// instance_config keys this migration owns for its own bookkeeping. Neither
// ever holds a secret value — the plan is counts/booleans only, and the
// stamp is just a completion timestamp.
const PLAN_CONFIG_KEY = 'vault_migration_provider_keys_plan';
const STAMP_CONFIG_KEY = 'vault_migration_provider_keys_completed_at';

function isWritesEnabled(deps) {
    if (deps.writesEnabled !== undefined) return !!deps.writesEnabled;
    return process.env[WRITE_FLAG_ENV] === '1';
}

/**
 * Build the dry-run plan: for each migratable provider key, whether
 * instance_config has a value set, and — without decrypting or logging that
 * value — how many orgs already have a vault credential of that type
 * (would be skipped, vault takes precedence) vs. how many would get one
 * newly created if the write flag were turned on. Counts only, no secret
 * values, ever.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{id: string}>} orgs
 */
function buildProviderKeyPlan(db, orgs) {
    const providers = {};
    let wouldCreateTotal = 0;
    let wouldSkipTotal = 0;

    for (const [configKey, { type: integrationType }] of Object.entries(MIGRATABLE_KEYS)) {
        const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(configKey);
        const present = !!row?.value;

        let wouldCreate = 0;
        let alreadyHasCredential = 0;

        if (present) {
            for (const org of orgs) {
                if (getDefaultCredential(org.id, integrationType)) {
                    alreadyHasCredential++;
                } else {
                    wouldCreate++;
                }
            }
        }

        providers[integrationType] = {
            source_key: configKey,
            present_in_instance_config: present,
            orgs_with_existing_credential: alreadyHasCredential,
            orgs_would_create: wouldCreate
        };
        wouldCreateTotal += wouldCreate;
        wouldSkipTotal += alreadyHasCredential;
    }

    return {
        generated_at: new Date().toISOString(),
        org_count: orgs.length,
        providers,
        would_create_total: wouldCreateTotal,
        would_skip_total: wouldSkipTotal
    };
}

/** Persist the dry-run plan as JSON in instance_config — no secret values. */
function writeProviderKeyPlan(db, plan) {
    db.prepare(`
        INSERT INTO instance_config (key, value, value_type, description, updated_at)
        VALUES (?, ?, 'json', 'VAULT-INTEG P9: dry-run plan for the instance_config -> vault provider-key migration (counts/booleans only, no secret values)', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value, value_type = 'json', updated_at = datetime('now')
    `).run(PLAN_CONFIG_KEY, JSON.stringify(plan));
}

function readCompletionStamp(db) {
    return db.prepare('SELECT value FROM instance_config WHERE key = ?').get(STAMP_CONFIG_KEY)?.value || null;
}

/** Stamp completion so a later boot with the flag still set to 1 no-ops. */
function writeCompletionStamp(db) {
    const stampedAt = new Date().toISOString();
    db.prepare(`
        INSERT INTO instance_config (key, value, value_type, description, updated_at)
        VALUES (?, ?, 'string', 'VAULT-INTEG P9: stamps completion of the instance_config -> vault provider-key migration (a deliberate one-shot). Delete this row to re-arm.', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(STAMP_CONFIG_KEY, stampedAt);
    return stampedAt;
}

/**
 * Migrate instance_config AI keys to vault for all orgs.
 *
 * Default behaviour (QUOX_VAULT_MIGRATE_PROVIDER_KEYS unset or not '1') is a
 * READ-ONLY dry run: no vault credential is created, no instance_config row
 * used by anything else is touched. It only computes and persists a plan
 * (see buildProviderKeyPlan) so an operator can see what a real run would do
 * before opting in.
 *
 * With the flag set to '1', the migration performs the actual write loop
 * once — idempotently (an org that already has a default credential of a
 * given type is skipped, vault precedence is never disturbed) — and then
 * stamps completion so every later boot, even with the flag still set, is a
 * no-op. That stamp is deliberate: this is a one-shot ops flag, not a
 * standing setting the owner leaves on.
 *
 * @param {object} [deps]
 * @param {import('better-sqlite3').Database} [deps.db] - DB handle (defaults to getDb()),
 *   injectable for tests so a source-query failure can be exercised without a
 *   real DB fault.
 * @param {boolean} [deps.writesEnabled] - override for the env flag, for tests.
 */
export function migrateInstanceConfigToVault(deps = {}) {
    const db = deps.db || getDb();
    const writesEnabled = isWritesEnabled(deps);
    const mode = writesEnabled ? 'write' : 'dry-run';

    // Get all orgs. VAULT-ADVERSARIAL-VERIFICATION: this previously queried a
    // table named `organizations`, which does not exist (the real table is
    // `orgs` — see migrations/000-baseline.sql). The query always threw, was
    // swallowed by the catch below, and the function returned a SUCCESSFUL
    // {migrated: 0} — logged as "No organizations table — skipping" as though
    // the migration ran and found nothing, when it had in fact never run at
    // all. Fixed table name below; the catch now reports a real failure
    // honestly (ok: false, a populated errors[]) instead of masking it as a
    // clean no-op, so a genuinely broken source table can't hide as "nothing
    // to migrate" ever again.
    let orgs;
    try {
        orgs = db.prepare('SELECT id, name, owner_user_id FROM orgs').all();
    } catch (err) {
        console.error('[VaultMigration] Failed to query orgs table — migration did NOT run:', err.message);
        return { migrated: 0, skipped: 0, errors: [{ org: null, key: null, error: err.message }], ok: false, mode };
    }

    if (!orgs || orgs.length === 0) {
        console.log('[VaultMigration] No organizations found — skipping');
        return { migrated: 0, skipped: 0, errors: [], ok: true, mode };
    }

    if (!writesEnabled) {
        const plan = buildProviderKeyPlan(db, orgs);
        writeProviderKeyPlan(db, plan);
        console.log(
            `[VaultMigration] DRY RUN (set ${WRITE_FLAG_ENV}=1 to write) — ` +
            `${plan.org_count} orgs, would create ${plan.would_create_total}, ` +
            `would skip ${plan.would_skip_total} (already in vault). ` +
            `Full plan (counts only) written to instance_config['${PLAN_CONFIG_KEY}'].`
        );
        return { migrated: 0, skipped: 0, errors: [], ok: true, mode, plan };
    }

    const completedAt = readCompletionStamp(db);
    if (completedAt) {
        console.log(`[VaultMigration] Provider-key migration already completed at ${completedAt} — no-op (delete instance_config['${STAMP_CONFIG_KEY}'] to re-arm)`);
        return { migrated: 0, skipped: 0, errors: [], ok: true, mode, alreadyCompleted: true, completedAt };
    }

    let migrated = 0;
    let skipped = 0;
    const errors = [];

    for (const org of orgs) {
        for (const [configKey, { type: integrationType, field }] of Object.entries(MIGRATABLE_KEYS)) {
            try {
                // Check if instance_config has this key
                const row = db.prepare(
                    'SELECT value, encrypted FROM instance_config WHERE key = ?'
                ).get(configKey);

                if (!row?.value) continue;

                // Decrypt the value
                const apiKey = row.encrypted ? decrypt(row.value) : row.value;
                if (!apiKey || !apiKey.trim()) continue;

                // Check if vault already has a default credential for this type/org
                const existing = getDefaultCredential(org.id, integrationType);
                if (existing) {
                    skipped++;
                    continue;
                }

                // Create vault credential. created_by is NOT NULL REFERENCES
                // users(id) — the literal string 'system:migration' is not a
                // real user id and would fail this insert with a FOREIGN KEY
                // constraint error on every org (a second, previously-dormant
                // bug this migration never reached while the orgs query above
                // was broken). The org's own owner_user_id is always a valid
                // FK target, so attribute the migrated credential to the org
                // owner.
                createCredential({
                    org_id: org.id,
                    integration_type: integrationType,
                    label: `${integrationType} (migrated from config)`,
                    credentials: { [field]: apiKey },
                    auth_type: 'api_key',
                    is_default: true,
                    created_by: org.owner_user_id,
                    visibility: 'org',
                    description: 'Auto-migrated from instance_config'
                });

                migrated++;
                console.log(`[VaultMigration] Migrated ${configKey} → vault for org ${org.name}`);
            } catch (err) {
                errors.push({ org: org.id, key: configKey, error: err.message });
                console.error(`[VaultMigration] Failed to migrate ${configKey} for org ${org.name}:`, err.message);
            }
        }
    }

    // Stamp completion regardless of whether anything was actually migrated
    // this run (0 migrated + 0 errors is still a completed run — e.g. no
    // provider keys were ever set in instance_config). This is what makes
    // the flag a true one-shot: a later boot with QUOX_VAULT_MIGRATE_PROVIDER_KEYS
    // still set to 1 does not re-walk every org on every restart.
    const stampedAt = writeCompletionStamp(db);

    console.log(`[VaultMigration] Complete: ${migrated} migrated, ${skipped} already in vault, ${errors.length} errors. Stamped ${stampedAt}.`);

    return { migrated, skipped, errors, ok: true, mode, completedAt: stampedAt };
}

// ── EMAIL-UNIFY P2: instance SMTP -> vault ──────────────────────────────────
//
// Instance SMTP is not an org credential, so it does not go through the loop
// above at all: it moves to the INSTANCE scope (lib/instanceScope.js) as a
// single `email_account` credential — the same row the Settings email panel
// now writes. Once it lands in the vault, the instance_config source rows are
// deleted, because two stores holding the same secret is precisely the drift
// P2 exists to remove.
//
// Unlike the AI-key migration above, this one deletes its source. That is safe
// because the copy is verified by reading it back out of the vault before the
// delete, inside one transaction.

/** instance_config rows that hold the SMTP credential (not the smtp_last_test_* status rows). */
const SMTP_CONFIG_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure'];

/**
 * Migrate the instance SMTP config from instance_config into QuoxVault.
 * Idempotent, and safe to call on every boot.
 *
 * @returns {{ migrated: boolean, reason: string|null }}
 */
export function migrateInstanceSmtpToVault() {
    const db = getDb();

    // Already in the vault — nothing to do.
    try {
        if (getInstanceSmtpCredential({ db })) {
            return { migrated: false, reason: 'already_in_vault' };
        }
    } catch (err) {
        console.error('[VaultMigration] instance SMTP lookup failed:', err.message);
        return { migrated: false, reason: `lookup_failed: ${err.message}` };
    }

    // Read the legacy rows.
    const raw = {};
    for (const key of SMTP_CONFIG_KEYS) {
        const row = db.prepare('SELECT value, encrypted FROM instance_config WHERE key = ?').get(key);
        if (!row) continue;
        if (row.encrypted && row.value) {
            try { raw[key] = decrypt(row.value); } catch { raw[key] = null; }
        } else {
            raw[key] = row.value;
        }
    }

    // host + from are what the send path actually needs; anything less is not
    // a usable config and is left in place rather than half-migrated.
    if (!raw.smtp_host || !raw.smtp_from) {
        return { migrated: false, reason: 'nothing_to_migrate' };
    }

    // created_by must reference a real user (FKs are ON). Prefer whoever last
    // touched the config, then any instance admin.
    const updatedBy = db.prepare("SELECT updated_by FROM instance_config WHERE key = 'smtp_host'").get()?.updated_by;
    const actor = resolveInstanceOrgOwner({ db, userId: updatedBy || null });
    if (!actor) {
        console.warn('[VaultMigration] instance SMTP: no user to own the credential yet — deferring to next boot');
        return { migrated: false, reason: 'no_owner_yet' };
    }

    try {
        const tx = db.transaction(() => {
            writeInstanceSmtp({
                host: raw.smtp_host,
                port: raw.smtp_port ? Number(raw.smtp_port) : 587,
                user: raw.smtp_user || '',
                pass: raw.smtp_pass || '',
                from: raw.smtp_from,
                secure: raw.smtp_secure === 'true',
            }, { db, userId: actor });

            // Verify the copy round-trips before dropping the source.
            const readBack = readInstanceSmtp({ db });
            if (!readBack || readBack.host !== raw.smtp_host || readBack.from !== raw.smtp_from) {
                throw new Error('vault read-back did not match the source config');
            }

            const placeholders = SMTP_CONFIG_KEYS.map(() => '?').join(', ');
            db.prepare(`DELETE FROM instance_config WHERE key IN (${placeholders})`).run(...SMTP_CONFIG_KEYS);
        });
        tx();
    } catch (err) {
        console.error('[VaultMigration] instance SMTP migration failed (config left untouched):', err.message);
        return { migrated: false, reason: `failed: ${err.message}` };
    }

    console.log('[VaultMigration] Instance SMTP moved from instance_config into QuoxVault');
    return { migrated: true, reason: null };
}
