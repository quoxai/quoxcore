'use strict';

/**
 * calendarqTools.js — the agent tool surface for Calendar-Q (L2-C1 U4).
 * Same pattern as lib/inboxqTools.js: every tool calls into the Calendar-Q
 * store / agenda module IN-PROCESS (same collector process, same org
 * resolution), never a new HTTP round-trip.
 *
 * READ-ONLY for this phase — there is no write/propose tool here yet (no
 * create_event, no propose path exists in Calendar-Q below the API layer
 * at all). AEE audit emits quox.calendar.read for every tool call here;
 * quox.calendar.sync is emitted by the API layer's manual /sync trigger
 * (lib/calendarq/api.js's hSync), not by an agent tool — there is
 * deliberately no calendar_sync tool in this phase.
 *
 * AEE audit: same injected-callback shape as inboxqTools.js's
 * setInboxqToolsAuditFn, since this module has no direct handle on the
 * collector's storeAuditEnvelope closure. Defaults to a no-op so the module
 * works unwired in tests.
 */

const store = require('./calendarq/store.js');
// ContactsQ P3b: additive, fail-soft attendee cards (never throws).
const contactIdentity = require('./contactsq/identityShim.js');
const { getAgenda, getChanges } = require('./calendarq/agenda.js');
const { getOverlay, buildWindowCoverageStatement, listSchedulesSummary } = require('./calendarq/layers.js');
const { detectClashes } = require('./calendarq/clash.js');
const { computeWindow, todayInTz } = require('./calendarq/syncWorker.js');
const { createProposal, describeNotify, describeConflicts } = require('./calendarq/proposals.js');
const { executeCreateEvent } = require('./calendarq/execute.js');
const { reconcileOperation } = require('./calendarq/reconcile.js');
const { withApprovalGate } = require('./approvalGate.js');
const { getPrep } = require('./calendarq/prep.js');
const { buildBriefInput } = require('./calendarq/brief.js');
const { proposeFollowUp } = require('./calendarq/actionIntake.js');

let _storeAuditEnvelope = () => {};
/** Wire in the server's storeAuditEnvelope function. Call once at startup. */
function setCalendarqToolsAuditFn(fn) {
  if (typeof fn === 'function') _storeAuditEnvelope = fn;
}

function auditDep(ctx) {
  return (e) => _storeAuditEnvelope({ from: `agent.${ctx.agentId || 'calendarq'}`, to: 'audit.system', ...e });
}

/** Every tool below refuses without an org — a Calendar-Q tool must never
 * fall back to a default org (multi-tenant, fail closed). */
function requireOrg(ctx) {
  if (!ctx || !ctx.orgId) throw new Error('org_context_required: Calendar-Q tools need an authenticated org context.');
  return ctx.orgId;
}

function stripHash(payload) {
  if (!payload) return payload;
  const { _hash, ...rest } = payload;
  return rest;
}

/** Resolve the {timezone, windowStartLocalDate, windowEndLocalDateExclusive}
 * a tool call wants, defaulting to the sync worker's own 7-back/30-fwd
 * window when the caller does not name one explicitly. */
function resolveWindow(input) {
  const timezone = (input && input.timezone) || 'UTC';
  if (input && input.windowStartLocalDate && input.windowEndLocalDateExclusive) {
    return { timezone, windowStartLocalDate: input.windowStartLocalDate, windowEndLocalDateExclusive: input.windowEndLocalDateExclusive };
  }
  const fallback = computeWindow(Date.now(), timezone);
  return { timezone, windowStartLocalDate: fallback.windowStart, windowEndLocalDateExclusive: fallback.windowEndExclusive };
}

// Every workflow cron projects up to 200 firings, so an org with a few schedules
// produced a 600KB overlay that the model could only read by shelling out
// (routing gripe 2026-10-15). Human commitments (provider + internal events) are
// kept first; machine firings fill what is left of the cap. Counts stay honest.
const OVERLAY_MAX_OCCURRENCES = 100;
const HUMAN_LAYER_KINDS = new Set(['provider', 'internal_events']);

function capOverlayOccurrences({ layers, occurrences }) {
  const kindOf = new Map(layers.map((l) => [l.layerId, l.kind]));
  const occurrenceCountsByLayer = {};
  for (const o of occurrences) occurrenceCountsByLayer[o.layerId] = (occurrenceCountsByLayer[o.layerId] || 0) + 1;
  const human = occurrences.filter((o) => HUMAN_LAYER_KINDS.has(kindOf.get(o.layerId)));
  const machine = occurrences.filter((o) => !HUMAN_LAYER_KINDS.has(kindOf.get(o.layerId)));
  const kept = human.slice(0, OVERLAY_MAX_OCCURRENCES);
  kept.push(...machine.slice(0, Math.max(0, OVERLAY_MAX_OCCURRENCES - kept.length)));
  kept.sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
  const truncated = kept.length < occurrences.length;
  return {
    occurrences: kept,
    occurrenceCount: occurrences.length,
    occurrenceCountsByLayer,
    truncated,
    ...(truncated ? { truncationNote: `Showing ${kept.length} of ${occurrences.length} occurrences: all human events first, then the earliest machine firings. occurrenceCountsByLayer has the full per-layer totals; narrow the window or use calendar_schedules_overview for schedules.` } : {}),
  };
}

const CALENDARQ_TOOLS = {

  calendar_layers_list: {
    name: 'calendar_layers_list',
    description: "List the org's Calendar-Q layers (each connected provider calendar is one layer, plus any other registered layer kind). Read-only, free. Use this to find a connectionId/layerId before calling calendar_agenda.",
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => {
      try {
        const orgId = requireOrg(ctx);
        const layers = store.listLayers(orgId);
        auditDep(ctx)({ type: 'action', intent: 'quox.calendar.read', corr: orgId, payload: { tool: 'calendar_layers_list', count: layers.length } });
        return { success: true, layers };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  calendar_agenda: {
    name: 'calendar_agenda',
    description: "Read one connection's agenda: the latest synced, non-cancelled occurrences, plus an honest coverage state (complete/stale/partial/disconnected/empty/unavailable). A failed refresh never produces an empty agenda — the previous published generation keeps serving, labelled 'stale'. Always quote the coverage.state back, never claim 'you have nothing on' when the state is anything other than complete or empty. Read-only, free.",
    input_schema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'The Calendar-Q connection id (from calendar_layers_list or `quox calendar status`). Optional when the org has exactly one connection; omit it rather than guessing.' },
        layerIds: { type: 'array', items: { type: 'string' }, description: 'Optional: restrict the returned occurrences to these layer ids.' },
      },
    },
    execute: async (input, ctx) => {
      let { connectionId } = input || {};
      const { layerIds } = input || {};
      try {
        const orgId = requireOrg(ctx);
        // quox#830: resolve the connection gracefully instead of erroring raw.
        // No connections at all -> a grounded empty answer, never a failed tool.
        const connections = store.listConnections(orgId);
        if (connections.length === 0) {
          auditDep(ctx)({
            type: 'action', intent: 'quox.calendar.read', corr: 'none',
            payload: { tool: 'calendar_agenda', state: 'unavailable', count: 0 },
          });
          return {
            success: true, connected: false,
            coverage: { state: 'unavailable', reason: 'no_provider_connected' },
            occurrences: [],
            guidance: 'No provider calendar is connected to this org yet, so there is no agenda to read. Internal Quox layers are readable via calendar_overlay or calendar_layers_list. A provider is connected from the dashboard: Office > Calendar-Q > Connections.',
          };
        }
        if (!connectionId) {
          if (connections.length > 1) {
            return { success: false, error: `multiple connections exist; pass connectionId (one of: ${connections.map((c) => c.id).join(', ')})` };
          }
          connectionId = connections[0].id;
        }
        const agenda = getAgenda(orgId, { connectionId, layerIds: Array.isArray(layerIds) ? layerIds : null });
        auditDep(ctx)({
          type: 'action', intent: 'quox.calendar.read', corr: connectionId,
          payload: { tool: 'calendar_agenda', state: agenda.coverage.state, count: agenda.occurrences.length },
        });
        return { success: true, coverage: agenda.coverage, occurrences: contactIdentity.enrichOccurrences(orgId, agenda.occurrences) };
      } catch (e) {
        if (e.message === 'calendarq_connection_not_found') return { success: false, error: 'connection not found' };
        return { success: false, error: e.message };
      }
    },
  },

  calendar_coverage_status: {
    name: 'calendar_coverage_status',
    description: "Just the coverage/freshness state for a connection (no occurrences) — a quick \"is my calendar data up to date\" check. Read-only, free.",
    input_schema: {
      type: 'object',
      properties: { connectionId: { type: 'string', description: 'The Calendar-Q connection id.' } },
      required: ['connectionId'],
    },
    execute: async (input, ctx) => {
      const { connectionId } = input || {};
      if (!connectionId) return { success: false, error: 'connectionId is required' };
      try {
        const orgId = requireOrg(ctx);
        const agenda = getAgenda(orgId, { connectionId });
        auditDep(ctx)({ type: 'action', intent: 'quox.calendar.read', corr: connectionId, payload: { tool: 'calendar_coverage_status', state: agenda.coverage.state } });
        return { success: true, coverage: agenda.coverage };
      } catch (e) {
        if (e.message === 'calendarq_connection_not_found') return { success: false, error: 'connection not found' };
        return { success: false, error: e.message };
      }
    },
  },

  calendar_event_get: {
    name: 'calendar_event_get',
    description: "Full detail for one occurrence, by occurrenceKey, from the latest published generation of a connection. Read-only, free.",
    input_schema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        occurrenceKey: { type: 'string', description: 'From a prior calendar_agenda or calendar_changes call.' },
      },
      required: ['connectionId', 'occurrenceKey'],
    },
    execute: async (input, ctx) => {
      const { connectionId, occurrenceKey } = input || {};
      if (!connectionId) return { success: false, error: 'connectionId is required' };
      if (!occurrenceKey) return { success: false, error: 'occurrenceKey is required' };
      try {
        const orgId = requireOrg(ctx);
        const published = store.readPublishedOccurrences(orgId, connectionId);
        if (!published) return { success: false, error: 'no published generation for this connection yet' };
        const row = published.occurrences.find((o) => o.occurrenceKey === occurrenceKey);
        if (!row) return { success: false, error: 'occurrence not found in the latest published generation' };
        auditDep(ctx)({ type: 'action', intent: 'quox.calendar.read', corr: occurrenceKey, payload: { tool: 'calendar_event_get', connectionId } });
        return { success: true, occurrence: contactIdentity.enrichOccurrence(orgId, stripHash(row.payload)) };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  calendar_changes: {
    name: 'calendar_changes',
    description: "Evidenced diff since a previously-read generation id (from a prior calendar_agenda/calendar_coverage_status call's coverage.generationId): added / time_changed / status_changed / removed. An occurrence absent from the newer generation is reported as removed with reason 'no_longer_visible', never assumed cancelled. Read-only, free.",
    input_schema: {
      type: 'object',
      properties: { sinceGenerationId: { type: 'string' } },
      required: ['sinceGenerationId'],
    },
    execute: async (input, ctx) => {
      const { sinceGenerationId } = input || {};
      if (!sinceGenerationId) return { success: false, error: 'sinceGenerationId is required' };
      try {
        const orgId = requireOrg(ctx);
        const result = getChanges(orgId, { sinceGenerationId });
        auditDep(ctx)({ type: 'action', intent: 'quox.calendar.read', corr: sinceGenerationId, payload: { tool: 'calendar_changes', count: result.changes.length } });
        return { success: true, ...result };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  calendar_overlay: {
    name: 'calendar_overlay',
    description: "The merged, layer-tagged occurrence feed across every connected calendar layer (provider calendars, your own internal events, team schedules, workflow cron triggers), with a per-layer coverage state. Returns at most 100 occurrences (human events first, then machine firings) plus occurrenceCount, occurrenceCountsByLayer and truncated: report the totals honestly when truncated. Quote each layer's coverage.state back rather than assuming every layer is fresh. Read-only, free.",
    input_schema: {
      type: 'object',
      properties: {
        windowStartLocalDate: { type: 'string', description: "Optional 'YYYY-MM-DD'. Defaults to 7 days back." },
        windowEndLocalDateExclusive: { type: 'string', description: "Optional 'YYYY-MM-DD', exclusive. Defaults to 30 days forward." },
        timezone: { type: 'string', description: "IANA timezone for the window. Defaults to 'UTC'." },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      try {
        const orgId = requireOrg(ctx);
        const { timezone, windowStartLocalDate, windowEndLocalDateExclusive } = resolveWindow(input);
        const overlay = await getOverlay(orgId, { userId: ctx.userId || null, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl: ctx.fetchImpl });
        auditDep(ctx)({ type: 'action', intent: 'quox.calendar.read', corr: orgId, payload: { tool: 'calendar_overlay', layerCount: overlay.layers.length, occurrenceCount: overlay.occurrences.length } });
        const capped = capOverlayOccurrences(overlay);
        return { success: true, ...overlay, ...capped, occurrences: contactIdentity.enrichOccurrences(orgId, capped.occurrences) };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  calendar_clashes: {
    name: 'calendar_clashes',
    description: "Detected human_double_book clashes across every connected layer (overlapping, non-cancelled, non-transparent human commitments). A cron firing during a meeting is NEVER reported as a clash in this version. Every clash cites the windowCoverageStatement describing what was actually checked — quote it back rather than claiming a clean calendar beyond what it covers. Read-only, free.",
    input_schema: {
      type: 'object',
      properties: {
        windowStartLocalDate: { type: 'string', description: "Optional 'YYYY-MM-DD'. Defaults to 7 days back." },
        windowEndLocalDateExclusive: { type: 'string', description: "Optional 'YYYY-MM-DD', exclusive. Defaults to 30 days forward." },
        timezone: { type: 'string', description: "IANA timezone for the window. Defaults to 'UTC'." },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      try {
        const orgId = requireOrg(ctx);
        const { timezone, windowStartLocalDate, windowEndLocalDateExclusive } = resolveWindow(input);
        const overlay = await getOverlay(orgId, { userId: ctx.userId || null, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl: ctx.fetchImpl });
        const windowCoverageStatement = buildWindowCoverageStatement(overlay.layers);
        const clashes = detectClashes(orgId, { occurrences: overlay.occurrences, layers: overlay.layers, windowCoverageStatement });
        auditDep(ctx)({ type: 'action', intent: 'quox.calendar.read', corr: orgId, payload: { tool: 'calendar_clashes', count: clashes.length } });
        return { success: true, clashes, windowCoverageStatement };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  calendar_schedules_overview: {
    name: 'calendar_schedules_overview',
    description: "Summarises the org's machine schedules (team_schedules + workflow_cron): counts, active/paused flags, and the next 5 upcoming projections per kind. Use this before calendar_overlay when the question is just \"what automated things are scheduled\", not the full merged calendar. Read-only, free.",
    input_schema: {
      type: 'object',
      properties: {
        windowStartLocalDate: { type: 'string', description: "Optional 'YYYY-MM-DD'. Defaults to 7 days back." },
        windowEndLocalDateExclusive: { type: 'string', description: "Optional 'YYYY-MM-DD', exclusive. Defaults to 30 days forward." },
        timezone: { type: 'string', description: "IANA timezone for the window. Defaults to 'UTC'." },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      try {
        const orgId = requireOrg(ctx);
        const { timezone, windowStartLocalDate, windowEndLocalDateExclusive } = resolveWindow(input);
        const summary = await listSchedulesSummary(orgId, { timezone, windowStartLocalDate, windowEndLocalDateExclusive, fetchImpl: ctx.fetchImpl });
        auditDep(ctx)({ type: 'action', intent: 'quox.calendar.read', corr: orgId, payload: { tool: 'calendar_schedules_overview' } });
        return { success: true, ...summary };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  // --- L2-C2: approved single non-recurring event creation ------------------
  //
  // calendar_event_propose has NO external effect — it is pre-granted at the
  // same read tier as the tools above. calendar_event_create is the ONLY
  // tool in Calendar-Q with an external effect, and it is unconditionally
  // agent-gated (see approvalGate.js's AGENT_ALWAYS_PROPOSE_TOOLS): no org
  // policy configuration can let it execute without a human approval.

  calendar_event_propose: {
    name: 'calendar_event_propose',
    description: "Propose creating a SINGLE, non-recurring calendar event. This has NO external effect — nothing is sent to the provider and no human approval is needed to call this tool. It validates the request, discloses any conflicts against the latest synced calendar data, and returns a proposalId. Pass that proposalId to calendar_event_create to actually create it (which DOES require human approval). Recurring events are rejected outright in this phase.",
    input_schema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'The Calendar-Q connection id to create the event in.' },
        resourceId: { type: 'string', description: "Must match the connection's own resourceId if given; omit to default to it." },
        title: { type: 'string' },
        startTs: { type: 'number', description: 'Epoch ms. Omit for an allDay event.' },
        endTs: { type: 'number', description: 'Epoch ms, must be after startTs. Omit for an allDay event.' },
        allDay: { type: 'boolean' },
        dateOnly: { type: 'string', description: "'YYYY-MM-DD', required when allDay is true." },
        timezone: { type: 'string', description: 'IANA timezone, required.' },
        attendees: { type: 'array', items: { type: 'object', properties: { email: { type: 'string' } } } },
        notifyPolicy: { type: 'string', enum: ['none', 'attendees'], description: "Who gets notified. Defaults to 'none'." },
        visibility: { type: 'string', enum: ['default', 'private', 'busy-only'] },
        description: { type: 'string' },
      },
      required: ['connectionId', 'title', 'timezone'],
    },
    execute: async (input, ctx) => {
      try {
        const orgId = requireOrg(ctx);
        const result = createProposal(orgId, input || {}, { nowMs: Date.now() });
        if (!result.ok) return { success: false, error: result.errors.join('; ') };
        auditDep(ctx)({ type: 'action', intent: 'quox.calendar.propose', corr: result.proposal.opId, payload: { tool: 'calendar_event_propose', proposalId: result.proposal.proposalId, connectionId: result.proposal.connectionId } });
        return {
          success: true,
          proposal: result.proposal,
          summary: `Proposed "${result.proposal.title}" on connection ${result.proposal.connectionId}. ${describeNotify(result.proposal)} ${describeConflicts(result.overlaps)} Nothing has been created yet — call calendar_event_create with proposalId "${result.proposal.proposalId}" to request it, which will require human approval.`,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  calendar_event_create: {
    name: 'calendar_event_create',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // Approval gate runs INSIDE execute — same shape as bob_dispatch_build:
    // withApprovalGate wraps the whole thing, including the revalidation.
    gatedInExecute: true,
    description: "Create the event from a prior calendar_event_propose proposalId. ALWAYS goes through the approval gate: you propose, a human resolves it. Before executing, this revalidates the proposal against live state (connection health, credential, a FRESH conflict check, and that the effect has not changed since the approval was sought) — any of those failing refuses the create rather than silently proceeding. Report calendar_event_create's result honestly: 'confirmed' means the provider returned matching evidence; 'outcome_unknown' means the request was dispatched but the response was lost, and calendar_reconcile must be used before trying again (never retry directly).",
    input_schema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string', description: 'From a prior calendar_event_propose call.' },
      },
      required: ['proposalId'],
    },
    execute: async (input, ctx) => {
      const { proposalId } = input || {};
      if (!proposalId) return { success: false, error: 'proposalId is required' };
      return withApprovalGate('calendar_event_create', input, async () => {
        try {
          const orgId = requireOrg(ctx);
          return await executeCreateEvent(orgId, { proposalId }, { fetchImpl: ctx.fetchImpl, audit: auditDep(ctx), agentId: ctx.agentId || null });
        } catch (e) {
          return { success: false, error: e.message };
        }
      }, ctx || {});
    },
  },

  calendar_reconcile: {
    name: 'calendar_reconcile',
    description: "Resolve an 'attempted' or 'outcome_unknown' calendar_event_create call against provider-side evidence. NEVER creates, updates, or deletes anything — it only reads. Use this before retrying a create whose outcome was unknown; a fresh attempt always needs a NEW calendar_event_propose + a new human approval, this tool never reissues the old one. Read-only, free.",
    input_schema: {
      type: 'object',
      properties: { opId: { type: 'string', description: 'The opId from a pending/outcome_unknown calendar_event_create response.' } },
      required: ['opId'],
    },
    execute: async (input, ctx) => {
      const { opId } = input || {};
      if (!opId) return { success: false, error: 'opId is required' };
      try {
        const orgId = requireOrg(ctx);
        return await reconcileOperation(orgId, opId, { fetchImpl: ctx.fetchImpl, audit: auditDep(ctx), agentId: ctx.agentId || null });
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  // --- L2-C3: meeting prep, the morning-brief data contract, and ----------
  // Action-Q follow-up intake. Zero LLM calls in all three — see
  // lib/calendarq/prep.js, brief.js, actionIntake.js module doc comments.

  calendar_prep: {
    name: 'calendar_prep',
    description: "Meeting prep for ONE occurrence, by its exact occurrenceKey (from a prior calendar_agenda/calendar_overlay/calendar_brief_input call — this tool does not resolve a fuzzy reference like 'my 3pm', do that yourself first). Joins the event against the org's own InboxQ mail IN-PROCESS: up to 3 related threads, participant matches (an attendee emailed you) ranked ahead of contextual ones (subject overlaps the event title — these are SUGGESTIONS, marked relation:'contextual', never assume they are confirmed). summary is a deterministic structured digest, never model-generated. missingContext states plainly when there is no connected InboxQ account or no relevant thread was found — never claim a clean inbox beyond what was actually checked. Read-only, free.",
    input_schema: {
      type: 'object',
      properties: {
        occurrenceKey: { type: 'string', description: 'The exact occurrenceKey from a prior agenda/overlay/brief call.' },
      },
      required: ['occurrenceKey'],
    },
    execute: async (input, ctx) => {
      const { occurrenceKey } = input || {};
      if (!occurrenceKey) return { success: false, error: 'occurrenceKey is required' };
      try {
        const orgId = requireOrg(ctx);
        const prep = getPrep(orgId, { occurrenceKey, nowMs: Date.now() });
        auditDep(ctx)({ type: 'action', intent: 'quox.calendar.prep', corr: occurrenceKey, payload: { tool: 'calendar_prep', referenceCount: prep.references.length } });
        return { success: true, prep };
      } catch (e) {
        if (e.message === 'occurrence_not_found') return { success: false, error: 'occurrence not found in any connection\'s latest published generation' };
        return { success: false, error: e.message };
      }
    },
  },

  calendar_brief_input: {
    name: 'calendar_brief_input',
    description: "Build (or re-read) the org's structured morning-brief data for one workday: per-layer coverage, the next 3 human-busy occurrences (each with up-to-3 fresh meeting-prep references), clashes detected within that day, evidenced changes since the previous brief, and Action-Q receipt counts. Deterministic and zero-LLM — render the actual spoken brief FROM this data at chat time, never invent a field not present here. A second call for the SAME workday returns the identical persisted brief unless force is set. An empty clashes/changes array that instead contains a {state:'partial'} marker means coverage could not fully confirm 'nothing to report' — surface that honestly rather than saying the day is clear. Free; force:true recomputes and persists a new version.",
    input_schema: {
      type: 'object',
      properties: {
        workday: { type: 'string', description: "'YYYY-MM-DD'. Defaults to today in the given timezone." },
        timezone: { type: 'string', description: "IANA timezone. Defaults to 'UTC'." },
        force: { type: 'boolean', description: 'Recompute and persist a new scheduleVersion even if one already exists for this workday. Defaults to false.' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      try {
        const orgId = requireOrg(ctx);
        const timezone = (input && input.timezone) || 'UTC';
        const resolvedWorkday = (input && input.workday) || todayInTz(Date.now(), timezone);
        const { brief, upcomingPrep, created } = await buildBriefInput(orgId, {
          workday: resolvedWorkday, timezone, nowMs: Date.now(), fetchImpl: ctx.fetchImpl, force: Boolean(input && input.force),
        });
        auditDep(ctx)({ type: 'action', intent: 'quox.calendar.read', corr: resolvedWorkday, payload: { tool: 'calendar_brief_input', created, upcomingCount: brief.upcoming.length } });
        return { success: true, brief, upcomingPrep, created };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  calendar_followup_propose: {
    name: 'calendar_followup_propose',
    // NOT externalEffect: this only ever writes to the org's own Action-Q
    // queue (an internal board, via the same action_add path every
    // action_add tool call already uses) — nothing leaves the system, no
    // email is sent, no provider is called. Same reasoning as
    // calendar_event_propose having no approval gate: a proposal-shaped,
    // internal-only write is pre-granted at the read tier, not gated like
    // calendar_event_create (which DOES reach a real external calendar).
    description: "Create an Action-Q follow-up from a calendar occurrence or receipt, with explicit provenance. sourceRefs MUST include at least one occurrenceKey or receipt id that actually exists in this org — this tool NEVER infers or auto-creates a follow-up from 'the meeting ended' or any other signal, it only fires on an explicit request. idempotencyKey is mandatory: calling again with the SAME key returns the SAME action item instead of creating a duplicate. No approval gate (internal board write, not an external effect) — but it rides the real Action Tracker write path, so the item is immediately visible via action_list.",
    input_schema: {
      type: 'object',
      properties: {
        idempotencyKey: { type: 'string', description: 'A stable key you choose for this specific follow-up request — reusing it is how a retried call stays safe.' },
        title: { type: 'string' },
        sourceRefs: { type: 'array', items: { type: 'string' }, description: 'At least one occurrenceKey (from calendar_agenda/calendar_prep/calendar_brief_input) or receipt id (from calendar_reconcile/the Receipts tab).' },
        owner: { type: 'string', description: 'Who the follow-up belongs to (an email or name).' },
        deadlineTs: { type: 'number', description: 'Optional epoch ms deadline.' },
        deadlineEvidence: { type: 'string', description: 'Optional: WHY this deadline (e.g. a quote from the event or thread). Plain text, never a URL to fetch.' },
      },
      required: ['idempotencyKey', 'title', 'sourceRefs', 'owner'],
    },
    execute: async (input, ctx) => {
      try {
        const orgId = requireOrg(ctx);
        const result = await proposeFollowUp(orgId, input || {}, { userId: ctx.userId || null, agentId: ctx.agentId || 'calendar-q', token: ctx.token || null });
        if (!result.ok) return { success: false, error: result.errors.join('; ') };
        auditDep(ctx)({ type: 'action', intent: 'quox.calendar.propose', corr: result.actionItemId, payload: { tool: 'calendar_followup_propose', actionItemId: result.actionItemId, duplicate: Boolean(result.duplicate) } });
        return {
          success: true,
          actionItemId: result.actionItemId,
          duplicate: Boolean(result.duplicate),
          summary: result.duplicate
            ? `This follow-up was already created (action item ${result.actionItemId}) — returning the existing ack rather than creating a duplicate.`
            : `Added action item ${result.actionItemId} to the Action Tracker.`,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },
};

module.exports = {
  CALENDARQ_TOOLS,
  setCalendarqToolsAuditFn,
};
