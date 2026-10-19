'use strict';
/**
 * DEVFLEET-DOCKER: what the /docker/* routes may cache.
 *
 * An error body is not data. A refused, failed or partial result must never be written to the
 * docker cache, or the next cached read serves an incomplete fleet as if it were the whole one.
 * `key` is the list the route needs non-empty ('hosts' for /docker/fleet, 'containers' for
 * /docker/containers).
 */
function shouldCacheDockerResult(result, key) {
  if (!result || result.success !== true) return false;
  if (result.refused || result.partial) return false;
  return Array.isArray(result[key]) && result[key].length > 0;
}

module.exports = { shouldCacheDockerResult };
