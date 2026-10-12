/**
 * QUOXCHAT-PRO — default builtin tools for widgets.
 *
 * Root cause of the "brushed off a visitor asking for a human" incident:
 * widgets created before this module shipped had ZERO widget_tools rows, so
 * human_handoff (and every other builtin) never reached the LLM as a
 * callable function. New widgets now ship with the builtin set below seeded
 * at creation time; existing tool-less widgets are backfilled by
 * scripts/backfill-widget-default-tools.js.
 *
 * Seed policy (owner-approved):
 *   enabled by default:  human_handoff, lead_capture, email_transcript,
 *                        leave_message
 *   seeded DISABLED:     book_appointment, schedule_demo (org opts in from
 *                        the dashboard Tools tab; the rows exist so opting
 *                        in is a one-click status flip, not a create form)
 *
 * Idempotent by construction: seeding skips any tool name that already
 * exists on the widget (UNIQUE(widget_id, name) is the backstop).
 */

import { prepare } from '../db/index.js';
import { ulid } from '../utils/helpers.js';

const EMAIL_FIELD = { type: 'string', description: "The visitor's email address so the team can follow up." };
const NAME_FIELD = { type: 'string', description: "The visitor's name." };
const PREFERRED_TIME_FIELD = { type: 'string', description: 'Preferred date/time in the visitor\'s own words, e.g. "Tuesday afternoon" or "10 March, 3pm".' };
const NOTES_FIELD = { type: 'string', description: 'Any extra context the visitor shared.' };

export const DEFAULT_WIDGET_TOOLS = [
  {
    name: 'human_handoff',
    builtin_kind: 'human_handoff',
    status: 'active',
    description: 'Hand this conversation over to a human operator. Use whenever the visitor asks to speak to a person, is frustrated, or has a request you cannot resolve.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for the handoff.' },
        priority: { type: 'string', enum: ['normal', 'high'], description: 'Escalation priority. Use high for urgent or upset visitors.' },
        summary: { type: 'string', description: 'One or two sentence handover summary for the human teammate: who the visitor is (their name if known) and what they need. It is shown to the visitor and the teammate.' },
      },
    },
  },
  {
    name: 'lead_capture',
    builtin_kind: 'lead_capture',
    status: 'active',
    description: "Save the visitor's contact details as a lead when they express interest in the product or ask to be contacted. Always confirm the email back to the visitor.",
    parameters: {
      type: 'object',
      properties: {
        name: NAME_FIELD,
        email: EMAIL_FIELD,
        phone: { type: 'string', description: 'Phone number, if offered.' },
        company: { type: 'string', description: 'Company name, if offered.' },
        notes: NOTES_FIELD,
        intent: { type: 'string', description: 'What the visitor wants: pricing, demo, support, partnership, other.' },
      },
      required: ['email'],
    },
  },
  {
    name: 'email_transcript',
    builtin_kind: 'email_transcript',
    status: 'active',
    // QUOXCHAT-EMAIL P1 — the optional `email` input lets "email my
    // transcript to X" work in one turn. The server captures it as a
    // chat-provided address and applies its own recipient-trust rules
    // (captcha for chat-provided recipients); the schema never promises
    // the send, only requests it. The old captcha_token param is gone:
    // captcha rides the message-level bot_protection token, not the tool.
    description: 'Email a transcript of this conversation to the visitor. If the visitor has already shared their email, call with no arguments. If they just told you which address to use, pass it in `email`. The server decides whether the address is allowed; relay its response honestly.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: "The visitor's own email address, exactly as they gave it in this conversation. Never invent or guess one." },
      },
    },
  },
  {
    name: 'leave_message',
    builtin_kind: 'leave_message',
    status: 'active',
    description: 'Take a message for the team when the visitor wants a human follow-up later (e.g. outside office hours). Collect their name, email and the message before calling this.',
    parameters: {
      type: 'object',
      properties: {
        name: NAME_FIELD,
        email: EMAIL_FIELD,
        message: { type: 'string', description: 'The message the visitor wants to leave for the team.' },
        notes: NOTES_FIELD,
      },
      required: ['email', 'message'],
    },
  },
  {
    name: 'book_appointment',
    builtin_kind: 'book_appointment',
    status: 'disabled',
    description: 'Request an appointment with the team on behalf of the visitor. Collect their name, email and preferred time before calling this.',
    parameters: {
      type: 'object',
      properties: {
        name: NAME_FIELD,
        email: EMAIL_FIELD,
        preferred_time: PREFERRED_TIME_FIELD,
        notes: NOTES_FIELD,
      },
      required: ['email'],
    },
  },
  {
    name: 'schedule_demo',
    builtin_kind: 'schedule_demo',
    status: 'disabled',
    description: 'Request a product demo on behalf of the visitor. Collect their name, email and preferred time before calling this.',
    parameters: {
      type: 'object',
      properties: {
        name: NAME_FIELD,
        email: EMAIL_FIELD,
        preferred_time: PREFERRED_TIME_FIELD,
        notes: NOTES_FIELD,
      },
      required: ['email'],
    },
  },
];

/**
 * Seed the default builtin tools onto one widget. Skips any tool whose name
 * already exists on the widget, so it is safe to call repeatedly and safe on
 * widgets that already have a partial/custom tool set.
 *
 * Returns { inserted: string[], skipped: string[] } (tool names).
 */
export function seedDefaultWidgetTools({ widgetId, orgId, dryRun = false }) {
  if (!widgetId || !orgId) throw new Error('seedDefaultWidgetTools requires widgetId and orgId');
  const inserted = [];
  const skipped = [];
  const existing = new Set(
    prepare('SELECT name FROM widget_tools WHERE widget_id = ?').all(widgetId).map((r) => r.name),
  );
  for (const t of DEFAULT_WIDGET_TOOLS) {
    if (existing.has(t.name)) { skipped.push(t.name); continue; }
    if (!dryRun) {
      prepare(`
        INSERT INTO widget_tools
          (id, widget_id, connector_id, org_id, name, description, tool_type, builtin_kind,
           parameters_json, config_json, status, rate_limit_per_session)
        VALUES (?, ?, NULL, ?, ?, ?, 'builtin', ?, ?, '{}', ?, NULL)
      `).run(
        ulid(), widgetId, orgId, t.name, t.description, t.builtin_kind,
        JSON.stringify(t.parameters), t.status,
      );
    }
    inserted.push(t.name);
  }
  return { inserted, skipped };
}

/**
 * Backfill: seed the default builtin set onto every existing widget that has
 * ZERO tools. Widgets with any tool row at all (custom or partial) are left
 * untouched — an admin who deliberately trimmed the set must not have it
 * reinstated behind their back.
 *
 * Returns { candidates, seeded, skippedWithTools, results }.
 */
export function backfillDefaultWidgetTools({ dryRun = false } = {}) {
  const widgets = prepare(`
    SELECT ww.id, ww.org_id, ww.name,
           (SELECT COUNT(*) FROM widget_tools t WHERE t.widget_id = ww.id) AS tool_count
    FROM website_widgets ww
    ORDER BY ww.created_at ASC
  `).all();

  const results = [];
  let seeded = 0;
  let skippedWithTools = 0;
  for (const w of widgets) {
    if (w.tool_count > 0) { skippedWithTools++; continue; }
    const r = seedDefaultWidgetTools({ widgetId: w.id, orgId: w.org_id, dryRun });
    seeded++;
    results.push({ widget_id: w.id, name: w.name, inserted: r.inserted });
  }
  return { candidates: widgets.length, seeded, skippedWithTools, results };
}

/**
 * Handover-summary schema backfill: existing widgets seeded human_handoff
 * before the `summary` parameter shipped have the OLD parameters JSON
 * frozen in their widget_tools row (seeding is a one-time INSERT, so the
 * canonical schema in DEFAULT_WIDGET_TOOLS drifts out of sync with what
 * the LLM actually sees for those widgets). This brings every existing
 * builtin human_handoff row up to the current canonical schema.
 *
 * Idempotent by construction: a row already matching the canonical JSON
 * (byte-for-byte) is skipped, so a second run changes nothing.
 *
 * Returns { scanned, updated, results } (tool ids updated).
 */
export function backfillHumanHandoffSummarySchema({ dryRun = false } = {}) {
  const canonical = DEFAULT_WIDGET_TOOLS.find((t) => t.builtin_kind === 'human_handoff');
  if (!canonical) throw new Error('human_handoff builtin missing from DEFAULT_WIDGET_TOOLS');
  const canonicalJson = JSON.stringify(canonical.parameters);

  const rows = prepare(`
    SELECT id, widget_id, parameters_json FROM widget_tools
    WHERE tool_type = 'builtin' AND builtin_kind = 'human_handoff'
  `).all();

  const results = [];
  let updated = 0;
  for (const r of rows) {
    if (r.parameters_json === canonicalJson) continue; // already current
    if (!dryRun) {
      prepare(`UPDATE widget_tools SET parameters_json = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(canonicalJson, r.id);
    }
    updated++;
    results.push({ tool_id: r.id, widget_id: r.widget_id });
  }
  return { scanned: rows.length, updated, results };
}

// ── QUOXCHAT-EMAIL D4 — tool_policies follow recorded intent ────────────────
//
// The seed above marks email_transcript ACTIVE (owner-approved "enabled by
// default"), but the collector's side-effect policy is default-deny: a tool
// not on embed_config_json.tool_policies.side_effect_allow_list is denied at
// execution regardless of its widget_tools status. Nothing ever seeded that
// allow-list, so the two-switch design guaranteed the marketed transcript
// action shipped dead on every widget. Creation now seeds BOTH switches, and
// the backfill below repairs widgets that never made a policy decision.
//
// Deliberately NOT seeded: allow_unverified_side_effects. Gate 2 is answered
// by the scoped self_guarded exemption in the collector (quoxchatToolPolicy),
// not by weakening the identity gate for every future custom tool.

export const DEFAULT_TOOL_POLICIES = Object.freeze({
  side_effect_allow_list: Object.freeze(['email_transcript']),
});

/**
 * Backfill: allow-list email_transcript on widgets where the tool is ACTIVE
 * but embed_config_json carries NO tool_policies key at all. A widget with
 * any tool_policies present (even {}) recorded an explicit policy decision
 * and is never touched. Idempotent: repaired widgets gain a tool_policies
 * key, so a second run finds nothing.
 *
 * Returns { candidates, updated, results }.
 */
export function backfillDefaultToolPolicies({ dryRun = false } = {}) {
  const rows = prepare(`
    SELECT ww.id, ww.embed_config_json
    FROM website_widgets ww
    WHERE EXISTS (
      SELECT 1 FROM widget_tools t
      WHERE t.widget_id = ww.id AND t.builtin_kind = 'email_transcript' AND t.status = 'active'
    )
  `).all();

  const results = [];
  let updated = 0;
  for (const r of rows) {
    let cfg = {};
    if (r.embed_config_json) {
      try { cfg = JSON.parse(r.embed_config_json); } catch { continue; } // corrupt config: repair nothing blind
      if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    }
    if ('tool_policies' in cfg) continue; // an explicit decision, keep it
    if (!dryRun) {
      const next = { ...cfg, tool_policies: { side_effect_allow_list: [...DEFAULT_TOOL_POLICIES.side_effect_allow_list] } };
      prepare(`UPDATE website_widgets SET embed_config_json = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(next), r.id);
    }
    updated++;
    results.push(r.id);
  }
  return { candidates: rows.length, updated, results };
}

/**
 * QUOXCHAT-EMAIL P1 — canonical-schema backfill for email_transcript, same
 * contract as backfillHumanHandoffSummarySchema above: existing widgets
 * froze the old parameters JSON (captcha_token) at seed time; this brings
 * every builtin email_transcript row up to the current canonical schema
 * (optional `email` input). Byte-identical rows are skipped.
 */
export function backfillEmailTranscriptSchema({ dryRun = false } = {}) {
  const canonical = DEFAULT_WIDGET_TOOLS.find((t) => t.builtin_kind === 'email_transcript');
  if (!canonical) throw new Error('email_transcript builtin missing from DEFAULT_WIDGET_TOOLS');
  const canonicalJson = JSON.stringify(canonical.parameters);
  const canonicalDescription = canonical.description;

  const rows = prepare(`
    SELECT id, widget_id, parameters_json, description FROM widget_tools
    WHERE tool_type = 'builtin' AND builtin_kind = 'email_transcript'
  `).all();

  const results = [];
  let updated = 0;
  for (const r of rows) {
    if (r.parameters_json === canonicalJson && r.description === canonicalDescription) continue;
    if (!dryRun) {
      prepare(`UPDATE widget_tools SET parameters_json = ?, description = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(canonicalJson, canonicalDescription, r.id);
    }
    updated++;
    results.push({ tool_id: r.id, widget_id: r.widget_id });
  }
  return { scanned: rows.length, updated, results };
}
