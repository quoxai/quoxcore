/**
 * Backfill default builtin tools onto existing widgets that have ZERO tools.
 *
 * The QUOXCHAT-PRO audit found live widgets (e.g. wid_01kpnyr1afay) with no
 * widget_tools rows at all, so human_handoff never reached the LLM and
 * visitors asking for a human were brushed off. New widgets are seeded at
 * creation (routes/widgets.js -> lib/widgetDefaultTools.js); this script
 * brings existing widgets up to the same baseline.
 *
 * Seed set (see lib/widgetDefaultTools.js, the single source of truth):
 *   active:   human_handoff, lead_capture, email_transcript, leave_message
 *   disabled: book_appointment, schedule_demo (org opts in)
 *
 * Idempotent: only widgets with zero tools are touched; per-tool inserts
 * skip names that already exist; a second run changes nothing.
 *
 * Run inside the auth environment (dry run first):
 *   node services/auth/scripts/backfill-widget-default-tools.js --dry-run
 *   node services/auth/scripts/backfill-widget-default-tools.js
 */

import { getDb } from '../db/index.js';
import { backfillDefaultWidgetTools, backfillHumanHandoffSummarySchema, backfillDefaultToolPolicies, backfillEmailTranscriptSchema } from '../lib/widgetDefaultTools.js';

getDb();

const dryRun = process.argv.includes('--dry-run');

const out = backfillDefaultWidgetTools({ dryRun });

console.log(`Widgets scanned: ${out.candidates}${dryRun ? ' (dry run)' : ''}`);
console.log(`Widgets with existing tools (untouched): ${out.skippedWithTools}`);
console.log(`Widgets with zero tools ${dryRun ? 'that would be seeded' : 'seeded'}: ${out.seeded}`);
for (const r of out.results) {
  console.log(`  ${r.widget_id} ("${r.name}"): ${dryRun ? 'would insert' : 'inserted'} ${r.inserted.join(', ')}`);
}
console.log(`\nDone.${dryRun ? ' No writes performed.' : ''}`);

// Handover-summary schema backfill: bring existing human_handoff rows
// (seeded before the `summary` parameter shipped) up to the canonical
// schema so the LLM can author a handover summary on every widget.
const schemaOut = backfillHumanHandoffSummarySchema({ dryRun });
console.log(`\nhuman_handoff tool rows scanned: ${schemaOut.scanned}${dryRun ? ' (dry run)' : ''}`);
console.log(`human_handoff tool rows ${dryRun ? 'that would be updated to the summary schema' : 'updated to the summary schema'}: ${schemaOut.updated}`);
for (const r of schemaOut.results) {
  console.log(`  tool ${r.tool_id} (widget ${r.widget_id}): ${dryRun ? 'would update' : 'updated'} parameters_json`);
}
console.log(`\nDone.${dryRun ? ' No writes performed.' : ''}`);

// QUOXCHAT-EMAIL D4 — allow-list email_transcript where the tool is active
// but no tool_policies decision was ever recorded.
const policiesOut = backfillDefaultToolPolicies({ dryRun });
console.log(`tool_policies backfill: ${policiesOut.updated}/${policiesOut.candidates} widget(s)${dryRun ? ' (dry run)' : ''}`);

const transcriptSchemaOut = backfillEmailTranscriptSchema({ dryRun });
console.log(`email_transcript schema backfill: ${transcriptSchemaOut.updated}/${transcriptSchemaOut.scanned} row(s)${dryRun ? ' (dry run)' : ''}`);
