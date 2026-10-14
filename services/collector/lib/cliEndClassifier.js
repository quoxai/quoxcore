'use strict';
/**
 * Classify how a one-shot Claude CLI dispatch ended on /chat/stream.
 * A kill caused by the turn's own interrupt (SIGTERM, exit 143, thrown or
 * returned as an error) is 'interrupted', never 'failed'. Genuine crashes
 * (no interrupt) stay 'failed'. A client disconnect is not an interrupt.
 */
function classifyCliEnd({ interrupted, aborted, thrown, result }) {
  if (interrupted && !aborted) return 'interrupted';
  if (thrown) return 'failed';
  if (!result || result.outcome !== 'success') return 'failed';
  return 'ok';
}
module.exports = { classifyCliEnd };
