'use strict';

/**
 * InboxQ daily tidy-up report generator.
 *
 * RECEIPT-BACKED: every number in the report is COUNTED from real rows in the
 * store, never estimated. The report cites message ids so a reader can expand
 * any claim back to the exact message (the "evidence-complete brief" innovation
 * from the AQ v4 plan). "We checked N messages" can never masquerade as
 * "nothing needs you".
 *
 * The report has four sections, in priority order:
 *   1. Needs you        — focus-zone mail asking for action / with a deadline
 *   2. Deadlines        — anything time-constrained, across all zones
 *   3. Misfiling gotchas — low-priority-zoned mail that carries an action signal
 *                          (the `review` flag), so a human double-checks it
 *   4. Certainties      — the bulk that is safe to skim/file (auto + fyi counts)
 *
 * Pure function over the store: buildReport() returns { bodyMd, counts, refs }.
 * Persisting it (saveReport) is the caller's job so the generator stays testable.
 */

// codex F07: subjects and senders come from attacker-controlled email and are
// interpolated into the report Markdown. The old esc() only stripped newlines,
// so a crafted subject like "[Trusted](https://evil/phish) ![x](https://evil/px)"
// became an active link + remote-image beacon in the persisted report. Strip all
// control chars and backslash-escape every Markdown/HTML active delimiter so the
// value renders as literal text in any conventional consumer.
function esc(s) {
  return (s || '')
    .toString()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '') // strip control chars
    .replace(/[\\`*_[\]()<>#!|~{}]/g, '\\$&')
    .trim();
}

function fmtSender(m) {
  const name = esc(m.fromName);
  const addr = esc(m.fromAddr);
  if (name && addr) return `${name} <${addr}>`;
  return addr || name || '(unknown sender)';
}

function line(m) {
  const subj = esc(m.subject) || '(no subject)';
  const tags = [];
  if ((m.flags || []).includes('has_deadline')) tags.push('⏰');
  if ((m.flags || []).includes('needs_action')) tags.push('✎');
  const tag = tags.length ? ` ${tags.join('')}` : '';
  return `- **${subj}**${tag} — ${fmtSender(m)}`;
}

/**
 * Build one structured-data section from a subset of gathered messages. Never
 * fabricates: an empty subset reports state:'empty' with zero items, never a
 * placeholder row. Items are capped at topN but `total` always carries the
 * true count so a consumer can render "showing N of total".
 */
function buildSection(id, title, subset, topN) {
  const total = subset.length;
  const items = subset.slice(0, topN).map((m) => ({
    id: m.id,
    fromName: m.fromName || null,
    fromAddr: m.fromAddr || null,
    subject: m.subject || null,
    dateTs: m.dateTs ?? null,
    zone: m.zone || null,
    snippet: m.snippet || null,
    flags: m.flags || [],
  }));
  return { id, title, state: total === 0 ? 'empty' : 'available', total, items };
}

/**
 * @param {object} opts
 * @param {object} opts.account   hydrated account { emailAddress, ... }
 * @param {object[]} opts.messages  hydrated message rows for this account
 * @param {string} [opts.reportDate]  ISO date (YYYY-MM-DD)
 * @param {number} [opts.topN=10]     max items to list per section
 * @returns {{ bodyMd:string, counts:object, refs:object, structured:object }}
 */
function buildReport({ account, messages = [], reportDate = null, topN = 10, totalStored = null }) {
  const date = reportDate || new Date().toISOString().slice(0, 10);
  const mailbox = account?.emailAddress || 'mailbox';
  // codex F11: if the caller sampled a bounded window, the report cannot honestly
  // claim a whole-inbox "clear". truncated => qualify the wording.
  const truncated = totalStored != null && totalStored > messages.length;

  const byZone = { focus: 0, fyi: 0, auto: 0, screened: 0, unclassified: 0 };
  for (const m of messages) byZone[m.zone || 'unclassified'] = (byZone[m.zone || 'unclassified'] || 0) + 1;

  const hasFlag = (m, f) => (m.flags || []).includes(f);

  const needsYou = messages.filter((m) => m.zone === 'focus' && (hasFlag(m, 'needs_action') || hasFlag(m, 'has_deadline')));
  const otherFocus = messages.filter((m) => m.zone === 'focus' && !needsYou.includes(m));
  const deadlines = messages.filter((m) => hasFlag(m, 'has_deadline'));
  const gotchas = messages.filter((m) => hasFlag(m, 'review')); // low-zone + action signal
  const autoCount = byZone.auto || 0;
  const fyiCount = byZone.fyi || 0;
  const screenedCount = byZone.screened || 0;

  const counts = {
    total: messages.length,
    byZone,
    needsAction: messages.filter((m) => hasFlag(m, 'needs_action')).length,
    deadlines: deadlines.length,
    review: gotchas.length,
    focusOther: otherFocus.length,
  };

  const refs = {
    needsYou: needsYou.map((m) => m.id),
    deadlines: deadlines.map((m) => m.id),
    gotchas: gotchas.map((m) => m.id),
  };

  const parts = [];
  parts.push(`# InboxQ daily tidy-up — ${mailbox}`);
  const coverage = truncated
    ? `${messages.length} of ${totalStored} stored messages sampled (most recent + all flagged)`
    : `${messages.length} messages reviewed`;
  parts.push(`_${date} · ${coverage} · every count below is drawn from your stored mail_`);
  parts.push('');

  // 1. Needs you
  parts.push(`## 🎯 Needs you (${needsYou.length})`);
  if (needsYou.length === 0) {
    parts.push(truncated
      ? '_No action-flagged mail in the sampled set. Coverage was truncated, so this is not a whole-inbox all-clear._'
      : '_Nothing in your focus zone is asking for action or carrying a deadline. Clear._');
  } else {
    parts.push(...needsYou.slice(0, topN).map(line));
    if (needsYou.length > topN) parts.push(`- …and ${needsYou.length - topN} more`);
  }
  parts.push('');

  // 2. Deadlines
  if (deadlines.length > 0) {
    parts.push(`## ⏰ Deadlines (${deadlines.length})`);
    parts.push(...deadlines.slice(0, topN).map(line));
    parts.push('');
  }

  // 3. Misfiling gotchas
  parts.push(`## 🔎 Double-check these (${gotchas.length})`);
  if (gotchas.length === 0) {
    parts.push('_No low-priority mail is hiding an action request. Nothing to re-check._');
  } else {
    parts.push('_These were filed as automated/newsletter/screened but ask for something — worth a glance in case they were mis-sorted:_');
    parts.push(...gotchas.slice(0, topN).map(line));
    if (gotchas.length > topN) parts.push(`- …and ${gotchas.length - topN} more`);
  }
  parts.push('');

  // 4. Certainties
  parts.push('## ✅ Safe to skim (certainties)');
  const certainties = [];
  if (autoCount) certainties.push(`${autoCount} automated (receipts, notifications, no-reply)`);
  if (fyiCount) certainties.push(`${fyiCount} newsletters / updates`);
  if (screenedCount) certainties.push(`${screenedCount} screened as spam-likely`);
  if (otherFocus.length) certainties.push(`${otherFocus.length} focus-zone with no explicit action`);
  parts.push(certainties.length ? `- ${certainties.join('\n- ')}` : '_Nothing filed away this cycle._');

  // Structured-data companion to bodyMd, built from the SAME gathered rows —
  // never re-queries an LLM, never fabricates a row. Additive: old consumers
  // keep reading bodyMd/counts unchanged; a later frontend pass renders this.
  const includedCount = messages.length;
  const knownTotal = totalStored != null ? totalStored : includedCount;
  const structured = {
    schemaVersion: 1,
    type: 'inboxq.daily-brief',
    mailbox: { accountId: account?.id || null, label: mailbox },
    generatedAt: new Date().toISOString(),
    period: { basis: 'stored_snapshot', label: 'Mailbox snapshot' },
    coverage: { included: includedCount, totalStored: knownTotal, complete: includedCount >= knownTotal },
    summary: [
      { id: 'action', label: 'Action signals', count: needsYou.length },
      { id: 'deadline', label: 'Deadline signals', count: deadlines.length },
      { id: 'review', label: 'Check classifications', count: gotchas.length },
    ],
    sections: [
      buildSection('action', 'Action signals', needsYou, topN),
      buildSection('deadline', 'Deadline signals', deadlines, topN),
      buildSection('review', 'Check these classifications', gotchas, topN),
    ],
  };

  return { bodyMd: parts.join('\n'), counts, refs, structured };
}

module.exports = { buildReport };
