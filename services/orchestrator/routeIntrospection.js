// CLI-PARITY WP1.1 — runtime route-introspection helper (LOCAL COPY).
//
// Canonical source: services/shared/routeIntrospection.cjs. Duplicated here
// because (a) this service's Docker build context is
// ./services/orchestrator (see docker-compose.yml
// `orchestrator.build.context`) — COPY cannot reach outside that directory,
// so services/shared/* is unreachable from this image, and (b) the
// Dockerfile only does `COPY *.js ./` (flat, no subdirectories, and only
// .js — not .cjs — files), so this file uses a .js extension and lives at
// the service root rather than in a lib/ subdir. package.json has no
// "type": "module" here, so .js still loads as CommonJS. Keep in sync with
// the canonical copy if it changes.
//
// Walks an Express app's `_router.stack` to build a fully-resolved route
// table for the `/__routes` endpoint. Must be called INSIDE the request
// handler (not at module load) so it reflects routers/shims mounted
// dynamically after boot.
'use strict';

function regexpToPrefix(regexp, keys) {
  if (!regexp) return '';
  let src = regexp.source;
  if (keys && keys.length) {
    let i = 0;
    // Best-effort: substitute Express's param capture groups back to
    // ':paramName' using layer.keys (stable ordering per Express internals).
    src = src.replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, () => {
      const name = keys[i] && keys[i].name;
      i += 1;
      return name ? `/:${name}` : '';
    });
  }
  return src
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/');
}

function walk(stack, prefix, out, seen) {
  for (const layer of stack || []) {
    if (layer.route) {
      const routePath = prefix + (layer.route.path === '/' ? '' : layer.route.path);
      const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
      for (const method of methods) {
        const key = `${method.toUpperCase()} ${routePath || '/'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ method: method.toUpperCase(), path: routePath || '/', mount: prefix || '/' });
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix + regexpToPrefix(layer.regexp, layer.keys), out, seen);
    }
  }
}

// Fully-resolved, deduped route table for an Express app, gathered AFTER
// every router/dynamic mount is attached.
function listRoutes(app) {
  const out = [];
  walk(app && app._router && app._router.stack, '', out, new Set());
  out.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
  return out;
}

module.exports = { listRoutes };
