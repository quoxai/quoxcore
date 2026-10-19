'use strict';
// QUOXON-MODEL: the ONE Claude default model for the collector. It is whatever src/config/modelCatalog.js
// marks `default: true` under anthropic, so a catalog bump moves every no-model fallback with it.
// (The catalog is ESM and these call sites are synchronous CommonJS, so the entry is read from source once.)
const fs = require('fs');
const path = require('path');

const LAST_RESORT = 'claude-sonnet-5-5';
let cached = null;

function catalogDefaultModel() {
  if (cached) return cached;
  for (const rel of ['../../../src/config/modelCatalog.js', '../src/config/modelCatalog.js']) {
    try {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      const m = src.match(/\{\s*id:\s*'(claude-[a-z0-9.\-]+)'[^}]*?default:\s*true/);
      if (m) { cached = m[1]; return cached; }
    } catch { /* try the container layout */ }
  }
  cached = LAST_RESORT;
  return cached;
}

module.exports = { catalogDefaultModel };
