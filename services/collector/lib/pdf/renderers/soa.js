/**
 * AUD-PDF Phase 1: Statement of Applicability renderer
 *
 * Input: a row from `soa_assessments` (org_id, framework, version,
 * status, controls_json). The controls_json is an array of:
 *
 *   { id, name, applicability, justification, implementation_status,
 *     owner?, evidence? }
 *
 * The SoA is the first thing an ISO auditor asks for — a signed PDF
 * version replaces the spreadsheet-via-email workflow most orgs use
 * today.
 */

const {
  titlePage,
  sectionHeader,
  paragraph,
  evidenceTable,
} = require('../pdfPrimitives.js');

const FRAMEWORK_LABELS = {
  iso27001_2022: 'ISO/IEC 27001:2022',
  iso42001: 'ISO/IEC 42001:2023',
  soc2: 'SOC 2',
};

function renderSoA(doc, soa, options = {}) {
  const { orgLabel } = options;
  const label = FRAMEWORK_LABELS[soa.framework] || soa.framework;
  const controls = Array.isArray(soa.controls_json)
    ? soa.controls_json
    : (() => { try { return JSON.parse(soa.controls_json || '[]'); } catch { return []; } })();

  titlePage(doc, {
    title: 'Statement of Applicability',
    subtitle: label,
    framework: label,
    period: `SoA v${soa.version || 1} — ${soa.status || 'draft'}`,
    generatedAt: soa.updated_at || new Date().toISOString(),
    orgLabel: orgLabel || '—',
  });

  doc.addPage();
  sectionHeader(doc, {
    heading: 'Scope',
    caption: 'Controls in scope for this assessment',
  });
  paragraph(
    doc,
    `This Statement of Applicability records the applicability decision and implementation status for every ${label} control within the organisation's scope. Controls marked "not applicable" carry a written justification per the standard's requirements.`,
  );

  const appCount = (p) => controls.filter((c) => c.applicability === p).length;
  paragraph(doc, `Applicable:     ${appCount('applicable')} controls`, { bold: true });
  paragraph(doc, `Not applicable: ${appCount('not_applicable')} controls`, { bold: true });
  paragraph(doc, `Under review:   ${appCount('under_review')} controls`, { bold: true });

  // Controls table — full list
  doc.addPage();
  sectionHeader(doc, {
    heading: 'Controls',
    caption: `${controls.length} controls in scope`,
  });

  evidenceTable(doc, {
    columns: [
      { key: 'id', label: 'Control', width: 0.15 },
      { key: 'name', label: 'Name', width: 0.35, render: (r) => r.name || '—' },
      { key: 'applicability', label: 'Appl.', width: 0.13, render: (r) => (r.applicability || 'tbd').replace('_', ' ') },
      { key: 'implementation_status', label: 'Status', width: 0.15, render: (r) => (r.implementation_status || 'tbd').replace('_', ' ') },
      { key: 'owner', label: 'Owner', width: 0.12, render: (r) => r.owner || '—' },
      { key: 'evidence', label: 'Evidence', width: 0.1, render: (r) => {
        if (r.evidence == null) return '—';
        if (Array.isArray(r.evidence)) return `${r.evidence.length}`;
        return String(r.evidence);
      } },
    ],
    rows: controls,
  });

  // Justifications for non-applicable controls
  const naControls = controls.filter((c) => c.applicability === 'not_applicable');
  if (naControls.length > 0) {
    doc.addPage();
    sectionHeader(doc, {
      heading: 'Exclusions + justifications',
      caption: `${naControls.length} controls excluded from scope`,
    });
    for (const c of naControls) {
      paragraph(doc, `${c.id} — ${c.name || ''}`, { bold: true });
      paragraph(doc, c.justification || '(No justification recorded.)', { colour: '#555' });
    }
  }
}

module.exports = { renderSoA, FRAMEWORK_LABELS };
