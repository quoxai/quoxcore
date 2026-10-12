/**
 * QuoxSEO Report Delivery — on-demand governed send (QUOXSEO S2 follow-up).
 *
 * Fetches the QuoxSEO report SUMMARY (verdict + KPIs + ranked actions, the
 * single source of truth shared with the HTML report — GET /api/v1/report
 * ?format=summary) for one org, then fans a clean, self-contained digest out
 * to the requested channels: email (via the collector's native
 * notificationService, which resolves the org/instance SMTP itself) and the
 * org's HITL inbox (auth service internal API).
 *
 * The email driver is plain-text only (no HTML/attachments — see
 * lib/channels/drivers/email.js), so we deliberately send a readable text
 * digest, NOT a dump of the report HTML. The full witnessed report lives at
 * the served endpoint / dashboard; a viewer link + PDF attachment is a
 * follow-up once an authed viewer + attachment-capable driver exist.
 *
 * Deliberately NOT a scheduler — this is called on-demand from a collector
 * route. A recurring/cron delivery is a separate follow-up (the scheduler
 * triad — failure accounting, backoff, retirement — applies there, not here).
 *
 * Each channel is independently try/caught so a failing channel never blocks
 * the other, but a failure is always surfaced in the returned summary (never
 * swallowed to null/success — silent-fallback-can-assert-a-falsehood).
 */

'use strict';

const notificationService = require('./notificationService.js');

const DEFAULT_QUOXSEO_URL = 'http://quoxseo:3110';

function formatKpis(kpis = {}) {
  const rows = [];
  const nf = (v) => (v == null ? '-' : Number(v).toLocaleString('en-GB'));
  if (kpis.urls_witnessed != null) rows.push(`  • ${nf(kpis.urls_witnessed)} URLs witnessed`);
  // Honest content-based GEO figure (audit #4): pages hiding their main content
  // behind JavaScript, over the pages tested. Falls back to the retired
  // blind-share field only if an older warehouse is still serving it.
  if (kpis.ai_content_blind_pages != null && kpis.ai_pages_tested != null) rows.push(`  • ${nf(kpis.ai_content_blind_pages)} of ${nf(kpis.ai_pages_tested)} tested pages hide their main content from AI crawlers until JavaScript runs`);
  else if (kpis.ai_blind_share_pct != null) rows.push(`  • ${kpis.ai_blind_share_pct}% AI-crawler visits land on JavaScript-dependent pages`);
  if (kpis.ai_share_of_bots_pct != null) rows.push(`  • ${kpis.ai_share_of_bots_pct}% of crawl traffic is AI engines`);
  if (kpis.zero_click_share_pct != null) rows.push(`  • ${kpis.zero_click_share_pct}% of impressions come from queries with zero clicks`);
  if (kpis.competitor_gap_keywords != null) rows.push(`  • ${nf(kpis.competitor_gap_keywords)} competitor gap keywords`);
  return rows.join('\n');
}

function buildEmailBody(s) {
  const lines = [
    `Your QuoxSEO report for ${s.host} is ready${s.crawl_id != null ? ` (witnessed crawl #${s.crawl_id})` : ''}.`,
    '',
    s.verdict,
    '',
    'At a glance:',
    formatKpis(s.kpis),
  ];
  if (Array.isArray(s.actions) && s.actions.length) {
    lines.push('', 'Recommended next actions (ranked by impact):');
    s.actions.slice(0, 4).forEach((a, i) => {
      lines.push(`  ${i + 1}. ${a.title}`, `     ${a.why}`);
    });
  }
  lines.push(
    '',
    'Every figure above is read from a WARD-witnessed crawl, tamper-evident by default.',
    '',
    'Sent by QuoxSEO',
  );
  return lines.join('\n');
}

// --- branded HTML email --------------------------------------------------
// A self-contained, email-client-safe HTML version of the same digest (same
// verdict + KPIs + ranked actions as the plain-text body, which stays the
// fallback). Inline styles only, table layout, light theme to match the
// print-first report. The footer carries the subscription notice and the
// self-hosted disclaimer (owner rule 2026-10-06): this instance generated and
// sent the report, Quox Ltd did not.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function kpiRowsHtml(kpis = {}) {
  const nf = (v) => (v == null ? '-' : Number(v).toLocaleString('en-GB'));
  const rows = [];
  const row = (label, val) => rows.push(
    `<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;color:#334155;font-size:14px;line-height:1.45">${label}</td>`
    + `<td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:14px;font-weight:600;text-align:right;white-space:nowrap">${val}</td></tr>`
  );
  if (kpis.urls_witnessed != null) row('URLs witnessed', nf(kpis.urls_witnessed));
  if (kpis.ai_content_blind_pages != null && kpis.ai_pages_tested != null) row('Pages hiding main content from AI crawlers until JavaScript runs', `${nf(kpis.ai_content_blind_pages)} of ${nf(kpis.ai_pages_tested)}`);
  else if (kpis.ai_blind_share_pct != null) row('AI-crawler visits landing on JavaScript-dependent pages', `${esc(kpis.ai_blind_share_pct)}%`);
  if (kpis.ai_share_of_bots_pct != null) row('Share of crawl traffic that is AI engines', `${esc(kpis.ai_share_of_bots_pct)}%`);
  if (kpis.zero_click_share_pct != null) row('Impressions from zero-click queries', `${esc(kpis.zero_click_share_pct)}%`);
  if (kpis.competitor_gap_keywords != null) row('Competitor gap keywords', nf(kpis.competitor_gap_keywords));
  return rows.join('');
}

function buildEmailHtml(s, { logoUrl = 'https://quox.ai/apple-touch-icon.png', reportUrl = 'https://quox.ai' } = {}) {
  const host = esc(s.host);
  const crawlBit = s.crawl_id != null ? ` &middot; witnessed crawl #${esc(s.crawl_id)}` : '';
  const kpis = kpiRowsHtml(s.kpis);
  const actions = (Array.isArray(s.actions) ? s.actions.slice(0, 4) : []).map((a, i) => `
      <tr>
        <td valign="top" style="padding:12px 0 12px 0;width:30px"><div style="width:24px;height:24px;border-radius:50%;background:#0284c7;color:#ffffff;font-size:13px;font-weight:700;text-align:center;line-height:24px">${i + 1}</div></td>
        <td style="padding:12px 0 12px 10px;border-bottom:1px solid #eef2f7">
          <div style="color:#0f172a;font-size:14px;font-weight:600;line-height:1.4">${esc(a.title)}</div>
          <div style="color:#475569;font-size:13px;line-height:1.5;margin-top:3px">${esc(a.why)}</div>
        </td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QuoxSEO report for ${host}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <tr><td style="background:#0b1220;padding:18px 22px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="middle" style="width:38px"><img src="${esc(logoUrl)}" width="34" height="34" alt="Quox" style="display:block;border:0;border-radius:8px"></td>
        <td valign="middle" style="padding-left:12px">
          <div style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:.2px">QuoxSEO report</div>
          <div style="color:#7dd3fc;font-size:12px;margin-top:2px">${host}${crawlBit}</div>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:24px 22px 8px 22px">
      <p style="margin:0 0 14px 0;color:#0f172a;font-size:16px;line-height:1.5;font-weight:600">${esc(s.verdict)}</p>
      ${kpis ? `<p style="margin:18px 0 8px 0;color:#64748b;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">At a glance</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;border-collapse:separate">${kpis}</table>` : ''}
      ${actions ? `<p style="margin:22px 0 4px 0;color:#64748b;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Recommended next actions</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${actions}</table>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px"><tr>
        <td style="background:#ecfeff;border:1px solid #a5f3fc;border-radius:10px;padding:12px 14px;color:#155e75;font-size:13px;line-height:1.5">Every figure above is read from a WARD-witnessed crawl, tamper-evident by default. The full branded report is attached as a PDF.</td>
      </tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr><td align="center">
        <a href="${esc(reportUrl)}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:9px">Open quox.ai</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:18px 22px 24px 22px">
      <hr style="border:0;border-top:1px solid #e2e8f0;margin:0 0 14px 0">
      <p style="margin:0 0 8px 0;color:#94a3b8;font-size:11px;line-height:1.55">You are receiving this email because this address is subscribed to QuoxSEO reports for <strong style="color:#64748b">${host}</strong>.</p>
      <p style="margin:0 0 8px 0;color:#94a3b8;font-size:11px;line-height:1.55"><strong style="color:#64748b">Please note:</strong> Quox is a self-hosted solution. This report was generated and distributed by the Quox instance operating at ${host}, not by Quox Ltd. Quox Ltd has no access to this data and does not send, store, or process this report.</p>
      <p style="margin:0;color:#cbd5e1;font-size:11px;line-height:1.55">Sent by QuoxSEO, the witnessed SEO warehouse. &copy; ${new Date().getFullYear()} the operator of ${host}. Quox and QuoxSEO are product names of Quox Ltd, used by this self-hosted instance under licence.</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function buildInboxMarkdown(s) {
  const nf = (v) => (v == null ? '-' : Number(v).toLocaleString('en-GB'));
  const geoBit = (s.kpis?.ai_content_blind_pages != null && s.kpis?.ai_pages_tested != null)
    ? `${nf(s.kpis.ai_content_blind_pages)}/${nf(s.kpis.ai_pages_tested)} pages AI-content-blind`
    : (s.kpis?.ai_blind_share_pct != null ? `${s.kpis.ai_blind_share_pct}% AI-blind visits` : 'GEO n/a');
  const lines = [
    `**${s.verdict}**`,
    '',
    `Witnessed crawl #${s.crawl_id ?? '-'} · ${nf(s.kpis?.urls_witnessed)} URLs · ${geoBit} · ${s.kpis?.zero_click_share_pct ?? '-'}% zero-click`,
  ];
  if (Array.isArray(s.actions) && s.actions.length) {
    lines.push('', '**Recommended next actions:**');
    s.actions.slice(0, 4).forEach((a, i) => lines.push(`${i + 1}. **${a.title}**: ${a.why}`));
  }
  return lines.join('\n');
}

/**
 * @param {object} opts
 * @param {string} opts.orgId - org to scope the report + inbox item to
 * @param {string} [opts.recipientEmail] - required if 'email' is in channels
 * @param {string[]} [opts.channels=['email','inbox']]
 * @param {string} opts.authServiceUrl - base URL of the auth service (for the inbox POST)
 * @param {string} opts.internalServiceKey - shared service key for the inbox POST
 * @param {string} [opts.quoxseoUrl] - defaults to env QUOXSEO_URL or the in-cluster default
 * @returns {Promise<{ report: object, email: object|null, inbox: object|null }>}
 */
async function deliverQuoxseoReport({
  orgId,
  recipientEmail,
  channels = ['email', 'inbox'],
  authServiceUrl,
  internalServiceKey,
  quoxseoUrl,
  siteId,
  requireData = false,
} = {}) {
  if (!orgId) throw new Error('deliverQuoxseoReport: orgId is required');

  const seoUrl = quoxseoUrl || process.env.QUOXSEO_URL || DEFAULT_QUOXSEO_URL;
  const siteQ = siteId != null ? `&site_id=${encodeURIComponent(siteId)}` : '';

  // Report summary — one source of truth with the HTML report's verdict +
  // actions. A non-2xx here is a hard failure: an error body is not data
  // (house rule); never deliver a stale/empty digest as if it were real.
  const resp = await fetch(`${seoUrl}/api/v1/report?format=summary${siteQ}`, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Quoxseo-Org': orgId },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    throw new Error(`QuoxSEO report summary fetch failed: ${resp.status}`);
  }
  const report = await resp.json();

  const out = { report: { host: report.host, crawl_id: report.crawl_id, report_id: report.report_id ?? null }, report_id: report.report_id ?? null, unavailable: report.unavailable === true, email: null, inbox: null, pdf_attached: false };

  // P-E/P-H: never DELIVER a report the warehouse could not populate. A
  // scheduled run (requireData) that finds no core data returns skipped so the
  // scheduler records it as 'empty' (no-progress), never spams a hollow email.
  if (requireData && report.unavailable === true) {
    out.skipped = 'no_data';
    return out;
  }

  // Full branded PDF, fetched only when we are going to email it. Best-effort:
  // a PDF failure degrades to a summary-only email rather than blocking the
  // send (the digest still carries the verdict + actions).
  let pdfBuffer = null;
  if (channels.includes('email')) {
    try {
      const pdfResp = await fetch(`${seoUrl}/api/v1/report?format=pdf${siteQ}`, {
        method: 'GET',
        headers: { Accept: 'application/pdf', 'X-Quoxseo-Org': orgId },
        signal: AbortSignal.timeout(60000),
      });
      if (pdfResp.ok) {
        const ab = await pdfResp.arrayBuffer();
        if (ab && ab.byteLength > 1000) { pdfBuffer = Buffer.from(ab); out.pdf_attached = true; }
      } else {
        console.warn(`[QuoxSEO report] PDF fetch non-2xx ${pdfResp.status} (non-fatal, summary-only email)`);
      }
    } catch (pdfErr) {
      console.warn('[QuoxSEO report] PDF fetch failed (non-fatal, summary-only email):', pdfErr.message);
    }
  }

  if (channels.includes('email')) {
    try {
      if (!recipientEmail) throw new Error('recipientEmail is required to deliver the email channel');
      const emailResult = await notificationService.sendNotification({
        channel: 'email',
        recipient: recipientEmail,
        title: `QuoxSEO report for ${report.host}`,
        message: buildEmailBody(report),
        html: buildEmailHtml(report),
        priority: 'normal',
        orgId,
        attachments: pdfBuffer
          ? [{ filename: `quoxseo-report-${report.host}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
          : undefined,
      });
      out.email = emailResult;
    } catch (emailErr) {
      out.email = { success: false, error: emailErr.message };
    }
  }

  if (channels.includes('inbox')) {
    try {
      if (!authServiceUrl) throw new Error('authServiceUrl is required to deliver the inbox channel');
      if (!internalServiceKey) throw new Error('internalServiceKey is required to deliver the inbox channel');

      const inboxResp = await fetch(`${authServiceUrl}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-service-key': internalServiceKey },
        body: JSON.stringify({
          title: `QuoxSEO report for ${report.host}`,
          body_md: buildInboxMarkdown(report),
          kind: 'info',
          priority: 'normal',
          payload: { source: 'quoxseo', action: 'report', crawl_id: report.crawl_id },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!inboxResp.ok) {
        const text = await inboxResp.text().catch(() => '');
        throw new Error(`Inbox API returned ${inboxResp.status}: ${text}`);
      }
      const body = await inboxResp.json();
      // The auth route returns the id nested under `item` on create (201) and
      // under `existing_item_id` on a dedup (200). Reading only `body.id` was
      // the inbox.id-null bug (codex #9): the id was there, just nested.
      out.inbox = { id: body.item?.id || body.existing_item_id || body.id || null };
      if (body.deduplicated) out.inbox.deduplicated = true;
    } catch (inboxErr) {
      out.inbox = { id: null, error: inboxErr.message };
    }
  }

  return out;
}

module.exports = { deliverQuoxseoReport, buildEmailBody, buildInboxMarkdown };
