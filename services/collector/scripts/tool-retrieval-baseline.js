#!/usr/bin/env node
/**
 * TOOL-RETRIEVAL P0 baseline.
 *
 * Read-only measurement script — does not touch the /chat loading path
 * (services/collector/server.js:17254-17270). It re-derives the same
 * getToolsForAgent() -> slice(0, TOOL_CAP) resolution that server.js
 * performs at request time, using the hardcoded/entity tool set only (no
 * DB-installed or org connector tools — those can only ADD to an agent's
 * count, so this is a lower-bound / conservative baseline).
 *
 * Usage: node services/collector/scripts/tool-retrieval-baseline.js
 * Output: console summary + JSON report at
 *   services/collector/logs/tool-retrieval-baseline-report.json
 */
const fs = require('fs');
const path = require('path');
const { AGENT_TOOLS, TOOL_DEFS, getToolsForAgent } = require('../lib/agentTools.js');
const testset = require('./fixtures/tool-retrieval-testset.json');

// Must match the cap enforced at server.js:17267 ("OpenAI API has a 128
// tool limit — truncate if exceeded"). That check runs unconditionally,
// before the provider branch, so it caps every provider today, not just
// OpenAI. Kept as a local literal (not imported) — this script measures
// current behavior, it does not share code with the loading path.
const TOOL_CAP = 128;

// cl100k-style rough estimate (~4 chars/token for English + JSON). No
// tokenizer dependency exists in this repo today (checked package.json) —
// this is an order-of-magnitude approximation, not a billed-token figure.
function estimateTokens(tools) {
  return Math.ceil(JSON.stringify(tools).length / 4);
}

function resolveAsServerWouldToday(agentId) {
  const full = getToolsForAgent(agentId);
  const truncated = full.length > TOOL_CAP ? full.slice(0, TOOL_CAP) : full;
  return { full, truncated };
}

function perAgentReport() {
  const agents = Object.keys(AGENT_TOOLS).sort();
  const rows = agents.map((agentId) => {
    const { full, truncated } = resolveAsServerWouldToday(agentId);
    const dropped = full.slice(TOOL_CAP);
    return {
      agent: agentId,
      tool_count: full.length,
      truncated: full.length > TOOL_CAP,
      dropped_count: dropped.length,
      dropped_tools: dropped.map((t) => t.name),
      est_tokens_full: estimateTokens(full),
      est_tokens_sent: estimateTokens(truncated),
    };
  });
  rows.sort((a, b) => b.tool_count - a.tool_count);
  return rows;
}

function runTestSet(rows) {
  const byAgent = new Map(rows.map((r) => [r.agent, r]));
  const results = testset.cases.map((c) => {
    const { truncated } = resolveAsServerWouldToday(c.agent);
    const present = truncated.some((t) => t.name === c.expected_tool);
    return {
      id: c.id,
      agent: c.agent,
      query: c.query,
      expected_tool: c.expected_tool,
      tool_index_at_baseline: c.tool_index_at_baseline ?? null,
      result: present ? 'HIT' : 'MISS',
    };
  });
  const hits = results.filter((r) => r.result === 'HIT').length;
  return {
    total: results.length,
    hits,
    misses: results.length - hits,
    hit_rate: results.length ? +(hits / results.length).toFixed(4) : null,
    cases: results,
  };
}

function main() {
  const rows = perAgentReport();
  const testResults = runTestSet(rows);

  const truncatedAgents = rows.filter((r) => r.truncated);

  console.log('=== TOOL-RETRIEVAL P0 baseline ===');
  console.log(`Agents measured: ${rows.length}`);
  console.log(`Total TOOL_DEFS registry size: ${Object.keys(TOOL_DEFS).length}`);
  console.log('');
  console.log('Top 10 agents by tool count:');
  rows.slice(0, 10).forEach((r) => {
    const flag = r.truncated ? `  <<< TRUNCATED, ${r.dropped_count} tools permanently unreachable` : '';
    console.log(`  ${r.agent.padEnd(16)} ${String(r.tool_count).padStart(4)} tools  ~${r.est_tokens_sent} tok sent${flag}`);
  });
  console.log('');
  if (truncatedAgents.length > 0) {
    console.log(`Agents exceeding the ${TOOL_CAP}-tool cap: ${truncatedAgents.map((r) => r.agent).join(', ')}`);
    truncatedAgents.forEach((r) => {
      console.log(`  ${r.agent}: dropped tools (always unreachable, any provider) -> ${r.dropped_tools.join(', ')}`);
    });
  } else {
    console.log(`No agent exceeds the ${TOOL_CAP}-tool cap in the hardcoded/entity baseline.`);
  }
  console.log('');
  console.log(`Test set: ${testResults.hits}/${testResults.total} HIT (${(testResults.hit_rate * 100).toFixed(1)}%)`);
  testResults.cases.filter((c) => c.result === 'MISS').forEach((c) => {
    console.log(`  MISS [${c.id}] agent=${c.agent} expected_tool=${c.expected_tool} (index ${c.tool_index_at_baseline}) query="${c.query}"`);
  });

  const report = {
    generated_at: new Date().toISOString(),
    tool_cap: TOOL_CAP,
    tool_defs_registry_size: Object.keys(TOOL_DEFS).length,
    agents_measured: rows.length,
    agents_exceeding_cap: truncatedAgents.map((r) => r.agent),
    per_agent: rows,
    testset: testResults,
  };
  const outPath = path.join(__dirname, '..', 'logs', 'tool-retrieval-baseline-report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('');
  console.log(`Full report written to ${outPath}`);
}

main();
