/**
 * Engine Validation Suite — Types
 *
 * STUDY-REV-2 P8.E — Five nightly TB agents that exercise all 9 engine surfaces.
 * Going green for 14 consecutive nights gates the BQ-AGENTIC-MIGRATION stream.
 */

export type TBId = 'TB-1' | 'TB-2' | 'TB-3' | 'TB-4' | 'TB-5';

/** Result of running one validation agent */
export interface RunResult {
  id: TBId;
  name: string;
  passed: boolean;
  durationMs: number;
  /** Surfaces validated (index references the 9 engine surfaces) */
  surfacesCovered: number[];
  /** All AOCL envelope intents emitted during the run */
  envelopeIntents: string[];
  /** Token estimates (0 with mock thinker) */
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: number;
  /** Failure reason — set when passed=false */
  failureReason?: string;
  /** Structured assertions that were checked */
  assertions: AssertionResult[];
}

export interface AssertionResult {
  label: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
}

/** Aggregated nightly report */
export interface NightlyReport {
  ranAt: string;
  totalAgents: number;
  passed: number;
  failed: number;
  results: RunResult[];
  /** Unique AOCL intents observed across all TB runs */
  envelopeIntents: string[];
  totalTokensIn: number;
  totalCostUsdMicro: number;
}

/** Contract every validation agent must satisfy */
export interface ValidationAgent {
  readonly id: TBId;
  readonly name: string;
  readonly description: string;
  /** Engine surfaces this agent exercises (1-indexed, see spec) */
  readonly surfacesCovered: number[];
  /** Run the agent end-to-end. Must NOT throw — return a failed RunResult instead. */
  run(opts?: RunOptions): Promise<RunResult>;
}

export interface RunOptions {
  /** When true, swap the mock thinker for the real LLM (nightly sanity call) */
  useRealLlm?: boolean;
  /** Collector URL — only used when useRealLlm=true */
  collectorUrl?: string;
  /** Service key — only used when useRealLlm=true */
  serviceKey?: string;
}
