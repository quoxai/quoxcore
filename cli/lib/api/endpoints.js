/**
 * QuoxCLI endpoint map — thin re-export shim.
 *
 * The endpoint map was split into per-domain fragment files under
 * ./endpoints/ (see ./endpoints/index.js for the aggregation + fragment
 * convention doc). This file is kept as a stable import path so the ~50
 * existing call sites across lib/commands, lib/tui/views, lib/tui/hooks,
 * and lib/core don't need to change: `import { ... } from '../../api/endpoints.js'`
 * keeps working unchanged.
 *
 * Do not add new endpoints here — add them to the appropriate fragment
 * file under ./endpoints/ (or create a new one) instead.
 */

export { ENDPOINTS, resolveEndpoint } from './endpoints/index.js';
