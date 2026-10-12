#!/usr/bin/env node
/**
 * migrate-keys-to-vault.js — One-time migration of instance_config API keys to QuoxVault
 *
 * Reads all API keys from the instance_config table and creates
 * integration_credentials entries with encryption. Idempotent — skips
 * if a vault entry already exists for the provider/org combination.
 *
 * Usage: node services/auth/scripts/migrate-keys-to-vault.js [--dry-run]
 */

import { getDb, prepare } from '../db/index.js';
import { createCredential, getDefaultCredential } from '../db/integrations.js';

const DRY_RUN = process.argv.includes('--dry-run');

// Map instance_config keys to integration types
const KEY_MAP = {
    anthropic_api_key: { type: 'anthropic', field: 'api_key', label: 'Anthropic (migrated)' },
    openai_api_key: { type: 'openai', field: 'api_key', label: 'OpenAI (migrated)' },
    perplexity_api_key: { type: 'perplexity', field: 'api_key', label: 'Perplexity (migrated)' },
    gemini_api_key: { type: 'gemini', field: 'api_key', label: 'Google Gemini (migrated)' },
    elevenlabs_api_key: { type: 'elevenlabs', field: 'api_key', label: 'ElevenLabs (migrated)' }
};

async function migrate() {
    console.log(DRY_RUN ? '=== DRY RUN ===' : '=== Migrating instance_config keys to QuoxVault ===');

    const db = getDb();

    // Find the primary org (first org created, or 'default')
    const primaryOrg = db.prepare(
        "SELECT id FROM orgs ORDER BY created_at ASC LIMIT 1"
    ).get();

    if (!primaryOrg) {
        console.log('No organizations found. Create an org first, then re-run migration.');
        process.exit(0);
    }

    const orgId = primaryOrg.id;
    console.log(`Target org: ${orgId}`);

    // Find the owner user for created_by
    const owner = db.prepare(
        "SELECT owner_user_id FROM orgs WHERE id = ?"
    ).get(orgId);
    const createdBy = owner?.owner_user_id || 'system';

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const [configKey, mapping] of Object.entries(KEY_MAP)) {
        const row = db.prepare(
            'SELECT value, encrypted FROM instance_config WHERE key = ?'
        ).get(configKey);

        if (!row?.value) {
            console.log(`  [SKIP] ${configKey}: not configured`);
            skipped++;
            continue;
        }

        // Check if vault entry already exists
        const existing = getDefaultCredential(orgId, mapping.type);
        if (existing) {
            console.log(`  [SKIP] ${mapping.type}: vault entry already exists (${existing.label})`);
            skipped++;
            continue;
        }

        // Decrypt if needed
        let plainValue;
        try {
            if (row.encrypted) {
                const { decrypt } = await import('../utils/encryption.js');
                plainValue = decrypt(row.value);
            } else {
                plainValue = row.value;
            }
        } catch (err) {
            console.error(`  [ERROR] ${configKey}: failed to decrypt — ${err.message}`);
            errors++;
            continue;
        }

        if (!plainValue || plainValue === 'CHANGE_ME' || plainValue.startsWith('PLACEHOLDER')) {
            console.log(`  [SKIP] ${configKey}: placeholder value`);
            skipped++;
            continue;
        }

        console.log(`  [MIGRATE] ${configKey} → ${mapping.type} vault entry`);

        if (!DRY_RUN) {
            try {
                createCredential({
                    org_id: orgId,
                    integration_type: mapping.type,
                    label: mapping.label,
                    credentials: { [mapping.field]: plainValue },
                    is_default: true,
                    created_by: createdBy,
                    description: `Migrated from instance_config.${configKey}`
                });
                migrated++;
            } catch (err) {
                console.error(`  [ERROR] Failed to create vault entry: ${err.message}`);
                errors++;
            }
        } else {
            migrated++;
        }
    }

    console.log(`\nDone: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
    if (DRY_RUN) console.log('(Dry run — no changes made. Remove --dry-run to apply.)');
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
