/**
 * QuoxAwareness v0 compatibility. The v0 routes stay (the voice receptionist
 * and older CLIs call them) but they now sit over LUCID:
 *   - a v0 upsert is ALSO appended to the journal as subject legacy:<key>
 *   - a v0 summary's `text` is the LUCID four-section situation
 * awareness_entries is kept as written so nothing that reads it breaks.
 */

const journal = require('./journal.js');

const LEGACY_LEDGER = { sessions: 'operational', build: 'operational', approvals: 'social', health: 'vital' };

function mirrorLegacy(rec = {}, row) {
  if (!row || !journal.isReady()) return null;
  try {
    return journal.append({
      org_id: row.org_id,
      ledger: LEGACY_LEDGER[row.key] || 'operational',
      subject: `legacy:${row.key}`,
      kind: 'state',
      state: { status: row.severity },
      summary: `${row.title || row.key}: ${row.state}`.slice(0, 500),
      ttl_s: rec.ttl_s,
      ts: row.updated_at,
      source: { surface: 'awareness-v0', feed: String(row.source || 'awareness-v0').slice(0, 80) },
    });
  } catch (err) {
    console.error('[LUCID] legacy mirror failed:', row.key, err && err.message);
    return null;
  }
}

/** v0 summary shape ({text, entries, counts}) with LUCID's situation as the text. */
function legacySummary(orgId, v0Summary, { viewer = 'owner', surface = 'phone' } = {}) {
  if (!journal.isReady()) return v0Summary;
  try {
    const { situationFor } = require('./routes.js');
    const { situation, spoken } = situationFor(orgId, { since: 'last', viewer, surface, advance: false });
    // The v0 reader is the phone receptionist: give it sentences, not a table.
    require('./witness.js').briefingIssued(orgId, { viewer, surface, kind: 'spoken' }, { situation, spoken });
    return { ...v0Summary, text: spoken, lucid: { cursor: situation.cursor, needs_you: situation.needs_you.length, coverage: situation.cannot_see.coverage } };
  } catch (err) {
    console.error('[LUCID] legacy summary failed, serving v0:', err && err.message);
    return v0Summary;
  }
}

module.exports = { mirrorLegacy, legacySummary };
