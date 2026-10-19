'use strict';

/**
 * QUOX-SECURITY finding -> next-steps pipeline.
 *
 * The 5 capability tools and findings storage already turn a scan into a
 * durable record (securityFindings.js). This module is the layer on top:
 * turning a finding (or a whole engagement) into filed work.
 *
 *  - Raise issue: files a real GitHub issue via the collector's existing
 *    GitHub token-resolution chain (routes/github-proxy.js's
 *    getGitHubToken/ghFetch — vault -> config file -> env, never env-only,
 *    honouring the house "no env-only config" rule). If no token is
 *    configured, returns { configured: false } honestly, never a fake
 *    success.
 *  - Propose as QuoxPlan: appends a note to a QuoxPlan stream (default
 *    QUOX-SECURITY, #438, the stream this whole surface ships under) via
 *    the collector's OWN governed /api/v1/quoxplan/* proxy (server.js),
 *    the same boundary quoxplanTools.js's write tools use — that proxy is
 *    the only place quoxplan.* AEE evidence is emitted for a mutation, so
 *    a direct-to-QuoxPlan-server call would be unwitnessed.
 *  - Engagement report: assembles engagement + targets + findings into a
 *    printable HTML report and a real PDF (pdfkit, reusing the shared
 *    lib/pdf/pdfPrimitives.js visual language rather than inventing a new
 *    one). Not the compliance-PDF pipeline (lib/pdf/compliancePdfGenerator.js)
 *    — that pipeline signs a WARD manifest into report *metadata* specific
 *    to compliance formats (SoA/DPIA/framework); an engagement report has
 *    no such format, so this module drives PDFDocument + the primitives
 *    directly instead of stretching that pipeline to fit.
 *
 * Every exported function takes its collaborators as `deps` (db, the
 * GitHub token/fetch pair, the QuoxPlan note-writer) so this module is
 * fully unit-testable with GitHub and QuoxPlan mocked — see
 * test/securityReportActions.test.js.
 */

const PDFDocument = require('pdfkit');
const {
  MARGIN,
  PAGE_WIDTH,
  titlePage,
  sectionHeader,
  paragraph,
  evidenceTable,
  stampFooters,
} = require('./pdf/pdfPrimitives.js');
const securityFindings = require('./securityFindings.js');
const securityEngagement = require('./securityEngagement.js');

// ── Gripe (GitHub issue) ────────────────────────────────────────────────

// Findings live inside the dashboard's security-testing plugin
// (quox-security), so per the gripe skill's repo-keyword mapping
// (~/.claude/skills/gripe/SKILL.md: "dashboard, sidebar, panel, plugin,
// agent... -> quoxai/quox") this always files into quoxai/quox — there is
// no dedicated quox-security repo. A finding is, definitionally, a bug
// report ("Bug, broken thing, error, crash, fails -> fleet/qa" in the same
// mapping), so the label is fixed at fleet/qa regardless of the finding's
// candidate/confirmed/refuted status; severity does not change the label,
// only the issue body says how far along verification is.
const GRIPE_REPO = 'quoxai/quox';
const GRIPE_LABEL = 'fleet/qa';

function buildGripePayload({ finding, engagement }) {
  if (!finding) throw new Error('finding is required');
  const title = `[QUOX-SECURITY] ${finding.title}`.slice(0, 200);
  const verdictLine = finding.status === 'candidate'
    ? 'Not yet verified.'
    : `${finding.status.toUpperCase()}${finding.verdict_reason ? ` — ${finding.verdict_reason}` : ''}`;
  const body = [
    '## Security finding',
    finding.description || '(no description)',
    '',
    '## Details',
    `- Finding ID: ${finding.id}`,
    `- Severity: ${finding.severity}`,
    `- Status: ${finding.status}`,
    `- Target: ${finding.target_value}`,
    `- Engagement: ${engagement ? `${engagement.id} (${engagement.name})` : finding.engagement_id}`,
    `- Verdict: ${verdictLine}`,
    '',
    '---',
    'Filed via QUOX-SECURITY (Raise as Gripe).',
  ].join('\n');
  // Per-engagement override: a customer-site engagement files into its own
  // repo (engagement.gripe_repo), falling back to the platform default when
  // unset. See migration 008-engagement-gripe-target.sql.
  const repo = (engagement && engagement.gripe_repo) || GRIPE_REPO;
  return { repo, title, body, labels: [GRIPE_LABEL] };
}

/**
 * Files a real GitHub issue for a finding ("Raise issue"). Honest fail-soft
 * in two distinct ways:
 *  - No GitHub token resolvable anywhere in the chain -> { configured: false }.
 *  - A token IS configured but GitHub rejects it (401/403, expired/invalid
 *    token) -> { configured: true, ok: false, reason: 'auth', message } —
 *    the raw GitHub API error body is never surfaced to the caller.
 * Dedup: a finding that already has a gripe_url is never re-filed; the
 * finding is reloaded from storage first (authoritative, not whatever the
 * caller happened to pass in) so a stale in-memory `finding` can't cause a
 * duplicate GitHub issue.
 *
 * @param {object} args - { finding, engagement, orgId }
 * @param {object} deps - { db, getGitHubToken, ghFetch }
 */
async function fileGripeForFinding({ finding, engagement, orgId }, deps) {
  const { db, getGitHubToken, ghFetch } = deps;
  if (!finding) throw new Error('finding is required');
  if (typeof getGitHubToken !== 'function' || typeof ghFetch !== 'function') {
    throw new Error('fileGripeForFinding requires deps.getGitHubToken and deps.ghFetch');
  }

  let current = finding;
  if (db && finding.id) {
    const fresh = securityFindings.getFinding(finding.id, orgId, { db });
    if (fresh) current = fresh;
  }
  if (current.gripe_url) {
    return { configured: true, ok: true, alreadyFiled: true, url: current.gripe_url };
  }

  // Per-engagement override: a customer-site engagement resolves its token
  // from the CUSTOMER org's connector (engagement.gripe_connector_org_id),
  // not the engagement's own org. Falls back to the engagement org when
  // unset. See migration 008-engagement-gripe-target.sql.
  const tokenOrg = (engagement && engagement.gripe_connector_org_id) || orgId || null;
  const { token } = await getGitHubToken(tokenOrg);
  if (!token) {
    return {
      configured: false,
      message: 'GitHub not configured. Complete setup via the GitHub plugin (Settings > Integrations > GitHub).',
    };
  }

  const { repo, title, body, labels } = buildGripePayload({ finding: current, engagement });
  const [owner, repoName] = repo.split('/');

  // Best-effort label creation, same courtesy the gripe skill extends —
  // GitHub's issue-create API will auto-create an unknown label on most
  // repos, but this makes the intent explicit and never blocks filing.
  try {
    await ghFetch(`/repos/${owner}/${repoName}/labels`, token, {
      method: 'POST',
      body: JSON.stringify({ name: GRIPE_LABEL, color: 'c5def5', description: 'Filed by QUOX-SECURITY' }),
    });
  } catch { /* label likely already exists — non-fatal either way */ }

  let data;
  try {
    ({ data } = await ghFetch(`/repos/${owner}/${repoName}/issues`, token, {
      method: 'POST',
      body: JSON.stringify({ title, body, labels }),
    }));
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      return {
        configured: true,
        ok: false,
        reason: 'auth',
        message: 'GitHub connection rejected (the stored token is invalid or expired). Reconnect it in Settings > GitHub.',
      };
    }
    throw err;
  }

  const gripeUrl = data.html_url;
  if (db) {
    securityFindings.setFindingGripeUrl(current.id, orgId, gripeUrl, { db });
  }

  return { configured: true, ok: true, url: gripeUrl, number: data.number, repo };
}

// A gripe_url looks like https://github.com/OWNER/REPO/issues/NUMBER. Anything
// that does not match that shape (a pull-request URL, a hand-typed note, a
// non-GitHub link) is skipped rather than treated as an error.
const GITHUB_ISSUE_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/;

function parseGithubIssueUrl(url) {
  if (!url) return null;
  const m = String(url).match(GITHUB_ISSUE_URL_RE);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: m[3] };
}

/**
 * Best-effort sync of GitHub issue states onto an engagement's findings. For
 * every finding that was filed as a GitHub issue and is still open work
 * (status not resolved/refuted), this reads the issue's current state and,
 * when the issue has been closed, marks the finding resolved. Fail-soft: no
 * token short-circuits to { configured: false }, and a per-finding GitHub
 * error (404, auth) is recorded and skipped, never allowed to abort the run
 * (same discipline as fileGripeForFinding).
 *
 * @param {object} args - { engagementId, orgId }
 * @param {object} deps - { db, getGitHubToken, ghFetch }
 * @returns {Promise<{configured:boolean, checked?:number, resolved?:string[], errors?:Array, message?:string}>}
 */
async function syncFindingIssueStates({ engagementId, orgId }, deps) {
  const { db, getGitHubToken, ghFetch } = deps;
  if (typeof getGitHubToken !== 'function' || typeof ghFetch !== 'function') {
    throw new Error('syncFindingIssueStates requires deps.getGitHubToken and deps.ghFetch');
  }

  // Read the issue state with the same org token that FILED it: a customer-site
  // engagement whose gripe_connector_org_id points at the customer org filed
  // the issue with that org's token, and a private customer repo can only be
  // read back with that same token, not the engagement's own org token.
  let tokenOrg = orgId;
  try {
    const engagement = securityEngagement.getEngagement(engagementId, orgId, { db });
    if (engagement && engagement.gripe_connector_org_id) tokenOrg = engagement.gripe_connector_org_id;
  } catch {
    tokenOrg = orgId;
  }

  const findings = securityFindings.listFindings(engagementId, orgId, { db })
    .filter((f) => f.gripe_url && f.status !== 'resolved' && f.status !== 'refuted')
    .map((f) => ({ finding: f, parsed: parseGithubIssueUrl(f.gripe_url) }))
    .filter((x) => x.parsed !== null);

  if (findings.length === 0) {
    // Nothing to check — but still report configured honestly. Only resolve
    // the token when there is at least a candidate to look up, to avoid a
    // pointless auth round-trip.
    const { token } = await getGitHubToken(tokenOrg || null);
    if (!token) return { configured: false, message: 'GitHub not configured' };
    return { configured: true, checked: 0, resolved: [], errors: [] };
  }

  const { token } = await getGitHubToken(tokenOrg || null);
  if (!token) return { configured: false, message: 'GitHub not configured' };

  const resolved = [];
  const errors = [];
  let checked = 0;

  for (const { finding, parsed } of findings) {
    checked += 1;
    try {
      const { data } = await ghFetch(`/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`, token, {});
      const state = data && data.state ? data.state : null;
      securityFindings.setFindingIssueState(finding.id, orgId, state, { db });
      if (state === 'closed') {
        securityFindings.resolveFinding(finding.id, orgId, { reason: 'GitHub issue closed' }, { db });
        resolved.push(finding.id);
      }
    } catch (err) {
      errors.push({ findingId: finding.id, reason: err && err.status ? `github ${err.status}` : 'github error' });
    }
  }

  return { configured: true, checked, resolved, errors };
}

// ── QuoxPlan proposal ───────────────────────────────────────────────────

const DEFAULT_QUOXPLAN_STREAM = 'QUOX-SECURITY';

function buildQuoxplanNoteBody({ finding, engagement }) {
  if (!finding) throw new Error('finding is required');
  const lines = [
    `Security finding proposed for follow-up: ${finding.title}`,
    `Finding ${finding.id} | severity ${finding.severity} | status ${finding.status}`,
    `Target: ${finding.target_value} | Engagement: ${engagement ? `${engagement.id} (${engagement.name})` : finding.engagement_id}`,
    '',
    finding.description || '(no description)',
  ];
  return lines.join('\n');
}

/**
 * Proposes a finding as a QuoxPlan note (default stream: QUOX-SECURITY).
 * Honest fail-soft: if the stream doesn't exist or the governed proxy is
 * unreachable, the writeNote error propagates as a readable message
 * (never a fabricated ref).
 *
 * @param {object} args - { finding, engagement, orgId, streamId }
 * @param {object} deps - { db, writeNote }  writeNote(streamId, body, ctx) -> note {id, body, author, created_at}
 */
async function proposeQuoxplanForFinding({ finding, engagement, orgId, streamId }, deps) {
  const { db, writeNote } = deps;
  if (!finding) throw new Error('finding is required');
  if (typeof writeNote !== 'function') throw new Error('proposeQuoxplanForFinding requires deps.writeNote');

  const targetStream = streamId || DEFAULT_QUOXPLAN_STREAM;
  const body = buildQuoxplanNoteBody({ finding, engagement });
  const note = await writeNote(targetStream, body, { orgId });

  const ref = `/quoxplan/streams/${encodeURIComponent(targetStream)}`;
  if (db) {
    securityFindings.setFindingQuoxplanRef(finding.id, orgId, ref, { db });
  }

  return { streamId: targetStream, ref, note };
}

// #1073: an unavailable QuoxPlan must reach the caller as a 5xx with the proxy's wording, so the
// CLI says PLUGIN_SERVICE_UNAVAILABLE (#1012) instead of a 400 that reads as a malformed request.
const QUOXPLAN_UNAVAILABLE = 'QuoxPlan service unavailable';

function quoxplanNoteError(status, json) {
  if (status >= 500) {
    const err = new Error(QUOXPLAN_UNAVAILABLE);
    err.httpStatus = status === 503 ? 503 : 502;
    return err;
  }
  const detail = json && json.error ? json.error : String(status);
  return new Error(`QuoxPlan rejected the note (${status}): ${detail}`);
}

function quoxplanUnreachableError(message) {
  const err = new Error(QUOXPLAN_UNAVAILABLE);
  err.httpStatus = 502;
  err.cause_message = message;
  return err;
}

function proposeErrorResponse(err) {
  const status = err && err.httpStatus ? err.httpStatus : 400;
  return { status, body: { success: false, error: (err && err.message) || 'propose failed' } };
}

// ── Engagement report (HTML + PDF) ──────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function severityRank(sev) {
  return ['info', 'low', 'medium', 'high', 'critical'].indexOf(sev);
}

/**
 * Assembles printable HTML for an engagement report — targets, tools run
 * (scan jobs, if provided), and findings with severity/status/verdict.
 * This is the shared content model both the HTML download and the PDF
 * renderer draw from, so the two can never drift out of sync.
 */
function buildEngagementReportHtml({ engagement, targets = [], findings = [], jobs = [] }) {
  if (!engagement) throw new Error('engagement is required');
  const sortedFindings = [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const generatedAt = new Date().toISOString();

  const targetRows = targets.map((t) => `
    <tr><td>${escapeHtml(t.type)}</td><td>${escapeHtml(t.value)}</td><td>${escapeHtml(t.verification_status)}</td></tr>
  `).join('');

  const jobRows = jobs.map((j) => `
    <tr><td>${escapeHtml(j.tool)}</td><td>${escapeHtml(j.target)}</td><td>${escapeHtml(j.status)}</td><td>${escapeHtml(j.created_at)}</td></tr>
  `).join('');

  const findingRows = sortedFindings.map((f) => `
    <tr>
      <td>${escapeHtml(f.title)}</td>
      <td><span class="sev sev-${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span></td>
      <td>${escapeHtml(f.status)}</td>
      <td>${escapeHtml(f.target_value)}</td>
      <td>${escapeHtml(f.description)}</td>
      <td>${f.status === 'candidate' ? '—' : escapeHtml(f.verdict_reason || '')}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Quox Security Engagement Report — ${escapeHtml(engagement.name)}</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #0a0a12; margin: 40px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 15px; margin-top: 32px; border-bottom: 1px solid #d9d9e0; padding-bottom: 6px; }
  .meta { color: #555; font-size: 12px; margin-bottom: 24px; }
  .meta div { margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  th { text-align: left; background: #f4f2ff; color: #6b4bf0; text-transform: uppercase; font-size: 10px; padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  .sev { font-weight: bold; padding: 2px 6px; border-radius: 3px; font-size: 10px; text-transform: uppercase; }
  .sev-critical, .sev-high { background: #fce8e8; color: #a81e1e; }
  .sev-medium { background: #faf0d9; color: #9a6b00; }
  .sev-low, .sev-info { background: #e7f6ec; color: #127a3b; }
  .empty { color: #999; font-style: italic; font-size: 12px; }
</style>
</head>
<body>
  <h1>Quox Security Engagement Report</h1>
  <div class="meta">
    <div><strong>${escapeHtml(engagement.name)}</strong> (${escapeHtml(engagement.id)})</div>
    <div>Environment: ${escapeHtml(engagement.environment_tier)} · Risk ceiling: ${escapeHtml(engagement.risk_ceiling)} · Status: ${escapeHtml(engagement.status)}</div>
    <div>Generated: ${generatedAt}</div>
  </div>

  <h2>Targets (${targets.length})</h2>
  ${targets.length ? `<table><thead><tr><th>Type</th><th>Value</th><th>Verification</th></tr></thead><tbody>${targetRows}</tbody></table>` : '<p class="empty">No targets added.</p>'}

  <h2>Tools run (${jobs.length})</h2>
  ${jobs.length ? `<table><thead><tr><th>Tool</th><th>Target</th><th>Status</th><th>Started</th></tr></thead><tbody>${jobRows}</tbody></table>` : '<p class="empty">No scan jobs recorded.</p>'}

  <h2>Findings (${findings.length})</h2>
  ${findings.length ? `<table><thead><tr><th>Title</th><th>Severity</th><th>Status</th><th>Target</th><th>Description</th><th>Verdict</th></tr></thead><tbody>${findingRows}</tbody></table>` : '<p class="empty">No findings reported.</p>'}
</body>
</html>`;
}

/**
 * Renders the same content model as buildEngagementReportHtml into a real
 * PDF using pdfkit + the shared lib/pdf/pdfPrimitives.js visual language
 * (titlePage/sectionHeader/paragraph/evidenceTable — the same building
 * blocks the compliance PDFs use, so the report looks like it belongs to
 * the same product rather than a one-off).
 *
 * @returns {Promise<{ bytes: Buffer, pageCount: number }>}
 */
function generateEngagementReportPdf({ engagement, targets = [], findings = [], jobs = [] }) {
  if (!engagement) throw new Error('engagement is required');
  const sortedFindings = [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,
      info: {
        Title: `Quox Security Engagement Report — ${engagement.name}`,
        Author: 'Quox Collector',
        Subject: `QUOX-SECURITY engagement report — ${engagement.id}`,
        Creator: 'Quox Security Report Actions',
      },
    });

    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    let capturedPageCount = 0;
    doc.on('end', () => {
      resolve({ bytes: Buffer.concat(chunks), pageCount: capturedPageCount });
    });

    try {
      titlePage(doc, {
        title: engagement.name,
        subtitle: 'QUOX-SECURITY engagement report',
        framework: `${engagement.environment_tier} / risk ceiling ${engagement.risk_ceiling}`,
        period: engagement.id,
        generatedAt: new Date().toISOString(),
        orgLabel: engagement.org_id,
      });

      doc.addPage();

      sectionHeader(doc, { heading: `Targets (${targets.length})`, caption: 'Scope this engagement is authorized against.' });
      if (targets.length) {
        evidenceTable(doc, {
          columns: [
            { key: 'type', label: 'Type', width: 0.2 },
            { key: 'value', label: 'Value', width: 0.45 },
            { key: 'verification_status', label: 'Verification', width: 0.35 },
          ],
          rows: targets,
        });
      } else {
        paragraph(doc, 'No targets added.', { colour: '#999' });
      }

      sectionHeader(doc, { heading: `Tools run (${jobs.length})`, caption: 'Async capability-tool jobs recorded against this engagement.' });
      if (jobs.length) {
        evidenceTable(doc, {
          columns: [
            { key: 'tool', label: 'Tool', width: 0.25 },
            { key: 'target', label: 'Target', width: 0.3 },
            { key: 'status', label: 'Status', width: 0.2 },
            { key: 'created_at', label: 'Started', width: 0.25 },
          ],
          rows: jobs,
        });
      } else {
        paragraph(doc, 'No scan jobs recorded.', { colour: '#999' });
      }

      sectionHeader(doc, { heading: `Findings (${findings.length})`, caption: 'Sorted by severity, highest first.' });
      if (sortedFindings.length) {
        evidenceTable(doc, {
          columns: [
            { key: 'title', label: 'Title', width: 0.22 },
            { key: 'severity', label: 'Severity', width: 0.1 },
            { key: 'status', label: 'Status', width: 0.12 },
            { key: 'target_value', label: 'Target', width: 0.18 },
            { key: 'description', label: 'Description', width: 0.38, render: (r) => r.description || '' },
          ],
          rows: sortedFindings,
        });
      } else {
        paragraph(doc, 'No findings reported.', { colour: '#999' });
      }

      stampFooters(doc, { manifestHash: '' });
      // Capture before end() — the buffered-page array is cleared on
      // finalize (same gotcha compliancePdfGenerator.js's renderToBuffer
      // documents).
      capturedPageCount = doc.bufferedPageRange().count;
    } catch (err) {
      return reject(err);
    }
    doc.end();
  });
}

module.exports = {
  GRIPE_REPO,
  GRIPE_LABEL,
  DEFAULT_QUOXPLAN_STREAM,
  buildGripePayload,
  fileGripeForFinding,
  parseGithubIssueUrl,
  syncFindingIssueStates,
  buildQuoxplanNoteBody,
  proposeQuoxplanForFinding,
  quoxplanNoteError,
  quoxplanUnreachableError,
  proposeErrorResponse,
  buildEngagementReportHtml,
  generateEngagementReportPdf,
};
