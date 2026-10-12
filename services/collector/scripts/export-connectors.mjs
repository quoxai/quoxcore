#!/usr/bin/env node
/**
 * scripts/export-connectors.mjs, CONNFAC (stream 6.5).
 *
 * Generates lib/connectors/connectors.export.json from CONNECTOR_REGISTRY:
 * the machine-readable list of EXECUTABLE connectors (id, name, category,
 * kind, tool count, proof class) that downstream repos consume, the same
 * pattern as services/auth's integration-types.export.json. The website's
 * connectorsManifest and its facts pipeline read this file, so the public
 * connector count and logo wall derive from the registry instead of being
 * hand-typed (derived-honest rule).
 *
 * VERIFY_ONLY excludes connectors with no getTools surface an agent can
 * run. Empty since 2026-09-12 (twitter graduated); kept as the mechanism.
 *
 * Usage:
 *   node scripts/export-connectors.mjs            # write
 *   node scripts/export-connectors.mjs --check    # exit 1 if stale
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const outPath = path.join(root, 'lib', 'connectors', 'connectors.export.json')

const { CONNECTOR_REGISTRY } = require(path.join(root, 'lib', 'connectors', 'registry.js'))
const { buildConnector } = require(path.join(root, 'lib', 'connectors', 'declarativeRuntime.js'))
const { deriveDepth, PLATFORM_GAPS } = require(path.join(root, 'lib', 'connectors', 'depth.js'))

// twitter graduated out of verify-only on 2026-09-12: X-PLUGIN shipped it 5
// real read tools (verify_credentials, get_tweet, get_user_tweets,
// search_recent, get_mentions), so excluding it undercounted honestly.
const VERIFY_ONLY = new Set()

function proofClass(id) {
  const p = path.join(root, 'lib', 'connectors', 'specs', 'proofs', `${id}.proof.json`)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')).overall || null } catch { return null }
}

function toolFacts(entry) {
  try {
    let tools
    if (entry.kind === 'declarative') {
      const spec = entry.spec || JSON.parse(readFileSync(path.join(root, 'lib', 'connectors', entry.specFile), 'utf8'))
      tools = buildConnector(spec).getTools(dummyCreds(entry))
    } else {
      const mod = require(path.join(root, 'lib', 'connectors', entry.module))
      tools = mod.getTools(dummyCreds(entry))
    }
    const prefix = `${entry.id}_`
    const short = (n) => (n.startsWith(prefix) ? n.slice(prefix.length) : n)
    return {
      count: tools.length,
      // Display names, connector prefix stripped; capped so the export stays lean.
      names: tools.slice(0, 8).map(t => short(t.name)),
      // Full detail for the per-connector pages: every tool, with its own
      // description and (where the runtime sets one) its write flag.
      detail: tools.map(t => ({
        name: short(t.name),
        description: t.description || null,
        ...(typeof t.write === 'boolean' ? { write: t.write } : {}),
      })),
      // Claim read-only ONLY when every tool carries an explicit write flag
      // saying so. Module connectors predate the flag; a missing flag is
      // unknown (null), not a read-only claim — notion ships create_page.
      readOnly: tools.length > 0 && tools.every(t => typeof t.write === 'boolean')
        ? tools.every(t => t.write === false)
        : null,
      // P7.3 depth rungs, derived from the same built tools (metadata only).
      depth: deriveDepth(entry, { tools }),
    }
  } catch { return { count: null, names: [], readOnly: null, depth: null } }
}

function dummyCreds(entry) {
  const c = {}
  for (const f of entry.requiredFields || []) {
    c[f] = f === 'service_account_json'
      ? '{"client_email":"x@x","private_key":"x","token_uri":"https://oauth2.googleapis.com/token"}'
      : 'EXPORT_DUMMY'
  }
  return c
}

const connectors = Object.values(CONNECTOR_REGISTRY)
  .filter(e => !VERIFY_ONLY.has(e.id))
  .map(e => {
    const facts = toolFacts(e)
    return {
      id: e.id,
      name: e.name,
      category: e.category || 'uncategorized',
      kind: e.kind || 'module',
      tools: facts.count,
      proof: e.kind === 'declarative' ? proofClass(e.id) : 'live-module',
      // Hover-card / docs fields, all derived from the registry entry:
      description: e.description || null,
      docs: e.docs || null,
      required: e.requiredFields || [],
      tool_names: facts.names,
      tools_detail: facts.detail,
      read_only: facts.readOnly,
      auth_kind: e.kind === 'declarative' ? (e.spec?.auth?.type || null) : null,
      depth: facts.depth,
    }
  })
  .sort((a, b) => a.id.localeCompare(b.id))

const byProof = (p) => connectors.filter(c => c.proof === p).length
const payload = {
  generated_by: 'services/collector/scripts/export-connectors.mjs',
  source: 'services/collector/lib/connectors/registry.js',
  count: connectors.length,
  // P7.2/P7.3 — the honest capability axis: LIVE_PROVEN (driven with a real
  // credential) is the headline number; spec count is breadth, not capability.
  depth_summary: {
    live_proven: byProof('LIVE_PROVEN'),
    live_module: byProof('live-module'),
    shape_proven: byProof('SHAPE_PROVEN'),
    auth_wall: byProof('AUTH_WALL'),
    platform_gaps: PLATFORM_GAPS,
  },
  connectors,
}

const next = JSON.stringify(payload, null, 2) + '\n'
if (process.argv.includes('--check')) {
  const prev = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
  if (prev !== next) {
    console.error(`[export-connectors] STALE: ${outPath} does not match the registry (count ${connectors.length}). Run: node scripts/export-connectors.mjs`)
    process.exit(1)
  }
  console.log(`[export-connectors] fresh (${connectors.length} connectors)`)
} else {
  writeFileSync(outPath, next)
  console.log(`[export-connectors] wrote ${outPath} (${connectors.length} connectors)`)
}
