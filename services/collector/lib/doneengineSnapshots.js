'use strict';

/**
 * doneengineSnapshots.js — DONEENGINE phase 9, the collector half of the
 * dashboard panel.
 *
 * The panel MIRRORS the instrument, it does not re-measure: the engine
 * (~/quox-gauge/gauge.mjs) needs host git and docker to answer honestly,
 * and a collector container re-running it would measure the wrong world.
 * So this reads the engine's own snapshot files (written by
 * `gauge.mjs --snapshot`) off the host mount, newest per pack, and REPORTS
 * WHEN the measurement was taken. Absence of a snapshot is 404 with a
 * plain reason, never an empty shape a UI could mistake for "all clear" —
 * the same no-evidence-is-not-approval rule the engine itself enforces at
 * every seam.
 *
 * ORG SCOPING (DONEENGINE productise, 2026-08-21): QuoxPlan went per-org
 * (DEVSUITE phase 6) and this mirror follows, or a customer org's panel
 * renders quox's own readiness. Snapshots are stamped org_id by the engine;
 * an org caller sees only its own. Legacy unstamped files are the instance
 * owner's measurements and are served only to the owner org (resolved the
 * same way the QuoxPlan tools resolve it: auth's instance_config
 * quoxplan.owner_org_id, fail closed when unresolvable). Org-less users
 * are refused like the QuoxPlan proxy's org gate; service callers stay
 * unrestricted (loopback/CLI privilege, the posture the proxy expresses by
 * forwarding no org header for services).
 *
 * Routes (server.js, requireServiceOrUserAuth like the QuoxPlan proxy):
 *   GET /api/v1/doneengine/snapshots          list (pack, taken_at, file)
 *   GET /api/v1/doneengine/snapshots/latest   newest, ?pack= to filter
 */

const { hostPath } = require('../utils/runtimePaths.js');
const fs = require('fs');
const path = require('path');
const { resolveQuoxplanOwnerOrgId } = require('./quoxplanTools.js');

const DEFAULT_DIR = hostPath('quox-gauge', 'snapshots');
const STALE_AFTER_DAYS = 7;
const LIVE_COMMAND = 'quox done board';

/** Parse one snapshot file; null when unreadable (skipped, never fatal). */
function readSnapshot(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !data.taken_at || !data.pack) return null;
    return data;
  } catch {
    return null;
  }
}

/** May this caller see this snapshot? callerOrg undefined = unrestricted
 * (service). A stamped snapshot needs an exact org match; an unstamped one
 * is the instance owner's, and when the owner org cannot be resolved
 * (ownerOrg null/undefined) it is shown to NOBODY rather than guessed. */
function orgMayView(snap, callerOrg, ownerOrg) {
  if (callerOrg === undefined) return true;
  const snapOrg = snap.org_id || null;
  if (snapOrg) return snapOrg === callerOrg;
  return Boolean(ownerOrg) && callerOrg === ownerOrg;
}

/** All visible snapshots, newest first, as light rows (no subjects payload). */
function listSnapshots(dir = DEFAULT_DIR, { callerOrg, ownerOrg } = {}) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null; // directory unreadable: "cannot tell", distinct from empty
  }
  const rows = [];
  for (const f of files) {
    const snap = readSnapshot(path.join(dir, f));
    if (!snap) continue;
    if (!orgMayView(snap, callerOrg, ownerOrg)) continue;
    rows.push({
      file: f,
      pack: snap.pack,
      pack_version: snap.pack_version || null,
      org_id: snap.org_id || null,
      taken_at: snap.taken_at,
      build_ready: snap.build_ready,
      deployed_ready: snap.deployed_ready,
      total: snap.total,
    });
  }
  rows.sort((a, b) => String(b.taken_at).localeCompare(String(a.taken_at)));
  return rows;
}

/** The newest visible full snapshot, optionally per pack, with its age. */
function latestSnapshot(dir = DEFAULT_DIR, { pack, now = Date.now(), callerOrg, ownerOrg } = {}) {
  const rows = listSnapshots(dir, { callerOrg, ownerOrg });
  if (rows === null) return { error: 'unreadable' };
  const match = pack ? rows.find((r) => r.pack === pack) : rows[0];
  if (!match) return { error: 'none' };
  const full = readSnapshot(path.join(dir, match.file));
  if (!full) return { error: 'none' };
  const takenMs = Date.parse(full.taken_at);
  return {
    snapshot: full,
    file: match.file,
    age_ms: Number.isFinite(takenMs) ? Math.max(0, now - takenMs) : null,
  };
}

/** Resolve the caller's scope, or answer the request outright (403).
 * Returns null after responding, else { callerOrg, ownerOrg }. */
async function resolveScope(req, res, resolveOwnerOrgId) {
  if (req.service) return { callerOrg: undefined, ownerOrg: undefined };
  if (!(req.user && req.user.org_id)) {
    res.status(403).json({
      error: 'doneengine_org_gate',
      message: 'DoneEngine needs an organisation-scoped session; log in to an organisation first.',
    });
    return null;
  }
  // undefined (auth unreachable) and null (unconfigured) both leave legacy
  // unstamped snapshots hidden — fail closed, org-stamped ones still serve.
  const ownerOrg = (await resolveOwnerOrgId()) || null;
  return { callerOrg: req.user.org_id, ownerOrg };
}

function createSnapshotsListHandler({ dir = DEFAULT_DIR, resolveOwnerOrgId = resolveQuoxplanOwnerOrgId } = {}) {
  return async function snapshotsListHandler(req, res) {
    const scope = await resolveScope(req, res, resolveOwnerOrgId);
    if (!scope) return undefined;
    const rows = listSnapshots(dir, scope);
    if (rows === null) {
      return res.status(503).json({ error: 'snapshots_unreadable', message: `DoneEngine snapshot directory is not readable at ${dir}. The engine lives on the control box; this panel mirrors its measurements.` });
    }
    return res.json({ snapshots: rows });
  };
}

function createSnapshotsLatestHandler({ dir = DEFAULT_DIR, resolveOwnerOrgId = resolveQuoxplanOwnerOrgId } = {}) {
  return async function snapshotsLatestHandler(req, res) {
    const scope = await resolveScope(req, res, resolveOwnerOrgId);
    if (!scope) return undefined;
    const r = latestSnapshot(dir, { pack: req.query.pack || undefined, ...scope });
    if (r.error === 'unreadable') {
      return res.status(503).json({ error: 'snapshots_unreadable', message: `DoneEngine snapshot directory is not readable at ${dir}.` });
    }
    if (r.error === 'none') {
      // No measurement is NOT a clean bill: say so, loudly, as data.
      const forOrg = scope.callerOrg ? ' is visible to your organisation' : ' has been taken';
      const pack = req.query.pack || '<pack>';
      return res.status(404).json({ error: 'no_snapshot', message: `No DoneEngine measurement${forOrg}. Take one with \`quox done bar ${pack} --snapshot\` on a machine with the repo checked out, or read the live board with \`quox done board\`. Absence of a snapshot is absence of evidence, not readiness.`, refresh_command: `quox done bar ${pack} --snapshot`, live_command: LIVE_COMMAND });
    }
    // Snapshots go stale: report the age plainly so nobody presents an old reading as the current state (quox#885).
    const ageDays = Number.isFinite(r.age_ms) ? Math.floor(r.age_ms / 86400000) : null;
    const pack = (r.snapshot && r.snapshot.pack) || req.query.pack || '<pack>';
    return res.json({
      snapshot: r.snapshot, file: r.file, age_ms: r.age_ms,
      age_days: ageDays,
      stale: ageDays === null ? true : ageDays > STALE_AFTER_DAYS,
      refresh_command: `quox done bar ${pack} --snapshot`,
      live_command: LIVE_COMMAND,
    });
  };
}

// ---- Estate board mirror (quox#885 part 2) ----------------------------------
// The board (every surface's score, gates, deploy state) is measured on the host
// by a control timer (scripts/doneengine/quox-board-snapshot.mjs) that writes
// <dir>/board/board-latest.json as { taken_at, source, org_id?, board }. This
// mirrors it, with the same org rule as pack snapshots.
const BOARD_STALE_AFTER_DAYS = 1;
const BOARD_REFRESH_COMMAND = 'quox done board';

function latestBoard(dir = DEFAULT_DIR, { now = Date.now(), callerOrg, ownerOrg } = {}) {
  const file = path.join(dir, 'board', 'board-latest.json');
  let data;
  try {
    if (!fs.existsSync(file)) return { error: 'none' };
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { error: 'unreadable' };
  }
  if (!data || !data.taken_at || !data.board || !Array.isArray(data.board.surfaces)) return { error: 'unreadable' };
  if (!orgMayView(data, callerOrg, ownerOrg)) return { error: 'none' };
  const takenMs = Date.parse(data.taken_at);
  return { board: data.board, taken_at: data.taken_at, source: data.source || null, age_ms: Number.isFinite(takenMs) ? Math.max(0, now - takenMs) : null };
}

function createBoardHandler({ dir = DEFAULT_DIR, resolveOwnerOrgId = resolveQuoxplanOwnerOrgId } = {}) {
  return async function boardHandler(req, res) {
    const scope = await resolveScope(req, res, resolveOwnerOrgId);
    if (!scope) return undefined;
    const r = latestBoard(dir, scope);
    if (r.error === 'unreadable') {
      return res.status(503).json({ error: 'board_unreadable', message: 'The DoneEngine board snapshot exists but could not be read.' });
    }
    if (r.error === 'none') {
      return res.status(404).json({ error: 'no_board', message: 'No DoneEngine board reading is visible to your organisation. Run `quox done board` on a machine with the repo checked out for a live reading. Absence of a reading is absence of evidence, not readiness.', refresh_command: BOARD_REFRESH_COMMAND });
    }
    const ageDays = Number.isFinite(r.age_ms) ? Math.floor(r.age_ms / 86400000) : null;
    const out = {
      taken_at: r.taken_at, source: r.source, age_ms: r.age_ms, age_days: ageDays,
      stale: ageDays === null ? true : ageDays >= BOARD_STALE_AFTER_DAYS,
      refresh_command: BOARD_REFRESH_COMMAND,
      surface_count: r.board.surfaces.length,
    };
    const want = req.query.surface ? String(req.query.surface).toLowerCase() : null;
    if (want) {
      out.surface = r.board.surfaces.find((s) => String(s.surface).toLowerCase() === want) || null;
      if (!out.surface) out.known_surfaces = r.board.surfaces.map((s) => s.surface);
    } else {
      out.board = r.board;
    }
    return res.json(out);
  };
}

module.exports = {
  DEFAULT_DIR,
  listSnapshots,
  latestSnapshot,
  createSnapshotsListHandler,
  createSnapshotsLatestHandler,
  latestBoard,
  createBoardHandler,
};
