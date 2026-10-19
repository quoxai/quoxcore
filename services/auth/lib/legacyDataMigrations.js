/**
 * legacyDataMigrations.js
 *
 * JS-level data migrations that CANNOT be expressed as declarative SQL
 * migration files (runtime introspection / branching / per-row backfill
 * logic that SQLite DDL has no IF/branch construct for). Ported verbatim
 * (logic unchanged) from db/index.js's old applyMigrations() as part of
 * folding that function into the versioned migration runner
 * (lib/runMigrations.js + migrations/*.sql).
 *
 * These run AFTER runMigrations() at boot — mirrors
 * services/tasks/db/index.js's applyLegacyTeamDefinitionsPkFix() pattern
 * (kept outside the declarative migration system for the same reason:
 * conditional on runtime schema/data introspection, not a fixed statement).
 *
 * Each function is independently idempotent and safe to call on every boot.
 */

import crypto from 'crypto';
import { hostPath } from '../utils/hostPaths.js';

import { encryptEnvelope, decrypt as vaultDecrypt, deriveKek } from '../utils/encryption.js';
import { getRotatableStores } from '../config/encryptedStores.js';

// #1021: SQL string literal holding a JSON path list, built at runtime from host
// paths (constants, never user input). Matches the old '["a", "b"]' spacing.
function sqlPathList(...paths) {
    const json = '[' + paths.map((p) => JSON.stringify(p)).join(', ') + ']';
    return "'" + json.replace(/'/g, "''") + "'";
}


/**
 * FALSE-NEGATIVE FIX (2026-07): the original Phase A.5 seed pointed the
 * `services` table's collector/qdrant/dashboard/n8n health_endpoint columns
 * at `http://localhost:<port>` (and, for dashboard, the Vite dev port
 * 5173). Those checks run server-side inside the `auth` container —
 * `localhost` there means the auth container itself, so every one of those
 * probes was guaranteed to fail ("fetch failed") regardless of the actual
 * service's health. Correct any row still holding one of the known-bad
 * legacy values to the real docker-compose service DNS name, and reset its
 * stale "unhealthy" status so the UI stops lying about services that were
 * never actually reachable in the first place. Guarded by exact old-value
 * match so it never clobbers a value an admin has since edited on purpose.
 */
export function fixLegacyHealthEndpoints(database) {
    const hasServicesTable = database.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='services'
    `).get();
    if (!hasServicesTable) return;

    // N8N-ERADICATE: the 'n8n' entry that used to live here is gone on purpose.
    // The n8n container/service no longer exists (docker-compose.yml, schema-a5.sql
    // seed removed), so "fixing" a legacy row to point at http://n8n:5678/healthz
    // would just swap one dead URL for another. This list is additive/tolerant —
    // it only touches rows whose id it names — so dropping the entry is a safe
    // no-op for any install that still has a stale 'n8n' services row; that row is
    // left alone (OPTIONAL_SERVICE_IDS in serviceHealthClassifier.js already keeps
    // it from rendering as a false "OFFLINE" alarm).
    const legacyHealthEndpointFixes = [
        { id: 'collector', oldUrl: 'http://localhost:9848/health', newUrl: 'http://collector:9848/health' },
        { id: 'qdrant', oldUrl: 'http://localhost:6333/healthz', newUrl: 'http://qdrant:6333/healthz' },
        { id: 'dashboard', oldUrl: 'http://localhost:5173', newUrl: 'http://dashboard:80/health' },
    ];
    /* Match BOTH spellings of loopback. This list only ever compared against the
     * "localhost" form, so a row seeded as "http://127.0.0.1:9848/health" was never
     * migrated: it stayed pointing at loopback, the probe runs inside a container where
     * loopback is the container itself, and the shell showed every user a
     * "Platform degraded: core services unreachable" banner naming the Collector while
     * the Collector was healthy. A false alarm on a core service trains people to ignore
     * the banner, which is worse than not having one. */
    const loopbackVariants = (url) => [url, url.replace('//localhost:', '//127.0.0.1:')];
    for (const { id, oldUrl, newUrl } of legacyHealthEndpointFixes) {
        const row = database.prepare('SELECT health_endpoint, expected_port FROM services WHERE id = ?').get(id);
        if (row && loopbackVariants(oldUrl).includes(row.health_endpoint)) {
            const newPort = id === 'dashboard' ? 443 : row.expected_port;
            database.prepare(`
                UPDATE services
                SET health_endpoint = ?, expected_port = ?, status = 'unknown', status_message = NULL
                WHERE id = ?
            `).run(newUrl, newPort, id);
            console.log(`Fixed stale health_endpoint for service '${id}': ${oldUrl} -> ${newUrl}`);
        }
    }
}

/**
 * Phase B.1: default system share_policies for every org that doesn't yet
 * have them. Originally gated by `!hasDivisions` (only fired the very first
 * time schema-b1.sql was applied); that gate is meaningless now that
 * 000-baseline.sql always creates `divisions` up front, so this runs on
 * every boot instead — safe, because the underlying INSERT is
 * `INSERT OR IGNORE` and is itself the true idempotency guarantee (an org
 * that already has its 5 system policies gets zero new rows; a brand new
 * org gets seeded). ULID generation requires crypto.randomBytes, which is
 * why this can't be a plain .sql migration.
 */
export function seedDefaultSharePoliciesForOrgs(database) {
    const hasSharePolicies = database.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='share_policies'
    `).get();
    if (!hasSharePolicies) return;

    const orgs = database.prepare(`SELECT id FROM orgs WHERE deleted_at IS NULL`).all();
    if (orgs.length === 0) return;

    const ulid = () => {
        const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        const time = Date.now().toString(32).toUpperCase().padStart(10, '0');
        const randomBytes = crypto.randomBytes(16);
        let rand = '';
        for (let i = 0; i < 16; i++) {
            rand += chars[randomBytes[i] % 32];
        }
        return time + rand;
    };

    const systemPolicies = [
        { name: 'Private', mode: 'private', description: 'Only visible to creator' },
        { name: 'Team Only', mode: 'team', description: 'Visible to team members' },
        { name: 'Department', mode: 'department', description: 'Visible to department members' },
        { name: 'Division', mode: 'division', description: 'Visible to division members' },
        { name: 'Org-Wide', mode: 'org', description: 'Visible to all org members' }
    ];

    const insertPolicy = database.prepare(`
        INSERT OR IGNORE INTO share_policies (id, org_id, name, description, mode, is_system)
        VALUES (?, ?, ?, ?, ?, 1)
    `);

    for (const org of orgs) {
        for (const policy of systemPolicies) {
            insertPolicy.run(ulid(), org.id, policy.name, policy.description, policy.mode);
        }
    }
}

/**
 * Phase D.1b: backup_components' CHECK constraint originally didn't allow
 * 'pg_dump' as a backup_method. Detecting whether a live table's CHECK
 * constraint text includes 'pg_dump' requires reading sqlite_master.sql at
 * runtime (SQLite DDL has no ALTER ... CHECK support), so this stays JS.
 * On any DB built from the current schema-backups.sql (folded into
 * 000-baseline.sql), the CHECK already includes 'pg_dump' and the seed
 * already has 21+ rows, so `needsD1b` is false and this is a no-op —
 * it only fires against old databases stuck at the pre-D.1b table shape.
 */
export function applyBackupComponentsD1b(database) {
    const backupComponentsExists = database.prepare(`
        SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_components'
    `).get();
    if (!backupComponentsExists) return;

    const componentCount = database.prepare(`SELECT COUNT(*) as c FROM backup_components`).get()?.c || 0;
    const needsD1b = componentCount < 21;

    if (!needsD1b) return;

    console.log(`Applying Phase D.1b migration (${componentCount} → 21 backup components)...`);
    try {
        const tableSql = database.prepare(
            `SELECT sql FROM sqlite_master WHERE type='table' AND name='backup_components'`
        ).get();
        if (tableSql && !tableSql.sql.includes('pg_dump')) {
            database.exec(`DROP TABLE IF EXISTS backup_components_new`);
            database.exec(`
                CREATE TABLE backup_components_new (
                    id TEXT PRIMARY KEY,
                    component_key TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT,
                    source_paths_json TEXT,
                    estimated_size_bytes INTEGER,
                    component_type TEXT NOT NULL DEFAULT 'directory'
                        CHECK (component_type IN ('file', 'directory', 'database', 'docker_volume', 'api')),
                    backup_method TEXT NOT NULL DEFAULT 'rsync'
                        CHECK (backup_method IN ('rsync', 'copy', 'sqlite_backup', 'docker_cp', 'api_export', 'pg_dump', 'qdrant_snapshot')),
                    priority INTEGER DEFAULT 100,
                    default_enabled INTEGER DEFAULT 1,
                    category TEXT DEFAULT 'data'
                        CHECK (category IN ('core', 'data', 'config', 'workflow', 'infrastructure')),
                    icon TEXT DEFAULT 'folder'
                )
            `);
            database.exec(`INSERT OR IGNORE INTO backup_components_new SELECT * FROM backup_components`);
            database.exec(`DROP TABLE backup_components`);
            database.exec(`ALTER TABLE backup_components_new RENAME TO backup_components`);
            console.log('  - Recreated table with pg_dump CHECK constraint');
        }

        database.exec(`
            UPDATE backup_components SET source_paths_json = ${sqlPathList(hostPath('quoxagent', 'playbooks/'))}
            WHERE component_key = 'quoxagent_playbooks'
        `);
        database.exec(`
            UPDATE backup_components SET source_paths_json = ${sqlPathList(hostPath('quoxagent', 'configs/'))}
            WHERE component_key = 'quoxagent_configs'
        `);
        database.exec(`
            UPDATE backup_components SET backup_method = 'pg_dump'
            WHERE component_key = 'postgres_db'
        `);
        database.exec(`
            UPDATE backup_components SET source_paths_json = '["docker://quox-collector:/var/lib/quox/aee.db"]'
            WHERE component_key = 'collector_aee_db'
        `);
        database.exec(`
            UPDATE backup_components SET source_paths_json = '["docker://quox-auth:/var/lib/quox/uploads/"]'
            WHERE component_key = 'org_logos'
        `);
        database.exec(`
            UPDATE backup_components SET source_paths_json = '["/etc/ssl/quox/", "certs/"]'
            WHERE component_key = 'ssl_certs'
        `);
        database.exec(`
            UPDATE backup_components SET source_paths_json = '["docker://quox-qdrant:/qdrant/storage/"]'
            WHERE component_key = 'qdrant_vectors'
        `);

        database.exec(`
            INSERT OR IGNORE INTO backup_components (id, component_key, name, description, source_paths_json, component_type, backup_method, priority, category, icon, estimated_size_bytes) VALUES
            ('comp_collector_aee', 'collector_aee_db', 'Collector AEE Database', 'Agent event envelope audit trail — stores all conversation transcripts and tool executions', '["docker://quox-collector:/var/lib/quox/aee.db"]', 'database', 'sqlite_backup', 15, 'core', 'database', 50000000),
            ('comp_memory_db', 'memory_db', 'Memory Service Database', 'SQLite database for the memory service with FTS5 full-text search', '["docker://quox-memory:/var/lib/quox/memory.db"]', 'database', 'sqlite_backup', 16, 'core', 'database', 10000000),
            ('comp_postgres', 'postgres_db', 'PostgreSQL Database', 'QuoxFlow workflow engine database — workflow definitions, execution history, and state', '["quoxflow"]', 'database', 'pg_dump', 45, 'data', 'database', 100000000),
            ('comp_org_logos', 'org_logos', 'Organization Logos', 'Uploaded organization logo and branding files', '["docker://quox-auth:/var/lib/quox/uploads/"]', 'directory', 'docker_cp', 46, 'data', 'image', 5000000),
            ('comp_quoxflow_evidence', 'quoxflow_evidence', 'QuoxFlow Evidence Files', 'Workflow execution evidence, artifacts, and audit attachments', '["docker://quox-quoxflow:/app/evidence/"]', 'directory', 'docker_cp', 47, 'data', 'file-check', 50000000),
            ('comp_ssl_certs', 'ssl_certs', 'SSL Certificates', 'TLS/SSL certificates and private keys for HTTPS services', '["/etc/ssl/quox/", "certs/"]', 'file', 'copy', 91, 'config', 'lock', 50000),
            ('comp_ssh_keys', 'ssh_keys', 'SSH Keys', 'SSH key pairs used for bastion access and fleet deployment', ${sqlPathList(hostPath('.ssh/'))}, 'directory', 'copy', 92, 'config', 'key', 20000),
            ('comp_bastion_fleet', 'bastion_fleet_registry', 'Bastion Fleet Registry', 'Fleet host registry and topology data from the bastion', ${sqlPathList(hostPath('QuoxBastion', 'data', 'fleet.json'), hostPath('QuoxBastion', 'data', 'hosts/'))}, 'file', 'copy', 115, 'infrastructure', 'network', 100000),
            ('comp_bastion_audit', 'bastion_audit_logs', 'Bastion Audit Logs', 'SSH session audit logs and command history from the bastion', '["rsync://gw-01:/var/log/quoxbastion/"]', 'directory', 'rsync', 120, 'infrastructure', 'shield', 20000000)
        `);

        console.log('Phase D.1b migration applied (21 backup components, pg_dump method, path fixes)');
    } catch (err) {
        console.error('Phase D.1b migration failed:', err.message);
    }
}

/**
 * Phase 4: widen CHECK constraints on notification_channels.channel_type,
 * notification_deliveries (recreated to drop the now-obsolete CHECK), and
 * integrations.integration_type. SQLite can't ALTER a CHECK constraint, so
 * detection requires reading sqlite_master.sql at runtime — this branching
 * can't be expressed as declarative SQL. Application-level validation
 * replaces the DB CHECK constraints once this has run.
 *
 * DEVIATION FROM THE ORIGINAL db/index.js IMPLEMENTATION (found + fixed
 * during this port's live-DB verification, TRUST-GATE migration-runner
 * work): the original detection ran a SAVEPOINT-wrapped test INSERT
 * (`INSERT INTO notification_channels (..., user_id, ...) VALUES (...,
 * '__test__', ...)`) and treated ANY failure as "needs widening". But
 * notification_channels.user_id has `REFERENCES users(id)`, so with
 * `foreign_keys = ON` (set by getDb() before this ever ran) that probe
 * INSERT fails with a FOREIGN KEY constraint error on every single boot —
 * regardless of whether the CHECK constraint had already been widened.
 * That means the original code was recreating (DROP + CREATE + INSERT
 * SELECT + RENAME) all three tables on every single auth service restart,
 * forever, silently. Confirmed via a standalone repro against an
 * in-memory DB before changing anything (bug-fix protocol: evidence
 * first). Replaced the probe with the same static-DDL-text technique
 * `applyBackupComponentsD1b` above already uses for the identical
 * SQLite-has-no-ALTER-CHECK problem (`tableSql.sql.includes('pg_dump')`):
 * read the live CREATE TABLE text and check whether the CHECK constraint
 * is still present. This makes it correctly run exactly once and never
 * needlessly recreate these tables again — a strict safety improvement
 * for a "changes to this DB are catastrophic if wrong" migration, not a
 * behavior change to anything data-facing (the recreate SQL itself is
 * byte-for-byte unchanged from the original).
 */
export function widenNotificationAndIntegrationChecks(database) {
    const tableDef = database.prepare(`
        SELECT sql FROM sqlite_master WHERE type='table' AND name='notification_channels'
    `).get();
    if (!tableDef) return;

    const needsWidenChannels = /CHECK\s*\(\s*channel_type/i.test(tableDef.sql);

    if (!needsWidenChannels) return;

    console.log('Phase 4: Widening CHECK constraints on notification_channels, notification_deliveries, integrations...');

    database.transaction(() => {
        // 1. notification_channels — recreate without CHECK on channel_type
        database.exec(`
            CREATE TABLE IF NOT EXISTS notification_channels_new (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                org_id TEXT,
                channel_type TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                config_json TEXT DEFAULT '{}',
                preferences_json TEXT DEFAULT '{}',
                verified_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);
        database.exec(`
            INSERT INTO notification_channels_new (id, user_id, org_id, channel_type, enabled, config_json, preferences_json, verified_at, created_at, updated_at)
            SELECT id, user_id, org_id, channel_type, enabled, config_json, preferences_json, verified_at, created_at, updated_at
            FROM notification_channels
        `);
        database.exec(`DROP TABLE notification_channels`);
        database.exec(`ALTER TABLE notification_channels_new RENAME TO notification_channels`);
        database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_user_org_type ON notification_channels(user_id, channel_type, org_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_notification_channels_org ON notification_channels(org_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_notification_channels_enabled ON notification_channels(enabled)`);

        // 2. notification_deliveries — recreate without CHECK on channel_type
        database.exec(`
            CREATE TABLE IF NOT EXISTS notification_deliveries_new (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                inbox_item_id TEXT REFERENCES inbox_items(id) ON DELETE SET NULL,
                escalation_stage_id TEXT,
                channel_type TEXT NOT NULL,
                recipient TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'bounced')),
                attempts INTEGER NOT NULL DEFAULT 0,
                last_attempt_at TEXT,
                last_error TEXT,
                external_id TEXT,
                content_json TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                sent_at TEXT,
                delivered_at TEXT
            )
        `);
        database.exec(`
            INSERT INTO notification_deliveries_new (id, org_id, inbox_item_id, escalation_stage_id, channel_type, recipient, status, attempts, last_attempt_at, last_error, external_id, content_json, created_at, sent_at, delivered_at)
            SELECT id, org_id, inbox_item_id, escalation_stage_id, channel_type, recipient, status, attempts, last_attempt_at, last_error, external_id, content_json, created_at, sent_at, delivered_at
            FROM notification_deliveries
        `);
        database.exec(`DROP TABLE notification_deliveries`);
        database.exec(`ALTER TABLE notification_deliveries_new RENAME TO notification_deliveries`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_notif_deliveries_org ON notification_deliveries(org_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_notif_deliveries_status ON notification_deliveries(status)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_notif_deliveries_item ON notification_deliveries(inbox_item_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_notif_deliveries_created ON notification_deliveries(created_at DESC)`);

        // 3. integrations — recreate without CHECK on integration_type
        const intInfo = database.prepare(`PRAGMA table_info(integrations)`).all();
        if (intInfo.length > 0) {
            const intCols = intInfo.map(c => c.name);
            database.exec(`
                CREATE TABLE IF NOT EXISTS integrations_new (
                    id TEXT PRIMARY KEY,
                    org_id TEXT NOT NULL,
                    integration_type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    scope_id TEXT REFERENCES scopes(id) ON DELETE SET NULL,
                    status TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('pending', 'active', 'disabled', 'error')),
                    secret_id TEXT,
                    config_json TEXT DEFAULT '{}',
                    oauth_state TEXT,
                    oauth_expires_at TEXT,
                    last_error TEXT,
                    last_error_at TEXT,
                    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            `);
            const newIntInfo = database.prepare(`PRAGMA table_info(integrations_new)`).all();
            const newCols = newIntInfo.map(c => c.name);
            const sharedCols = intCols.filter(c => newCols.includes(c));
            const colList = sharedCols.join(', ');
            database.exec(`INSERT INTO integrations_new (${colList}) SELECT ${colList} FROM integrations`);
            database.exec(`DROP TABLE integrations`);
            database.exec(`ALTER TABLE integrations_new RENAME TO integrations`);
            database.exec(`CREATE INDEX IF NOT EXISTS idx_integrations_org ON integrations(org_id)`);
            database.exec(`CREATE INDEX IF NOT EXISTS idx_integrations_type ON integrations(integration_type)`);
            database.exec(`CREATE INDEX IF NOT EXISTS idx_integrations_status ON integrations(status)`);
            database.exec(`CREATE INDEX IF NOT EXISTS idx_integrations_scope ON integrations(scope_id)`);
        }
    })();

    console.log('Phase 4: CHECK constraints widened — application-level validation now enforced');
}

/**
 * LIFECYCLE-P4-D2: drop the legacy powers_credentials table once every row
 * has a confirmed matching Vault (integration_credentials) entry. Requires
 * a per-row cross-table existence check + abort-with-WARN logic that can't
 * be expressed as declarative SQL.
 *
 * Pre-flight (synchronous):
 *   1. If table doesn't exist → already dropped, skip.
 *   2. Count rows. If 0 → drop immediately.
 *   3. If rows > 0 → verify every row has a matching label in
 *      integration_credentials (external migration script already ran).
 *      If all rows are covered → safe to drop. If any row is un-migrated →
 *      ABORT with WARN (operator must run
 *      scripts/migrate-powers-credentials-to-vault.mjs first).
 */
export function dropLegacyPowersCredentialsIfMigrated(database) {
    const hasPowersCreds = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='powers_credentials'"
    ).get();

    if (!hasPowersCreds) return;

    const rowCount = database.prepare('SELECT COUNT(*) AS n FROM powers_credentials').get().n;
    const droppedAt = new Date().toISOString();

    let safeToDropCount = 0;
    if (rowCount > 0) {
        const legacyRows = database.prepare('SELECT tool_id, key FROM powers_credentials').all();
        for (const legRow of legacyRows) {
            const label = `powers:${legRow.tool_id}:${legRow.key}`;
            const hasVaultEntry = database.prepare(
                "SELECT id FROM integration_credentials WHERE integration_type = 'custom' AND label = ? LIMIT 1"
            ).get(label);
            if (hasVaultEntry) safeToDropCount++;
        }
    }

    const unmigrated = rowCount - safeToDropCount;
    if (unmigrated > 0) {
        console.warn(
            '[LIFECYCLE-P4-D2] ABORTING table drop — %d/%d row(s) not yet in Vault. ' +
            'Run: COMMIT=true node scripts/migrate-powers-credentials-to-vault.mjs',
            unmigrated, rowCount
        );
        return;
    }

    database.exec('DROP TABLE IF EXISTS powers_credentials');
    console.log(
        '[LIFECYCLE-P4-D2] powers_credentials table dropped (row_count_at_drop=%d)',
        rowCount
    );
    try {
        const auditId = crypto.randomBytes(10).toString('hex').toUpperCase();
        database.prepare(`
            INSERT OR IGNORE INTO audit_events (
                id, org_id, actor_type, actor_id,
                action, target_type, target_id,
                status, metadata_json, created_at
            ) VALUES (?, NULL, 'system', 'system',
                'directory.system.legacy_table_dropped', 'database_table', 'powers_credentials',
                'success', ?, ?)
        `).run(
            auditId,
            JSON.stringify({ table: 'powers_credentials', dropped_at: droppedAt, row_count_at_drop: rowCount }),
            droppedAt
        );
    } catch (_) { /* audit failure is non-fatal */ }
}

/**
 * VAULT-AUDIT P1: idempotent, per-row, resumable backfill of legacy (3-part
 * iv:tag:ct) ciphertext to the v2 envelope format. For every rotatable store
 * (config/encryptedStores.js, respecting each store's `where` clause), every row
 * whose cipher is NOT NULL and NOT already `v2:%` is decrypted with the existing
 * legacy decrypt() and re-encrypted with encryptEnvelope() under an EXPLICIT KEK
 * derived here from the master (env) + salt/version (this db). Passing the KEK
 * explicitly keeps this off encryption.js's lazy getDb() path — important because
 * this runs INSIDE getDb() at boot. Skipping v2 rows makes it idempotent/resumable.
 *
 * Non-fatal by design (per this file's convention): a bad row is logged and
 * skipped; a store-level failure is caught and does not abort boot.
 *
 * @param {import('better-sqlite3').Database} database
 * @returns {{ total: number, tables: Record<string, number> }}
 */
export function backfillVaultEnvelopeEncryption(database) {
    const summary = { total: 0, tables: {} };

    const saltRow = database.prepare("SELECT value FROM instance_config WHERE key = 'vault_kek_salt'").get();
    const versionRow = database.prepare("SELECT value FROM instance_config WHERE key = 'vault_kek_version'").get();
    if (!saltRow || !versionRow) {
        // migration 073 not applied yet — nothing to backfill.
        return summary;
    }

    // Master key from env, same handling as utils/encryption.js getMasterKey():
    // base64 -> Buffer, exactly 32 bytes (truncate if longer, skip if shorter).
    const masterB64 = process.env.MASTER_ENCRYPTION_KEY;
    if (!masterB64) return summary; // no key configured (dev) — skip.
    let master = Buffer.from(masterB64, 'base64');
    if (master.length < 32) return summary;
    if (master.length > 32) master = master.subarray(0, 32);

    const salt = Buffer.from(saltRow.value, 'hex');
    const version = parseInt(versionRow.value, 10);
    const kek = deriveKek(master, salt); // EXPLICIT KEK — no re-entry into lazy init.

    for (const store of getRotatableStores()) {
        const { table, column, idColumn = 'id', where } = store;
        try {
            const tableCols = database.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name);
            if (!tableCols.includes(column)) continue;
            const hasUpdatedAt = tableCols.includes('updated_at');

            const predicates = [`${column} IS NOT NULL`, `${column} NOT LIKE 'v2:%'`];
            if (where) predicates.push(where);

            const rows = database
                .prepare(`SELECT ${idColumn} AS __id, ${column} AS __cipher FROM ${table} WHERE ${predicates.join(' AND ')}`)
                .all();
            if (rows.length === 0) continue;

            const setClause = hasUpdatedAt
                ? `${column} = ?, updated_at = datetime('now')`
                : `${column} = ?`;
            const upd = database.prepare(`UPDATE ${table} SET ${setClause} WHERE ${idColumn} = ?`);

            let migrated = 0;
            for (const row of rows) {
                try {
                    const plaintext = vaultDecrypt(row.__cipher); // legacy path (non-v2).
                    const envelope = encryptEnvelope(plaintext, kek, version);
                    upd.run(envelope, row.__id);
                    migrated++;
                } catch (err) {
                    console.warn(`[vault-backfill] ${table}.${idColumn}=${row.__id} skipped: ${err.message}`);
                }
            }

            if (migrated > 0) {
                summary.tables[table] = migrated;
                summary.total += migrated;
                console.log(`[vault-backfill] ${table}: migrated ${migrated} row(s) to v2 envelope`);
            }
        } catch (err) {
            console.warn(`[vault-backfill] store ${table} failed (non-fatal): ${err.message}`);
        }
    }

    if (summary.total > 0) {
        console.log(`[vault-backfill] total rows migrated to v2 envelope: ${summary.total}`);
    }
    return summary;
}

/**
 * QCL-IDENTITY P1 — backfills a random identity_secret for any
 * website_widgets row that doesn't have one yet (pre-migration-079 rows,
 * or any row inserted before this backfill ran). Idempotent: only rows
 * with a NULL/empty identity_secret are touched, so re-running never
 * regenerates (and therefore never invalidates) an already-issued secret
 * a customer may have already used to sign identify() calls.
 */
export function backfillWidgetIdentitySecrets(database) {
    const tableCols = database.prepare("PRAGMA table_info('website_widgets')").all().map((c) => c.name);
    if (!tableCols.includes('identity_secret')) return { total: 0 }; // migration 079 not applied yet.

    const rows = database
        .prepare("SELECT id FROM website_widgets WHERE identity_secret IS NULL OR identity_secret = ''")
        .all();
    if (rows.length === 0) return { total: 0 };

    const upd = database.prepare('UPDATE website_widgets SET identity_secret = ? WHERE id = ?');
    let migrated = 0;
    for (const row of rows) {
        try {
            upd.run(crypto.randomBytes(32).toString('hex'), row.id);
            migrated++;
        } catch (err) {
            console.warn(`[widget-identity-secret-backfill] website_widgets.id=${row.id} skipped: ${err.message}`);
        }
    }

    if (migrated > 0) {
        console.log(`[widget-identity-secret-backfill] assigned identity_secret to ${migrated} widget(s)`);
    }
    return { total: migrated };
}

/**
 * GRIPE-710: backups.status gains 'degraded' (archive built, but a REQUIRED
 * component was skipped; see lib/backupStatus.js). The original table carries
 * CHECK (status IN (...)) and SQLite cannot ALTER a CHECK, so rebuild the table
 * with the widened list, using the documented 12-step procedure
 * (foreign_keys OFF around the swap; indexes recreated). Idempotent: a table
 * whose CHECK already allows 'degraded' is left alone.
 */
export function widenBackupsStatusCheck(database) {
    const row = database.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='backups'`
    ).get();
    if (!row || !row.sql || row.sql.includes("'degraded'")) return;

    const widened = row.sql
        .replace(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i,
            (m, list) => `CHECK (status IN (${list.trim()}, 'degraded'))`)
        .replace(/CREATE TABLE\s+(IF NOT EXISTS\s+)?"?backups"?/i, 'CREATE TABLE backups_new');
    if (!widened.includes("'degraded'")) {
        console.warn('[legacyDataMigrations] widenBackupsStatusCheck: status CHECK not found, leaving table as-is');
        return;
    }

    const indexes = database.prepare(
        `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='backups' AND sql IS NOT NULL`
    ).all().map((r) => r.sql);

    database.pragma('foreign_keys = OFF');
    try {
        database.transaction(() => {
            database.exec('DROP TABLE IF EXISTS backups_new');
            database.exec(widened);
            database.exec('INSERT INTO backups_new SELECT * FROM backups');
            database.exec('DROP TABLE backups');
            database.exec('ALTER TABLE backups_new RENAME TO backups');
            for (const idx of indexes) database.exec(idx);
        })();
        console.log("GRIPE-710: backups.status CHECK widened to allow 'degraded'");
    } finally {
        database.pragma('foreign_keys = ON');
    }
}

/**
 * quox#1062 follow-up: rows written before quox#823 (d4f45ab08) may read 'completed'/'verified' with no
 * archive (NULL/0 bytes): a lock-skipped run (2026-10-11 weekly full) counted as a success in backup_status
 * and `quox backup list`. Relabel them 'failed' with the same message new runs get. Real archives and every
 * other status are untouched; idempotent (a repaired row is 'failed' and no longer matches).
 */
export function repairEmptyArchiveBackups(database) {
    const exists = database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='backups'`).get();
    if (!exists) return 0;
    const msg = 'NO ARCHIVE: this run produced no archive (0 bytes) but was recorded as completed before quox#823. Relabelled failed.';
    const r = database.prepare(`UPDATE backups SET status = 'failed', error_message = COALESCE(error_message, ?)
        WHERE status IN ('completed', 'verified') AND COALESCE(archive_size_bytes, 0) <= 0`).run(msg);
    if (r.changes) console.log(`quox#1062: relabelled ${r.changes} empty-archive backup row(s) as failed`);
    return r.changes;
}

/**
 * Runs every legacy JS-level data migration, in the same relative order
 * they ran in the original applyMigrations() (health_endpoint fix →
 * share_policies seed → backup D.1b → CHECK-widening → legacy table drop).
 * Called once at boot, after runMigrations() has applied the declarative
 * SQL migrations.
 */
export function applyLegacyDataMigrations(database) {
    try { fixLegacyHealthEndpoints(database); }
    catch (err) { console.warn('[legacyDataMigrations] fixLegacyHealthEndpoints failed (non-fatal):', err.message); }

    try { seedDefaultSharePoliciesForOrgs(database); }
    catch (err) { console.warn('[legacyDataMigrations] seedDefaultSharePoliciesForOrgs failed (non-fatal):', err.message); }

    try { applyBackupComponentsD1b(database); }
    catch (err) { console.warn('[legacyDataMigrations] applyBackupComponentsD1b failed (non-fatal):', err.message); }

    try { widenNotificationAndIntegrationChecks(database); }
    catch (err) { console.warn('[legacyDataMigrations] widenNotificationAndIntegrationChecks failed (non-fatal):', err.message); }

    try { widenBackupsStatusCheck(database); }
    catch (err) { console.warn('[legacyDataMigrations] widenBackupsStatusCheck failed (non-fatal):', err.message); }

    try { dropLegacyPowersCredentialsIfMigrated(database); }
    catch (err) { console.warn('[legacyDataMigrations] dropLegacyPowersCredentialsIfMigrated failed (non-fatal):', err.message); }

    try { backfillVaultEnvelopeEncryption(database); }
    catch (err) { console.warn('[legacyDataMigrations] backfillVaultEnvelopeEncryption failed (non-fatal):', err.message); }

    try { backfillWidgetIdentitySecrets(database); }
    catch (err) { console.warn('[legacyDataMigrations] backfillWidgetIdentitySecrets failed (non-fatal):', err.message); }

    try { repairEmptyArchiveBackups(database); }
    catch (err) { console.warn('[legacyDataMigrations] repairEmptyArchiveBackups failed (non-fatal):', err.message); }
}
