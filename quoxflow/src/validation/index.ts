/**
 * Engine Validation Suite — Public API
 *
 * STUDY-REV-2 P8.E
 *
 * Five nightly TB agents that exercise all 9 engine surfaces.
 * 14 consecutive green nights gates BQ-AGENTIC-MIGRATION.
 *
 * Usage:
 *   import { runAll } from './validation/index.js';
 *   const report = await runAll();
 */

export * from './types.js';
export * from './registry.js';

import { getAllAgents } from './registry.js';
import { NightlyReport, RunResult, RunOptions } from './types.js';

/**
 * Run all registered validation agents and aggregate a NightlyReport.
 * Each agent is run sequentially (isolation). Failures do NOT abort the suite.
 */
export async function runAll(opts?: RunOptions): Promise<NightlyReport> {
  const agents = getAllAgents();
  const results: RunResult[] = [];

  for (const agent of agents) {
    const result = await agent.run(opts);
    results.push(result);
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const allIntents = [...new Set(results.flatMap(r => r.envelopeIntents))].sort();
  const totalTokensIn = results.reduce((sum, r) => sum + r.tokensIn, 0);
  const totalCostUsdMicro = results.reduce((sum, r) => sum + r.costUsdMicro, 0);

  return {
    ranAt: new Date().toISOString(),
    totalAgents: agents.length,
    passed,
    failed,
    results,
    envelopeIntents: allIntents,
    totalTokensIn,
    totalCostUsdMicro,
  };
}

/**
 * Run a single agent by ID. Returns null if not found.
 */
export async function runOne(id: string, opts?: RunOptions): Promise<RunResult | null> {
  const agents = getAllAgents();
  const agent = agents.find(a => a.id === id);
  if (!agent) return null;
  return agent.run(opts);
}
