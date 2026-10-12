'use strict';

/**
 * inboxqTools.js — INBOXQ_AGENT_DESIGN.md §A: the agent tool surface InboxQ's
 * chat sidebar (and any agent that delegates to it) reasons and acts over
 * natural language with ("move all wordfence to that folder", "junk this
 * sender and block him"). Every handler builds the SAME
 * { orgId, userId, body, params, query } ctx shape the pure inboxq/api.js
 * handlers already take, and calls those exported `_handlers` (or
 * store functions directly for reads) IN-PROCESS — same collector process,
 * same org resolution, same audit envelope shapes as the REST surface. Org is
 * ALWAYS ctx.orgId (server-resolved by the chat dispatcher before any tool
 * runs); no tool here accepts an org argument.
 *
 * Read tools are free (no approval, no mail effect). EVERY mutating tool
 * terminates in the existing inboxq_proposals + requireHuman resolve path
 * (api.js hCreateProposal / hResolveProposal) — never in an execution route.
 * There is no tool that moves, blocks, sends, replies, deletes, or marks mail
 * read; a proposal is the only mutation shape this module can produce.
 *
 * Batch = ONE approval (design §A): inbox_propose_move/inbox_propose_rezone
 * accept EITHER explicit messageIds (from a prior inbox_search) or a
 * matchSpec (the object inbox_search echoes back). Given a matchSpec, the
 * server RE-RUNS that search right now (freezeMessageIds below) and freezes
 * the result — capped at MAX_BATCH_IDS — into the ONE proposal payload. The
 * approved authority is that frozen set; mail arriving after the call is not
 * covered, and the tool result says so when the match was capped.
 *
 * AEE audit: this module has no direct handle on the collector's
 * storeAuditEnvelope closure (a server.js-local function), so it takes the
 * SAME injected-callback shape actionToolHandlers.js/brainCitationTrace.js
 * already use for exactly this reason — setInboxqToolsAuditFn(fn), wired once
 * at server.js boot right next to registerInboxqRoutes's own `audit` dep — so
 * a tool-raised proposal emits the identical quox.inbox.* envelope shape a
 * UI-raised one does. Defaults to a no-op so the module works unwired in
 * tests.
 */

const store = require('./inboxq/store.js');
const { _handlers } = require('./inboxq/api.js');
const { ZONES } = require('./inboxq/classify.js');

// INBOXQ_AGENT_DESIGN.md §E.6 batch bound: a proposal's approved authority is
// its frozen id set, capped here so "move all X" can never silently balloon
// into an unbounded mail effect behind one click.
const MAX_BATCH_IDS = 200;
const MAX_SEARCH_LIMIT = 200;
// Triage needs the gist, not the whole payload in model context (design §A
// inbox_get row) — the InboxQ panel itself is the place to read a full email.
const BODY_TRUNCATE_CHARS = 4096;

let _storeAuditEnvelope = () => {};
/** Wire in the server's storeAuditEnvelope function. Call once at startup. */
function setInboxqToolsAuditFn(fn) {
  if (typeof fn === 'function') _storeAuditEnvelope = fn;
}

function auditDep(ctx) {
  return (e) => _storeAuditEnvelope({ from: `agent.${ctx.agentId || 'inboxq'}`, to: 'audit.system', ...e });
}

/**
 * Deps for the DIRECT-EXECUTE tools (inbox_move/inbox_rezone/inbox_block/
 * inbox_create_folder). They call the SAME instant human-authoritative handlers
 * the dashboard buttons call, so they need the IMAP/credential deps those
 * handlers take; in production the handlers default to the real imap.js +
 * credential resolver, so this only carries the audit sink. ctx.inboxDeps lets
 * a test inject mock moveMessages/createImapFolder/resolveCredential; it is
 * never set on a real request.
 */
function execDeps(ctx) {
  return { audit: auditDep(ctx), ...(ctx && ctx.inboxDeps ? ctx.inboxDeps : {}) };
}

/** Build the exact ctx shape inboxq/api.js's pure handlers take. Refuses
 * without an org — a tool that cannot resolve an org must never fall back to
 * a default (multi-tenant, fail closed). */
function baseCtx(ctx, { body = {}, params = {}, query = {} } = {}) {
  if (!ctx || !ctx.orgId) {
    throw new Error('org_context_required: InboxQ tools need an authenticated org context.');
  }
  return { orgId: ctx.orgId, userId: ctx.userId || null, body, params, query };
}

/** Unwrap a pure handler's { status, json } into a tool result. An error body
 * is not data: any non-2xx status is reported as success:false, never parsed
 * as if it were a healthy answer. */
function toToolResult(res) {
  if (res && res.status >= 200 && res.status < 300) {
    return { success: true, ...res.json };
  }
  return { success: false, error: (res && res.json && res.json.error) || `request failed (${res && res.status})` };
}

/**
 * ContactsQ P3b: agent-visible payloads also carry sender_ref ('contact:<id>') beside the
 * handler's sender_contact, so an agent can call contacts_* tools by id. Additive and
 * fail-soft; messages without a resolved sender are returned untouched.
 * TODO(ContactsQ): full ingest tokenisation (replace raw sender emails in agent payloads with
 * refs) is a breaking change for InboxQ agent prompts and is deliberately NOT done here.
 */
function withSenderRef(m) {
  try {
    if (m && m.sender_contact && m.sender_contact.id) return { ...m, sender_ref: `contact:${m.sender_contact.id}` };
  } catch { /* fail-soft */ }
  return m;
}

/**
 * Resolve a propose call's target message ids per §A "Batch = ONE approval":
 * explicit messageIds win when given (capped at MAX_BATCH_IDS); otherwise a
 * matchSpec is RE-SEARCHED right now (never trusting an earlier read) and the
 * result frozen, also capped. Returns { success:false, error } when neither
 * is usable or the spec matches nothing — a propose call must never create an
 * empty or unbounded proposal.
 */
function freezeMessageIds(input, ctx) {
  const { accountId, messageIds, matchSpec } = input || {};
  if (Array.isArray(messageIds) && messageIds.length > 0) {
    // Dedupe BEFORE capping: a repeated id would otherwise count twice, inflate
    // the "moved N" total, and create duplicate undo-log records for one message.
    const unique = [...new Set(messageIds)];
    const capped = unique.slice(0, MAX_BATCH_IDS);
    return { success: true, messageIds: capped, matchSpec: null, total: unique.length, capped: unique.length > MAX_BATCH_IDS };
  }
  if (matchSpec && typeof matchSpec === 'object') {
    const spec = { ...matchSpec, accountId };
    let result;
    try {
      result = store.searchMessages(ctx.orgId, { ...spec, limit: MAX_BATCH_IDS });
    } catch (e) {
      return { success: false, error: `matchSpec search failed: ${e.message}` };
    }
    if (!result || result.total === 0) {
      return { success: false, error: 'matchSpec matched no messages — nothing to propose' };
    }
    return {
      success: true,
      messageIds: result.messages.map((m) => m.id),
      matchSpec: spec,
      total: result.total,
      capped: result.total > MAX_BATCH_IDS,
    };
  }
  return { success: false, error: 'either messageIds or matchSpec is required' };
}

function proposalSummary(kind, frozen, extra = {}) {
  const n = frozen.messageIds.length;
  const of = frozen.capped ? ` of ${frozen.total}` : '';
  if (kind === 'file') return `FILE ${n}${of} -> ${extra.folder}`;
  if (kind === 'rezone') return `REZONE ${n}${of} -> ${extra.toZone}`;
  return `${kind.toUpperCase()} ${n}${of}`;
}

/**
 * Shape a hCreateProposal result into the tool's honesty-enforced reply
 * (design §C "Honesty rules"): the propose tool's OWN result string contains
 * "PROPOSAL CREATED ... NOT EXECUTED. A human must approve it." so the model
 * is quoting its own tool result when it speaks, not paraphrasing into a
 * claim of completion.
 */
function proposeResult(res, frozen) {
  if (!res || res.status !== 200) {
    return { success: false, error: (res && res.json && res.json.error) || `propose failed (${res && res.status})` };
  }
  const proposal = res.json.proposal;
  let countNote = '';
  if (frozen && typeof frozen.total === 'number') {
    countNote = frozen.capped
      ? ` First ${frozen.messageIds.length} of ${frozen.total} matched — propose the rest after this one applies.`
      : ` ${frozen.total} matched.`;
  }
  return {
    success: true,
    proposal,
    executed: false,
    result: `PROPOSAL CREATED (id ${proposal.id}), NOT EXECUTED. A human must approve it.${countNote}`,
  };
}

const INBOXQ_TOOLS = {

  // --- read tools: free, no approval, no mail effect ------------------------

  inbox_accounts: {
    name: 'inbox_accounts',
    description: "List the org's connected InboxQ mailboxes. Read-only, free, no approval. An empty list means no mailbox is connected yet — say so plainly.",
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => toToolResult(await _handlers.hListAccounts(baseCtx(ctx))),
  },

  inbox_zones: {
    name: 'inbox_zones',
    description: 'Count of stored messages per triage zone (focus/fyi/auto/screened) for one account, or the whole org if accountId is omitted. Read-only, free.',
    input_schema: {
      type: 'object',
      properties: { accountId: { type: 'string', description: 'Optional: scope to one connected mailbox.' } },
      required: [],
    },
    execute: async (input, ctx) => {
      const { accountId } = input || {};
      return toToolResult(await _handlers.hZones(baseCtx(ctx, { query: { accountId: accountId || null } })));
    },
  },

  inbox_folders: {
    name: 'inbox_folders',
    description: "List an account's durable custom filing folders (the destinations inbox_propose_move can file into). Read-only, free.",
    input_schema: {
      type: 'object',
      properties: { accountId: { type: 'string', description: 'The connected mailbox id.' } },
      required: ['accountId'],
    },
    execute: async (input, ctx) => {
      const { accountId } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      return toToolResult(await _handlers.hListFolders(baseCtx(ctx, { query: { accountId } })));
    },
  },

  inbox_search: {
    name: 'inbox_search',
    description: "Search one account's stored mail by sender, sender domain, subject, free text, zone, folder or flag. Read-only, free — and the ONLY way to know what \"move all X\" or \"junk everything from Y\" actually matches BEFORE proposing anything. Always call this first and quote its exact `total` back to the human, never guess. Returns { total, messages, matchSpec }: hand matchSpec UNCHANGED to inbox_propose_move / inbox_propose_rezone so the server re-runs the identical search at propose time and freezes the same set.",
    input_schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'The connected mailbox id.' },
        from: { type: 'string', description: 'Substring match on the sender address.' },
        fromDomain: { type: 'string', description: 'Exact sender domain, e.g. "wordfence.com".' },
        subject: { type: 'string', description: 'Substring match on the subject.' },
        text: { type: 'string', description: 'Substring match across subject, snippet, sender address and sender name.' },
        zone: { type: 'string', enum: ZONES, description: 'Filter to one triage zone.' },
        folder: { type: 'string', description: 'Filter to one stored IMAP folder path.' },
        flag: { type: 'string', description: 'Filter to messages carrying this flag (e.g. needs_action).' },
        limit: { type: 'number', description: `Max messages to return (default 50, hard cap ${MAX_SEARCH_LIMIT}). total is never capped.` },
      },
      required: ['accountId'],
    },
    execute: async (input, ctx) => {
      const { accountId } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      const out = toToolResult(await _handlers.hSearchMessages(baseCtx(ctx, { query: input || {} }), { audit: auditDep(ctx) }));
      if (out.success && Array.isArray(out.messages)) out.messages = out.messages.map(withSenderRef);
      return out;
    },
  },

  inbox_get: {
    name: 'inbox_get',
    description: `Full detail for one stored message, including its body (truncated to ${BODY_TRUNCATE_CHARS} characters here — triage needs the gist, use the InboxQ panel for the whole email). Read-only, free, and audited (quox.inbox.message.read).`,
    input_schema: {
      type: 'object',
      properties: { messageId: { type: 'string', description: 'The message id (from inbox_search).' } },
      required: ['messageId'],
    },
    execute: async (input, ctx) => {
      const { messageId } = input || {};
      if (!messageId) return { success: false, error: 'messageId is required' };
      const res = await _handlers.hGetMessage(baseCtx(ctx, { params: { id: messageId } }), { audit: auditDep(ctx) });
      if (res.status !== 200) return toToolResult(res);
      const message = withSenderRef({ ...res.json.message });
      for (const field of ['bodyText', 'bodyHtml']) {
        if (typeof message[field] === 'string' && message[field].length > BODY_TRUNCATE_CHARS) {
          message[field] = `${message[field].slice(0, BODY_TRUNCATE_CHARS)}\n...[truncated]`;
        }
      }
      return { success: true, message };
    },
  },

  inbox_proposals: {
    name: 'inbox_proposals',
    description: 'List filing/rezone/block/folder proposals, optionally filtered by status (proposed|approved|denied|applied|failed). Read-only, free — use this to report back a REAL outcome after a human has acted; never assume one happened.',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['proposed', 'approved', 'denied', 'applied', 'failed'] } },
      required: [],
    },
    execute: async (input, ctx) => {
      const { status } = input || {};
      return toToolResult(await _handlers.hListProposals(baseCtx(ctx, { query: { status: status || null } })));
    },
  },

  inbox_blocked: {
    name: 'inbox_blocked',
    description: 'List currently-blocked senders/domains for an account. Read-only, free.',
    input_schema: {
      type: 'object',
      properties: { accountId: { type: 'string' } },
      required: ['accountId'],
    },
    execute: async (input, ctx) => {
      const { accountId } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      return toToolResult(await _handlers.hListBlocked(baseCtx(ctx, { query: { accountId } })));
    },
  },

  inbox_report_latest: {
    name: 'inbox_report_latest',
    description: 'The most recent generated daily InboxQ report for an account. Read-only, free.',
    input_schema: {
      type: 'object',
      properties: { accountId: { type: 'string' } },
      required: ['accountId'],
    },
    execute: async (input, ctx) => {
      const { accountId } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      return toToolResult(await _handlers.hLatestReport(baseCtx(ctx, { query: { accountId } })));
    },
  },

  // --- mutating: every one creates exactly ONE proposal, none executes ------

  inbox_propose_move: {
    name: 'inbox_propose_move',
    description: `Propose moving one or more messages into a folder. NEVER executes — it creates ONE proposal a human approves in the InboxQ Approvals card. Pass EITHER explicit messageIds (from a prior inbox_search) OR matchSpec (the object inbox_search echoed back) — given matchSpec, the server RE-RUNS that search now and freezes the matched ids (capped at ${MAX_BATCH_IDS}) into the ONE proposal: mail arriving after this call is NOT covered. Your reply after calling this MUST quote this tool's own result string (it already says "proposed" and "NOT EXECUTED") rather than paraphrasing into a claim that anything moved.`,
    input_schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        messageIds: { type: 'array', items: { type: 'string' }, description: 'Explicit message ids to file, from a prior inbox_search.' },
        matchSpec: { type: 'object', description: 'A matchSpec object echoed by inbox_search — the server re-runs this search now and freezes the result.' },
        folder: { type: 'string', description: 'Destination folder name, id, or IMAP path.' },
        createFolderIfMissing: { type: 'boolean', description: 'If the named folder does not exist yet, create it as part of the SAME approval when a human approves.' },
        note: { type: 'string', description: 'Optional human-readable context carried on the proposal.' },
      },
      required: ['accountId', 'folder'],
    },
    execute: async (input, ctx) => {
      const { accountId, folder, createFolderIfMissing, note } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      if (!folder) return { success: false, error: 'folder is required' };
      const frozen = freezeMessageIds(input, ctx);
      if (!frozen.success) return frozen;
      const proposedBy = `agent:${ctx.agentId || 'inboxq'}`;
      const res = await _handlers.hCreateProposal(baseCtx(ctx, {
        body: {
          accountId, kind: 'file', createdVia: proposedBy,
          payload: {
            messageIds: frozen.messageIds, folder, createFolder: !!createFolderIfMissing,
            matchSpec: frozen.matchSpec, summary: proposalSummary('file', frozen, { folder }),
            note: note || null, proposedBy,
          },
        },
      }), { audit: auditDep(ctx) });
      return proposeResult(res, frozen);
    },
  },

  inbox_propose_rezone: {
    name: 'inbox_propose_rezone',
    description: 'Propose re-classifying one or more messages to a different triage zone (focus/fyi/auto/screened). Quox-side only, no mail-server effect. NEVER executes on its own — creates ONE proposal a human approves. Same matchSpec-freeze rule as inbox_propose_move.',
    input_schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        messageIds: { type: 'array', items: { type: 'string' } },
        matchSpec: { type: 'object' },
        toZone: { type: 'string', enum: ZONES },
        note: { type: 'string' },
      },
      required: ['accountId', 'toZone'],
    },
    execute: async (input, ctx) => {
      const { accountId, toZone, note } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      if (!toZone || !ZONES.includes(toZone)) return { success: false, error: `toZone must be one of ${ZONES.join('|')}` };
      const frozen = freezeMessageIds(input, ctx);
      if (!frozen.success) return frozen;
      const proposedBy = `agent:${ctx.agentId || 'inboxq'}`;
      const res = await _handlers.hCreateProposal(baseCtx(ctx, {
        body: {
          accountId, kind: 'rezone', createdVia: proposedBy,
          payload: {
            messageIds: frozen.messageIds, toZone, matchSpec: frozen.matchSpec,
            summary: proposalSummary('rezone', frozen, { toZone }), note: note || null, proposedBy,
          },
        },
      }), { audit: auditDep(ctx) });
      return proposeResult(res, frozen);
    },
  },

  inbox_propose_block: {
    name: 'inbox_propose_block',
    description: "Propose blocking a sender or a whole domain: one approval screens their currently-stored mail, best-effort junk-moves it on the mail server where a Junk folder exists (sender scope only), and auto-screens everything they send in future. NEVER executes on its own — creates ONE proposal a human approves. State what one approval covers (screen count + best-effort junk move) before proposing, and never claim it happened until you read back an applied proposal via inbox_proposals.",
    input_schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        fromAddr: { type: 'string', description: 'Sender address (scope=sender).' },
        domain: { type: 'string', description: 'Domain (scope=domain).' },
        scope: { type: 'string', enum: ['sender', 'domain'] },
        note: { type: 'string' },
      },
      required: ['accountId', 'scope'],
    },
    execute: async (input, ctx) => {
      const { accountId, fromAddr, domain, scope = 'sender', note } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      if (!['sender', 'domain'].includes(scope)) return { success: false, error: 'scope must be sender|domain' };
      const target = scope === 'domain' ? domain : fromAddr;
      if (!target) {
        return { success: false, error: scope === 'domain' ? 'domain is required for scope=domain' : 'fromAddr is required for scope=sender' };
      }
      // Honest preview count (design Flow 2, "14 stored messages") — how many
      // currently-stored messages this would screen, read BEFORE proposing so
      // the reply quotes a real number, never a guess. Best-effort: a search
      // failure here must not block the proposal itself.
      let matchedCount = 0;
      try {
        const search = store.searchMessages(ctx.orgId, {
          accountId,
          from: scope === 'sender' ? target : null,
          fromDomain: scope === 'domain' ? target : null,
          limit: 1,
        });
        matchedCount = search.total;
      } catch { /* preview-only; the proposal below is unaffected */ }
      const proposedBy = `agent:${ctx.agentId || 'inboxq'}`;
      const res = await _handlers.hCreateProposal(baseCtx(ctx, {
        body: {
          accountId, kind: 'block', createdVia: proposedBy,
          payload: { scope, target: String(target).trim().toLowerCase(), matchedCount, note: note || null, proposedBy },
        },
      }), { audit: auditDep(ctx) });
      return proposeResult(res, { total: matchedCount, capped: false, messageIds: [] });
    },
  },

  inbox_propose_create_folder: {
    name: 'inbox_propose_create_folder',
    description: 'Propose creating a new durable filing folder (a real IMAP CREATE on approve). NEVER executes on its own — creates ONE proposal a human approves.',
    input_schema: {
      type: 'object',
      properties: { accountId: { type: 'string' }, name: { type: 'string' } },
      required: ['accountId', 'name'],
    },
    execute: async (input, ctx) => {
      const { accountId, name } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      if (!name) return { success: false, error: 'name is required' };
      const proposedBy = `agent:${ctx.agentId || 'inboxq'}`;
      const res = await _handlers.hCreateProposal(baseCtx(ctx, {
        body: { accountId, kind: 'folder_create', createdVia: proposedBy, payload: { name, proposedBy } },
      }), { audit: auditDep(ctx) });
      return proposeResult(res, null);
    },
  },

  // --- direct-execute: the authenticated user commanding the agent IS the ----
  // authorization (owner 2026-10-02). These run the SAME instant
  // human-authoritative handlers the dashboard buttons call, with NO proposal
  // and NO separate approval screen, and report the REAL outcome (counts,
  // undo ids) read back from the handler. For the interactive sidebar agent
  // only; a future autonomous/scheduled worker keeps the inbox_propose_* tools.

  inbox_move: {
    name: 'inbox_move',
    description: `Move one or more messages into a folder, NOW. The user asking you to file mail IS the authorization — this executes immediately through the same path the "Move to folder" button uses; it does not create a proposal and does not wait for a second approval. Pass EITHER explicit messageIds (from a prior inbox_search) OR matchSpec (the object inbox_search echoed back): given matchSpec the server re-runs that search now and freezes the matched ids (capped at ${MAX_BATCH_IDS}). Set createFolderIfMissing to make the destination folder first if it does not exist. The result reports exactly how many moved and carries moveIds for Undo; quote the real counts, and note an Undo is available if that was not what they wanted.`,
    input_schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        messageIds: { type: 'array', items: { type: 'string' }, description: 'Explicit message ids to file, from a prior inbox_search.' },
        matchSpec: { type: 'object', description: 'A matchSpec object echoed by inbox_search — the server re-runs this search now and freezes the result.' },
        folder: { type: 'string', description: 'Destination folder name, id, or IMAP path.' },
        createFolderIfMissing: { type: 'boolean', description: 'Create the destination folder first if it does not exist yet.' },
      },
      required: ['accountId', 'folder'],
    },
    execute: async (input, ctx) => {
      const { accountId, folder, createFolderIfMissing } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      if (!folder) return { success: false, error: 'folder is required' };
      const frozen = freezeMessageIds(input, ctx);
      if (!frozen.success) return frozen;

      if (createFolderIfMissing) {
        // Consider BOTH the custom-folder records and the account's synced IMAP
        // folders, case-insensitively: a destination that already exists as a
        // synced mailbox would otherwise miss this check and trigger a pointless
        // (and failing) CREATE that aborts the move.
        const existing = store.listFolders(ctx.orgId, accountId) || [];
        const acct = store.getAccount(ctx.orgId, accountId);
        const synced = Array.isArray(acct?.folders) ? acct.folders : [];
        const target = String(folder).trim().toLowerCase();
        const present = existing.some((f) => [f.name, f.imapPath, f.id].some((v) => String(v || '').toLowerCase() === target))
          || synced.some((p) => { const s = String(p || '').toLowerCase(); return s === target || s.endsWith(`.${target}`); });
        if (!present) {
          const cf = await _handlers.hCreateFolder(baseCtx(ctx, { body: { accountId, name: folder } }), execDeps(ctx));
          if (cf.status !== 200) return toToolResult(cf);
        }
      }

      const res = await _handlers.hMoveToFolder(baseCtx(ctx, {
        body: { accountId, folder, messageIds: frozen.messageIds },
      }), execDeps(ctx));
      if (res.status !== 200) return toToolResult(res);
      const { moved = [], failed = [], moves = [] } = res.json || {};
      const movedN = moved.length;
      const ofN = frozen.capped ? ` (first ${frozen.messageIds.length} of ${frozen.total} matched)` : '';
      const failNote = failed.length ? ` ${failed.length} could not be moved.` : '';
      return {
        success: true,
        executed: true,
        moved,
        failed,
        moveIds: moves.map((m) => m.id),
        result: `DONE: moved ${movedN}${ofN} to ${folder}.${failNote} Nothing was queued for approval — this already happened. An Undo is available if that was wrong.`,
      };
    },
  },

  inbox_rezone: {
    name: 'inbox_rezone',
    description: 'Re-classify one or more messages to a different triage zone (focus/fyi/auto/screened), NOW. Quox-side only, no mail-server effect. Executes immediately on the user\'s command — no proposal, no separate approval. Same explicit-ids-or-matchSpec rule as inbox_move. Reports how many were re-zoned.',
    input_schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        messageIds: { type: 'array', items: { type: 'string' } },
        matchSpec: { type: 'object' },
        toZone: { type: 'string', enum: ZONES },
      },
      required: ['accountId', 'toZone'],
    },
    execute: async (input, ctx) => {
      const { accountId, toZone } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      if (!toZone || !ZONES.includes(toZone)) return { success: false, error: `toZone must be one of ${ZONES.join('|')}` };
      const frozen = freezeMessageIds(input, ctx);
      if (!frozen.success) return frozen;
      let moved = 0;
      const failed = [];
      for (const id of frozen.messageIds) {
        const r = await _handlers.hMoveMessage(baseCtx(ctx, { params: { id }, body: { toZone } }), execDeps(ctx));
        if (r.status === 200) moved += 1; else failed.push(id);
      }
      const ofN = frozen.capped ? ` (first ${frozen.messageIds.length} of ${frozen.total} matched)` : '';
      const failNote = failed.length ? ` ${failed.length} could not be re-zoned.` : '';
      return {
        success: true,
        executed: true,
        moved,
        failed,
        result: `DONE: re-zoned ${moved}${ofN} to ${toZone}.${failNote} Nothing was queued for approval.`,
      };
    },
  },

  inbox_block: {
    name: 'inbox_block',
    description: "Block a sender or a whole domain, NOW. Executes immediately on the user's command (no proposal, no separate approval): it screens their currently-stored mail inside Quox, best-effort junk-moves it on the mail server where a Junk folder exists (sender scope only), and auto-screens everything they send in future. HONESTY: this installs NO server-side mail rule yet, so it holds inside Quox but a blocked sender can still arrive in other mail clients until the provider-rule work lands — say so. Quote the real screened/junk-moved counts from the result.",
    input_schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        fromAddr: { type: 'string', description: 'Sender address (scope=sender).' },
        domain: { type: 'string', description: 'Domain (scope=domain).' },
        scope: { type: 'string', enum: ['sender', 'domain'] },
      },
      required: ['accountId', 'scope'],
    },
    execute: async (input, ctx) => {
      const { accountId, fromAddr, domain, scope = 'sender' } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      if (!['sender', 'domain'].includes(scope)) return { success: false, error: 'scope must be sender|domain' };
      const target = scope === 'domain' ? (domain || (fromAddr ? String(fromAddr).split('@')[1] : '')) : fromAddr;
      if (!target) {
        return { success: false, error: scope === 'domain' ? 'domain is required for scope=domain' : 'fromAddr is required for scope=sender' };
      }
      const res = await _handlers.hBlockSender(baseCtx(ctx, { body: { accountId, fromAddr, domain, scope } }), execDeps(ctx));
      if (res.status !== 200) return toToolResult(res);
      const o = res.json || {};
      const junkNote = o.junkFailed
        ? ' The best-effort Junk move did not land.'
        : (o.junkMoved ? ` Junk-moved ${o.junkMoved} on the server.` : '');
      return {
        success: true,
        executed: true,
        scope,
        target: o.target,
        screened: o.screened,
        junkMoved: o.junkMoved,
        junkFailed: o.junkFailed,
        providerRule: o.providerRule,
        result: `DONE: blocked ${o.target}. Screened ${o.screened} in Quox and future mail from them is auto-screened.${junkNote} This holds inside Quox only — no provider-side mail rule exists yet, so they could still reach other mail clients.`,
      };
    },
  },

  inbox_create_folder: {
    name: 'inbox_create_folder',
    description: 'Create a new durable filing folder (a real IMAP CREATE), NOW. Executes immediately on the user\'s command — no proposal, no separate approval.',
    input_schema: {
      type: 'object',
      properties: { accountId: { type: 'string' }, name: { type: 'string' } },
      required: ['accountId', 'name'],
    },
    execute: async (input, ctx) => {
      const { accountId, name } = input || {};
      if (!accountId) return { success: false, error: 'accountId is required' };
      if (!name) return { success: false, error: 'name is required' };
      const res = await _handlers.hCreateFolder(baseCtx(ctx, { body: { accountId, name } }), execDeps(ctx));
      if (res.status !== 200) return toToolResult(res);
      return { success: true, executed: true, folder: res.json.folder, result: `DONE: created folder ${name}.` };
    },
  },
};

module.exports = {
  INBOXQ_TOOLS,
  setInboxqToolsAuditFn,
  // exported for unit tests
  _internal: { freezeMessageIds, proposalSummary, proposeResult, toToolResult, baseCtx },
};
