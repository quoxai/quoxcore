/**
 * Schedule Executor
 *
 * Handles trigger:schedule nodes with cron expressions.
 * Uses croner for cron parsing and job management.
 *
 * Node type: trigger:schedule
 * Config:
 *   - expression: cron expression (e.g., "0 9 * * *")
 *   - timezone: IANA timezone (default: "UTC")
 *   - paused: boolean (default: false)
 *   - label: optional human-readable description
 */

import { Cron } from 'croner';
import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { logger } from '../logger.js';

const log = logger.for('Schedule');

interface ScheduleConfig {
  expression: string;
  timezone?: string;
  paused?: boolean;
  label?: string;
}

interface ScheduleJob {
  cron: Cron;
  workflowId: string;
  nodeId: string;
  config: ScheduleConfig;
  // QF-MT WP4: owning org, stamped at registerSchedule() time from the
  // owning workflow row (stored.orgId ?? stored.metadata.orgId). Immutable
  // across pause/resume/update — none of those mutate ownership.
  orgId: string;
}

/**
 * ScheduleExecutor handles trigger:schedule nodes.
 *
 * In execution mode (pipeline calls execute()), it emits the schedule trigger
 * envelope and passes through. The actual cron scheduling is managed
 * separately via registerSchedule/unregisterSchedule for server-mode operation.
 */
export class ScheduleExecutor implements NodeExecutor {
  readonly nodeTypes = ['trigger:schedule'];
  private jobs: Map<string, ScheduleJob> = new Map();
  private pausedJobs: Map<string, { workflowId: string; nodeId: string; config: ScheduleConfig; orgId: string }> = new Map();

  /**
   * Execute a schedule trigger node.
   * Emits a trigger-fired event and passes data downstream.
   */
  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const config = node.config as ScheduleConfig;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Emit trigger fired event
    const triggerEnvelope = factory.event(
      'quox.flow.trigger.schedule.fired',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        expression: config.expression,
        timezone: config.timezone ?? 'UTC',
        label: config.label,
        firedAt: new Date().toISOString(),
      }
    );
    emitted.push(triggerEnvelope);

    // Build output for downstream nodes
    const output = {
      triggered_at: new Date().toISOString(),
      schedule: config.expression,
      timezone: config.timezone ?? 'UTC',
      label: config.label,
      // Pass through any input data (e.g., from manual trigger or test run)
      ...(typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}),
    };

    // Emit completion event
    const completeEnvelope = factory.event(
      Intents.NODE.COMPLETED,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
      }
    );
    emitted.push(completeEnvelope);

    return {
      success: true,
      output,
      envelopes: emitted,
    };
  }

  /**
   * Validate schedule node configuration.
   */
  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as ScheduleConfig;
    const errors: string[] = [];

    if (!config.expression) {
      errors.push('expression is required');
    } else {
      try {
        // Validate cron expression by attempting to construct
        const job = new Cron(config.expression, { timezone: config.timezone ?? 'UTC' });
        job.stop();
      } catch (err) {
        errors.push(`Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (config.timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: config.timezone });
      } catch {
        errors.push(`Invalid timezone: ${config.timezone}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // =========================================================================
  // Server-mode schedule management
  // =========================================================================

  /**
   * Register a cron schedule that fires a callback on each tick.
   *
   * QF-MT WP4: `orgId` is mandatory — stamped by the caller from the owning
   * workflow row (stored.orgId ?? stored.metadata.orgId), so schedules.ts /
   * triggers.ts can filter GET /api/schedules and GET /api/triggers/schedules
   * by caller scope and reject cross-org mutation.
   */
  registerSchedule(
    workflowId: string,
    nodeId: string,
    config: ScheduleConfig,
    callback: () => void,
    orgId: string
  ): void {
    const jobKey = `${workflowId}:${nodeId}`;

    // Clean up existing job for this key
    this.unregisterSchedule(workflowId, nodeId);

    if (config.paused) return;

    const cron = new Cron(config.expression, {
      timezone: config.timezone ?? 'UTC',
    }, callback);

    this.jobs.set(jobKey, { cron, workflowId, nodeId, config, orgId });
    log.info(`Registered: ${jobKey} — ${config.expression} (${config.timezone ?? 'UTC'})`);
  }

  /**
   * Unregister a scheduled cron job.
   */
  unregisterSchedule(workflowId: string, nodeId: string): void {
    const jobKey = `${workflowId}:${nodeId}`;
    const existing = this.jobs.get(jobKey);
    if (existing) {
      existing.cron.stop();
      this.jobs.delete(jobKey);
      log.info(`Unregistered: ${jobKey}`);
    }
  }

  /**
   * Unregister all schedules for a workflow.
   */
  unregisterWorkflow(workflowId: string): void {
    for (const [key, job] of this.jobs) {
      if (job.workflowId === workflowId) {
        job.cron.stop();
        this.jobs.delete(key);
        log.info(`Unregistered: ${key}`);
      }
    }
  }

  /**
   * Stop all scheduled jobs (shutdown).
   */
  stopAll(): void {
    for (const [key, job] of this.jobs) {
      job.cron.stop();
      log.info(`Stopped: ${key}`);
    }
    this.jobs.clear();
  }

  /**
   * Pause a running schedule (stops cron but remembers config).
   */
  pauseSchedule(workflowId: string, nodeId: string): boolean {
    const jobKey = `${workflowId}:${nodeId}`;
    const existing = this.jobs.get(jobKey);
    if (!existing) return false;

    existing.cron.stop();
    this.pausedJobs.set(jobKey, {
      workflowId: existing.workflowId,
      nodeId: existing.nodeId,
      config: existing.config,
      orgId: existing.orgId,
    });
    this.jobs.delete(jobKey);
    log.info(`Paused: ${jobKey}`);
    return true;
  }

  /**
   * Resume a paused schedule.
   */
  resumeSchedule(
    workflowId: string,
    nodeId: string,
    callback: () => void
  ): boolean {
    const jobKey = `${workflowId}:${nodeId}`;
    const paused = this.pausedJobs.get(jobKey);
    if (!paused) return false;

    const cron = new Cron(paused.config.expression, {
      timezone: paused.config.timezone ?? 'UTC',
    }, callback);

    this.jobs.set(jobKey, { cron, workflowId, nodeId, config: paused.config, orgId: paused.orgId });
    this.pausedJobs.delete(jobKey);
    log.info(`Resumed: ${jobKey} — ${paused.config.expression}`);
    return true;
  }

  /**
   * Update a schedule's config (expression, timezone). Re-registers the cron.
   */
  updateSchedule(
    workflowId: string,
    nodeId: string,
    newConfig: Partial<ScheduleConfig>,
    callback: () => void
  ): boolean {
    const jobKey = `${workflowId}:${nodeId}`;
    const existing = this.jobs.get(jobKey);
    const paused = this.pausedJobs.get(jobKey);

    if (!existing && !paused) return false;

    // QF-MT WP4: org is immutable across an update — carried from whichever
    // record already exists, never accepted from the caller.
    const orgId = (existing ?? paused)!.orgId;
    const currentConfig = existing?.config ?? paused!.config;
    const mergedConfig: ScheduleConfig = {
      ...currentConfig,
      ...newConfig,
    };

    // If paused, just update the saved config
    if (paused) {
      this.pausedJobs.set(jobKey, { workflowId, nodeId, config: mergedConfig, orgId });
      log.info(`Updated paused config: ${jobKey} — ${mergedConfig.expression}`);
      return true;
    }

    // Stop existing and re-register with new config
    existing!.cron.stop();
    this.jobs.delete(jobKey);

    if (mergedConfig.paused) {
      this.pausedJobs.set(jobKey, { workflowId, nodeId, config: mergedConfig, orgId });
      log.info(`Updated + paused: ${jobKey}`);
      return true;
    }

    const cron = new Cron(mergedConfig.expression, {
      timezone: mergedConfig.timezone ?? 'UTC',
    }, callback);

    this.jobs.set(jobKey, { cron, workflowId, nodeId, config: mergedConfig, orgId });
    log.info(`Updated: ${jobKey} — ${mergedConfig.expression} (${mergedConfig.timezone ?? 'UTC'})`);
    return true;
  }

  /**
   * Check if a schedule is paused.
   */
  isPaused(workflowId: string, nodeId: string): boolean {
    return this.pausedJobs.has(`${workflowId}:${nodeId}`);
  }

  /**
   * Get info about all active and paused schedules.
   */
  getActiveSchedules(): Array<{
    workflowId: string;
    nodeId: string;
    expression: string;
    timezone: string;
    nextRun: Date | null;
    active: boolean;
    orgId: string;
  }> {
    const active = Array.from(this.jobs.values()).map(job => ({
      workflowId: job.workflowId,
      nodeId: job.nodeId,
      expression: job.config.expression,
      timezone: job.config.timezone ?? 'UTC',
      nextRun: job.cron.nextRun(),
      active: true,
      orgId: job.orgId,
    }));

    const paused = Array.from(this.pausedJobs.values()).map(pj => ({
      workflowId: pj.workflowId,
      nodeId: pj.nodeId,
      expression: pj.config.expression,
      timezone: pj.config.timezone ?? 'UTC',
      nextRun: null,
      active: false,
      orgId: pj.orgId,
    }));

    return [...active, ...paused];
  }

  /**
   * Get count of active schedules.
   */
  get activeCount(): number {
    return this.jobs.size;
  }
}

export const scheduleExecutor = new ScheduleExecutor();
