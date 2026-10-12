/**
 * REG-3: Seed the model_definitions table with the 5 models currently in
 * use across the Quox codebase (2026-04-12).
 *
 * Source of truth: src/config/assistants.js llm.model strings.
 * Governance metadata (risk_tier, data_residency, compliance certifications)
 * is assigned here based on vendor public statements + our own risk
 * assessment. Change via updateModel() not by editing seed data.
 *
 * Run:
 *   node services/auth/scripts/seed-models.js
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createModel, getModel } from '../lib/reg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.AUTH_DB_PATH || join(__dirname, '..', 'data', 'auth.db');

/** The 5 models currently referenced by assistants.js. Edit assistants.js
 *  FIRST when adding a new model — this seeder reflects what's in use. */
const CORE_MODELS = [
  {
    model_id: 'claude-sonnet-4-6',
    display_name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    provider_model_id: 'claude-sonnet-4-6',
    context_window: 200000,
    supports_vision: 1,
    supports_tools: 1,
    cost_per_input_mtok: 3.00,
    cost_per_output_mtok: 15.00,
    risk_tier: 'standard',
    data_residency: 'us',
    compliance_certifications: JSON.stringify(['SOC2']),
    knowledge_cutoff: '2025-04',
  },
  {
    model_id: 'claude-3-5-haiku-20241022',
    display_name: 'Claude Haiku 3.5',
    provider: 'anthropic',
    provider_model_id: 'claude-3-5-haiku-20241022',
    context_window: 200000,
    supports_vision: 0,
    supports_tools: 1,
    cost_per_input_mtok: 0.80,
    cost_per_output_mtok: 4.00,
    risk_tier: 'low',
    data_residency: 'us',
    compliance_certifications: JSON.stringify(['SOC2']),
    knowledge_cutoff: '2024-10',
  },
  {
    model_id: 'gpt-5.4',
    display_name: 'OpenAI GPT 5.4',
    provider: 'openai',
    provider_model_id: 'gpt-5.4',
    context_window: 128000,
    supports_vision: 1,
    supports_tools: 1,
    cost_per_input_mtok: 2.50,
    cost_per_output_mtok: 10.00,
    risk_tier: 'standard',
    data_residency: 'us',
    compliance_certifications: JSON.stringify(['SOC2']),
    knowledge_cutoff: '2025-01',
  },
  {
    model_id: 'gemini-2.5-pro',
    display_name: 'Gemini 2.5 Pro',
    provider: 'gemini',
    provider_model_id: 'gemini-2.5-pro',
    context_window: 2_000_000,
    supports_vision: 1,
    supports_tools: 1,
    cost_per_input_mtok: 1.25,
    cost_per_output_mtok: 10.00,
    risk_tier: 'standard',
    data_residency: 'global',
    compliance_certifications: JSON.stringify(['SOC2']),
    knowledge_cutoff: '2025-01',
  },
  {
    model_id: 'gemini-2.5-flash-image',
    display_name: 'Gemini 2.5 Flash Image',
    provider: 'gemini',
    provider_model_id: 'gemini-2.5-flash-image',
    context_window: 1_000_000,
    supports_vision: 1,
    supports_tools: 0,
    cost_per_input_mtok: 0.075,
    cost_per_output_mtok: 0.30,
    risk_tier: 'standard',
    data_residency: 'global',
    compliance_certifications: JSON.stringify(['SOC2']),
    knowledge_cutoff: '2025-01',
  },
];

function main() {
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  let added = 0;
  let skipped = 0;
  for (const model of CORE_MODELS) {
    const existing = getModel(db, model.model_id);
    if (existing) {
      skipped++;
      continue;
    }
    try {
      createModel(db, model);
      added++;
      console.log(`  + ${model.provider}/${model.model_id}`);
    } catch (err) {
      console.error(`  ✗ ${model.model_id}: ${err.message}`);
    }
  }
  console.log(`\nSeeded ${added} model(s), skipped ${skipped} already-present.`);
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { CORE_MODELS, main };
