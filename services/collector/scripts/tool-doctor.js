#!/usr/bin/env node
/**
 * tool-doctor — ops runner for the live tool-surface health probe.
 *
 * Run inside the collector container (has the env + backends):
 *   docker exec quox-collector node scripts/tool-doctor.js
 *
 * Owned by TOOLSMITH as the tools_doctor agent tool; this is the same
 * lib/toolDoctor.js probe with a human-readable print. NEVER calls destructive
 * or approval-gated tools. See lib/toolDoctor.js for the safety model.
 */
const { TOOL_DEFS } = require('../lib/agentTools.js');
const { runDoctor } = require('../lib/toolDoctor.js');

(async () => {
  const report = await runDoctor({ TOOL_DEFS, ctx: { orgId: 'default' } });
  report.generatedAt = new Date().toISOString();
  console.log('\n=== TOOL-DOCTOR ' + report.generatedAt + ' ===');
  console.log(`total ${report.total} | probed ${report.probed} | skipped ${report.skipped}`);
  console.log('verdicts:', JSON.stringify(report.byVerdict));
  console.log('skipped :', JSON.stringify(report.skippedReasons));
  if (report.broken.length) {
    console.log(`\nACTIONABLE — broken (${report.broken.length}):`);
    for (const b of report.broken) {
      console.log('  ' + String(b.verdict).padEnd(12) + b.name + (b.detail ? '  :: ' + b.detail : ''));
    }
  } else {
    console.log('\nNo broken tools among the probed read-only surface.');
  }
  if (report.needsContext.length) {
    console.log(`\nINCONCLUSIVE — need a user/org session to probe (${report.needsContext.length}): ${report.needsContext.join(', ')}`);
  }
  process.exit(0);
})().catch((e) => { console.error('tool-doctor failed:', e.message); process.exit(1); });
