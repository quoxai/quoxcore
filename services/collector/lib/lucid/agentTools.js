'use strict';

/**
 * LUCID agent tools: the read-only surface the `lucid` agent reasons over.
 * In-process (same journal, same situationFor/itemFor the HTTP routes use).
 * The org comes from the tool ctx only, never from args. Nothing here changes
 * state: situationFor is called with advance:false so a read never moves a cursor.
 */

const { situationFor } = require('./routes.js');
const { itemFor } = require('./situation.js');

const NEEDS_LIMIT = 8;
const URGENCY_ORDER = { now: 0, today: 1, 'this week': 2, whenever: 3, fyi: 4 };

function requireOrg(ctx) {
  if (!ctx || !ctx.orgId) throw new Error('org_context_required: LUCID tools need an authenticated org context.');
  return ctx.orgId;
}

function strip(item) {
  if (!item || typeof item !== 'object') return item;
  const { _x, ...rest } = item;
  return rest;
}

function trimNeed(x) {
  return {
    ref: x.subject || x.ref,
    L0: x.L0,
    urgency: x.urgency,
    area: x.area,
    L1: x.L1,
    L2: x.L2 ? { measures: (x.L2.measures || []).map((m) => ({ id: m.id, label: m.label, say: m.say, risk: m.risk })) } : { measures: [] },
    stale: !!(x.L3 && x.L3.confidence && x.L3.confidence.stale),
  };
}

const BOX_PREFIXES = ['sentry:', 'unit:', 'host:', 'container:', 'site:', 'service:'];
const BOX_FEEDS = ['vital', 'units', 'sentry', 'containers', 'sites'];
const BOX_CARD_LIMIT = 40;

function boxCard(it) {
  return {
    ref: it.ref || it.subject,
    L0: it.L0,
    who: it.L1 && it.L1.who,
    what: it.L1 && it.L1.what,
    why: it.L1 && it.L1.why,
    how: (it._x && it._x.how) || '',
    urgency: it.urgency,
    since: it.L1 && it.L1.when ? it.L1.when.since : null,
  };
}

const LUCID_TOOLS = {
  lucid_situation: {
    name: 'lucid_situation',
    description: "LUCID's situational awareness for this org: a one-line briefing, what needs the person (who/what/why/when/how, names not ids), the state of each area, and what LUCID cannot see (silent or unconnected sources). Read-only, free, never moves a read cursor. Always report cannot_see; never say a bare 'all clear'.",
    input_schema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: "Optional window for 'what changed': 'last' (default), a journal seq, or a window like '3h' / '1d'." },
        surface: { type: 'string', description: 'Optional surface name the read cursor is kept per (default "agent").' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      try {
        const orgId = requireOrg(ctx);
        const { since, surface } = input || {};
        const r = situationFor(orgId, { since, viewer: 'owner', surface: typeof surface === 'string' && surface ? surface.slice(0, 40) : 'agent', advance: false });
        const s = r.situation;
        return {
          success: true,
          briefing: s.L0,
          text: r.text,
          needs_you: (s.needs_you || []).slice(0, NEEDS_LIMIT).map(trimNeed),
          needs_you_total: (s.needs_you || []).length,
          areas: (s.areas || []).map((a) => ({ area: a.area, L0: a.L0, state: a.state })),
          cannot_see: s.cannot_see,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  box_health: {
    name: 'box_health',
    description: "The dev box's health as LUCID sees it (the box watchdog 'sentry' plus units, hosts, containers, sites, services): plain cards for each current systems item (who/what/why/how, urgency, since) and whether each feed (vital, units, sentry, containers, sites) is live, silent, failing or unwired. Read-only, free, never moves a read cursor. Always report the feed liveness; a silent feed means blind, not healthy.",
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (_input, ctx) => {
      try {
        const orgId = requireOrg(ctx);
        const r = situationFor(orgId, { viewer: 'owner', surface: 'agent', advance: false });
        const s = r.situation;
        const sys = (s.areas || []).find((a) => a.area === 'systems');
        const seen = new Set();
        const cards = [];
        for (const it of [...((sys && sys.L1 && sys.L1.needs) || []), ...((sys && sys.L1 && sys.L1.open) || [])]) {
          const ref = it.ref || it.subject;
          if (!ref || seen.has(ref) || !BOX_PREFIXES.some((p) => ref.startsWith(p))) continue;
          seen.add(ref);
          cards.push(boxCard(it));
        }
        cards.sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9));
        const cs = s.cannot_see || {};
        const failing = new Map((cs.failing || []).map((x) => [x.feed, x]));
        const silent = new Map((cs.silent || []).map((x) => [x.feed, x]));
        const unwired = new Set(cs.unwired || []);
        const feeds = BOX_FEEDS.map((f) => {
          if (failing.has(f)) return { feed: f, state: 'failing', error: failing.get(f).error };
          if (silent.has(f)) return { feed: f, state: 'silent', silent_ms: silent.get(f).silent_ms };
          if (unwired.has(f)) return { feed: f, state: 'unwired' };
          const inArea = sys && sys.feeds && (sys.feeds.live || []).includes(f);
          return { feed: f, state: inArea ? 'live' : 'unwired' };
        });
        return {
          success: true,
          state: sys ? sys.state : 'unknown',
          summary: sys ? sys.L0 : 'Systems area not available.',
          items: cards.slice(0, BOX_CARD_LIMIT),
          items_total: cards.length,
          feeds,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  lucid_item: {
    name: 'lucid_item',
    description: "One LUCID item with its full account (the why), its evidence trail and the measures that can be taken. Read-only, free. ref is an item reference from lucid_situation (e.g. approval:123, unit:foo.service).",
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'The item reference from lucid_situation needs_you[].ref.' } },
      required: ['ref'],
    },
    execute: async (input, ctx) => {
      try {
        const orgId = requireOrg(ctx);
        const ref = input && typeof input.ref === 'string' ? input.ref.trim() : '';
        if (!ref) return { success: false, error: 'ref is required' };
        const item = itemFor(orgId, ref);
        if (!item) return { success: false, error: 'not found' };
        return { success: true, item: strip(item) };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },
};

module.exports = { LUCID_TOOLS };
