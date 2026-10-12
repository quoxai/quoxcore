/**
 * Validation Suite REST API — STUDY-REV-2 P8.E.3
 *
 * Routes:
 *   GET  /api/validation/agents     — list registered TBs
 *   POST /api/validation/run        — run one TB or all, returns RunResult[]
 *   GET  /api/validation/nightly    — last 30 nightly reports
 *   GET  /api/validation/streak     — consecutive-green counter (the 14-night gate)
 */

import { Hono, Context } from 'hono';
import { AppEnv } from '../types.js';
import { getAllAgents, runAll, runOne } from '../../validation/index.js';
import { listAgentMeta } from '../../validation/registry.js';
import { persistReport, listReports, computeStreak } from '../../validation/reporter.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function success(c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) {
  return c.json(
    {
      success: true,
      data,
      meta: {
        requestId: c.get('correlationId') || 'unknown',
        timestamp: new Date().toISOString(),
      },
    },
    status,
  );
}

function errorResp(c: Context<AppEnv>, status: number, code: string, message: string) {
  return c.json({ success: false, error: { code, message } }, status as any);
}

// ─── Route Factory ────────────────────────────────────────────────────────────

export function createValidationRoutes() {
  const app = new Hono<AppEnv>();

  /**
   * GET /api/validation/agents
   *
   * List all registered validation agents with metadata.
   * Does NOT run the agents — instant response.
   */
  app.get('/agents', c => {
    const agents = listAgentMeta();
    return success(c, { agents, totalAgents: agents.length });
  });

  /**
   * POST /api/validation/run
   *
   * Run one TB or all TBs. Body:
   *   { id?: "TB-1" | "TB-2" | ... }  — omit to run all
   *
   * Returns RunResult[].
   * Each TB is independently safe — failures return a RunResult with passed=false,
   * NOT a 500. Only a totally unexpected throw from the suite itself gives a 500.
   */
  app.post('/run', async c => {
    let body: { id?: string } = {};
    try {
      body = (await c.req.json()) as any;
    } catch {
      // body is optional — empty body = run all
    }

    const id = body?.id?.trim();

    if (id) {
      // Validate the id is one of the known TB ids
      const known = getAllAgents().map(a => a.id);
      if (!known.includes(id as any)) {
        return errorResp(c, 400, 'UNKNOWN_AGENT', `Unknown agent id: ${id}. Valid: ${known.join(', ')}`);
      }

      const result = await runOne(id);
      if (!result) {
        return errorResp(c, 404, 'AGENT_NOT_FOUND', `Agent ${id} not found`);
      }

      return success(c, { results: [result], totalAgents: 1, passed: result.passed ? 1 : 0, failed: result.passed ? 0 : 1 });
    }

    // Run all
    const report = await runAll();
    await persistReport(report).catch(() => { /* non-blocking */ });

    return success(c, {
      results: report.results,
      totalAgents: report.totalAgents,
      passed: report.passed,
      failed: report.failed,
    });
  });

  /**
   * GET /api/validation/nightly
   *
   * List the last 30 nightly reports (newest first).
   * Query param: ?limit=N (max 30, default 30)
   */
  app.get('/nightly', async c => {
    const rawLimit = parseInt(c.req.query('limit') ?? '30', 10);
    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 30 : rawLimit), 30);

    const reports = await listReports(limit);
    return success(c, { reports, count: reports.length });
  });

  /**
   * GET /api/validation/streak
   *
   * Returns the consecutive-green-night streak counter.
   * Gate: 14 consecutive nights with passed===totalAgents.
   *
   * Response: { streak: N, target: 14, eligibleAt?: ISO }
   */
  app.get('/streak', async c => {
    const TARGET = 14;
    const streak = await computeStreak(TARGET);
    return success(c, streak);
  });

  return app;
}
