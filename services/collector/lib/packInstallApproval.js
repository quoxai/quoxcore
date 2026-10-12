/**
 * packInstallApproval.js — DEVSUITE B′: one HITL approval per pack install.
 *
 * WHY: Bastion "risky" approval mode HITL-gates every SSH exec (403 unless the
 * caller presents a collector-signed X-Bastion-Approval-Grant). The skill-pack
 * installer used to call Bastion with no grant, so every install/update was
 * rejected fleet-wide (quox#608). A pack install is already heavily governed
 * (Ed25519-signed, verified, content-hashed, acceptance-gated), so demanding a
 * separate human approval for each of the ~35 install commands is unworkable.
 *
 * This folds the install into the EXISTING human-approval machinery with ONE
 * approval per install:
 *   - To START: mint a single kind='approval' inbox item (the auth POST dedups
 *     OPEN items on title+kind for 30 min, so repeated pre-approval syncs don't
 *     pile up duplicates). Return awaiting.
 *   - To RESUME after a human approves: the auth OPEN-item dedup deliberately
 *     does NOT match a RESOLVED item, so we cannot re-find the approved item by
 *     re-minting. Instead we QUERY the internal inbox for a RESOLVED approval
 *     carrying our stable `source` key, and mint a fresh grant per clause
 *     against it (mintApprovalGrant only succeeds for a resolved, non-deny,
 *     fresh item — so a successful mint IS the proof of approval).
 *
 * The `source` key is (host, packId, version) — deliberately NOT the content
 * hash, which is read live from the shared skills tree and can shift between
 * calls; a version-keyed source is stable across a given install's sync
 * re-runs. No new grant primitive, no auth change, no schema change.
 *
 * Contract: ensureApprovedInstallCallBastion() returns either
 *   { approved: false, itemId?, error? }   — caller returns awaiting_approval
 *   { approved: true, itemId, callBastion } — caller runs installSkillPack with it
 * It never throws; a mint/probe/query failure resolves to { approved:false }.
 */

'use strict';

const { mintInboxItem: defaultMintInboxItem } = require('./inboxMint.js');

const DEFAULT_TIMEOUT_MS = 10000;

// mintApprovalGrant lives on bastionSshExecutor's _internal (it signs a grant
// against an approved inbox item via the auth mint route). Loaded lazily +
// defensively so this module never hard-crashes if that surface moves.
function defaultMintApprovalGrant(args) {
  const mod = require('./bastionSshExecutor.js');
  const fn = mod && mod._internal && mod._internal.mintApprovalGrant;
  if (typeof fn !== 'function') return Promise.resolve(null);
  return fn(args);
}

function authBase() {
  return process.env.AUTH_SERVICE_URL
    || `http://${process.env.AUTH_HOST || 'quox-auth'}:${process.env.AUTH_PORT || '3101'}`;
}

// Query the internal inbox for RESOLVED approval items carrying our source key,
// newest first. Never throws — a query failure resolves to [] (⇒ awaiting).
async function defaultFindResolvedApprovalItemIds({ orgId, source }) {
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!orgId || !serviceKey) return [];
  const url = `${authBase()}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox/items`
    + `?kind=approval&status=resolved&source=${encodeURIComponent(source)}`;
  try {
    const res = await fetch(url, { headers: { 'x-service-key': serviceKey }, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data.items) ? data.items.map((i) => i && i.id).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// A harmless no-op command used only to probe whether an approval item is
// resolved+fresh (a successful mint means "approved"); its grant is discarded.
const PROBE_COMMAND = 'true';

/** Stable source key for the query + payload. (host, packId, version) — NOT the
 *  content hash, which is read live and can shift between calls. */
function sourceKey(hostId, pack) {
  return `devsuite_pack_install:${hostId}:${pack.packId}:${pack.version}`;
}

/** Stable, human-readable approval title (dedup key for OPEN items). Keyed on
 *  (host, pack, version) so a pre-approval re-sync dedups to the same item. */
function approvalTitle(hostId, pack) {
  return `Approve DevSuite pack ${pack.packId} v${pack.version} install on ${hostId}`;
}

function approvalBody(hostId, pack, contentHash, fileCount) {
  const filesPhrase = fileCount ? `${fileCount} pack files` : 'the pack files';
  return [
    `**${pack.packId} v${pack.version}** wants to install on **${hostId}**.`,
    '',
    `This writes ${filesPhrase} under \`~/.claude\` (skills, rules, and the`,
    'DevSuite runtime tools) and runs the settings wiring on the host. Every command',
    'is delivered over the governed Bastion path; approving this authorises the',
    'whole install as one unit (a fresh grant is minted per command against this',
    'approval).',
    '',
    ...(contentHash ? [`Pack content hash: \`${contentHash}\``, ''] : []),
    `Approve: \`quox inbox respond <itemId> --action approve\` (or the dashboard inbox).`,
  ].join('\n');
}

function makeGrantCallBastion(itemId, mintApprovalGrant, baseCallBastion) {
  return async (hid, command) => {
    const grant = await mintApprovalGrant({ itemId, action: 'exec', command, targets: [hid] });
    if (!grant) {
      return {
        success: false,
        error: `pack-install approval grant mint failed for item ${itemId} (approval may have expired mid-install; re-approve and retry)`,
      };
    }
    return baseCallBastion(hid, command, grant);
  };
}

/**
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.hostId
 * @param {object} args.pack            CORE_DEV_PACK (needs packId, version)
 * @param {string} [args.contentHash]   for the human-readable body only
 * @param {number} [args.fileCount]     for the human-readable body only
 * @param {Function} args.baseCallBastion  (hostId, command, grant) => result — the ungated executor
 * @param {Function} [args.mintInboxItem]             DI
 * @param {Function} [args.mintApprovalGrant]         DI
 * @param {Function} [args.findResolvedApprovalItemIds] DI: ({orgId, source}) => Promise<string[]>
 * @returns {Promise<{approved:boolean,itemId?:string,error?:string,callBastion?:Function}>}
 */
async function ensureApprovedInstallCallBastion(args) {
  const {
    orgId, hostId, pack, contentHash, fileCount,
    baseCallBastion,
    mintInboxItem = defaultMintInboxItem,
    mintApprovalGrant = defaultMintApprovalGrant,
    findResolvedApprovalItemIds = defaultFindResolvedApprovalItemIds,
  } = args || {};

  if (typeof baseCallBastion !== 'function') {
    return { approved: false, error: 'baseCallBastion is required' };
  }

  const source = sourceKey(hostId, pack);

  // 1. Already approved? Find RESOLVED approval items for this install and try
  //    to mint a grant against each (newest first). A successful mint proves
  //    the item is resolved, non-deny, and still fresh ⇒ authorised.
  let resolvedIds = [];
  try {
    resolvedIds = await findResolvedApprovalItemIds({ orgId, source });
  } catch {
    resolvedIds = [];
  }
  for (const itemId of resolvedIds) {
    const probe = await mintApprovalGrant({ itemId, action: 'exec', command: PROBE_COMMAND, targets: [hostId] });
    if (probe) {
      return { approved: true, itemId, callBastion: makeGrantCallBastion(itemId, mintApprovalGrant, baseCallBastion) };
    }
  }

  // 2. Not approved yet — ensure ONE open approval item exists (auth dedups
  //    open items on title+kind) and report awaiting.
  const mint = await mintInboxItem({
    orgId,
    title: approvalTitle(hostId, pack),
    bodyMd: approvalBody(hostId, pack, contentHash, fileCount),
    kind: 'approval',
    priority: 'normal',
    payload: {
      kind: 'devsuite_pack_install',
      source,
      hostId,
      packId: pack.packId,
      version: pack.version,
      contentHash: contentHash || null,
    },
  });
  if (!mint || !mint.ok || !mint.itemId) {
    return { approved: false, error: (mint && mint.error) || 'inbox_mint_failed' };
  }
  return { approved: false, itemId: mint.itemId };
}

module.exports = { ensureApprovedInstallCallBastion, approvalTitle, sourceKey, PROBE_COMMAND };
