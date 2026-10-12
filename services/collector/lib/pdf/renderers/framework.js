/**
 * AUD-PDF Phase 1: generic framework renderer
 *
 * Consumed by SOC 2, HIPAA, GDPR, ISO 27001, EU AI Act, ISO 42001,
 * NIST AI RMF — every format the complianceExporter produces EXCEPT
 * the bespoke SoA + DPIA shapes.
 *
 * Input: the JSON report the matching formatter already emits
 * (e.g. formatSOC2Report / formatISO42001Report etc.). Those reports
 * all converge on a loose shape:
 *
 *   {
 *     format: string,
 *     generatedAt: ISO,
 *     period: { start, end, days },
 *     summary: { totalTraces, uniqueAgents, ... },
 *     overallScore?: number,            // 0-100
 *     overallStatus?: string,
 *     controls?: [ { id, name?, status, category?, evidence? } ],
 *     sections?: [ { heading, paragraphs[] } ],  // optional prose
 *     warnings?: [ string ],
 *   }
 *
 * Missing fields render gracefully.
 */

const {
  titlePage,
  sectionHeader,
  paragraph,
  evidenceTable,
  USABLE_WIDTH,
} = require('../pdfPrimitives.js');

const FORMAT_LABELS = {
  soc2: 'SOC 2 (Trust Services Criteria)',
  hipaa: 'HIPAA Security Rule (§164.312)',
  gdpr: 'GDPR Article 30 — Records of Processing',
  iso27001: 'ISO/IEC 27001:2022 — Annex A Controls',
  euAiAct: 'EU AI Act — High-Risk AI System Requirements',
  iso42001: 'ISO/IEC 42001:2023 — AI Management System',
  nistAiRmf: 'NIST AI RMF 1.0 — Govern / Map / Measure / Manage',
};

function renderFramework(doc, report, options = {}) {
  const { orgLabel } = options;
  const label = FORMAT_LABELS[report.format] || report.format;

  // Page 1 — title
  titlePage(doc, {
    title: label,
    subtitle: 'Readiness & Evidence Report',
    framework: label,
    period: report.period
      ? `${report.period.start} → ${report.period.end} (${report.period.days} days)`
      : '—',
    generatedAt: report.generatedAt,
    orgLabel: orgLabel || '—',
  });

  doc.addPage();

  // Executive summary
  sectionHeader(doc, {
    heading: 'Executive summary',
    caption: 'Assessment scope + coverage at a glance',
  });

  if (typeof report.overallScore === 'number') {
    paragraph(doc, `Overall score: ${report.overallScore}%`, { bold: true, size: 13 });
  }
  if (report.overallStatus) {
    paragraph(doc, `Status: ${report.overallStatus}`, { bold: true });
  }

  if (report.summary) {
    const s = report.summary;
    const lines = [];
    if (s.totalTraces != null) lines.push(`Total evidence traces: ${s.totalTraces.toLocaleString()}`);
    if (s.totalConversations != null) lines.push(`Conversations: ${s.totalConversations.toLocaleString()}`);
    if (s.totalLayerEvents != null) lines.push(`AOCL layer events: ${s.totalLayerEvents.toLocaleString()}`);
    if (s.uniqueAgents != null) lines.push(`Unique agents: ${s.uniqueAgents}`);
    for (const line of lines) paragraph(doc, line);
  } else {
    paragraph(doc, 'No summary available for this report.', { colour: '#888' });
  }

  // Prose sections (if any)
  if (Array.isArray(report.sections) && report.sections.length > 0) {
    for (const s of report.sections) {
      doc.addPage();
      sectionHeader(doc, { heading: s.heading || 'Section', caption: s.caption });
      const paragraphs = Array.isArray(s.paragraphs) ? s.paragraphs : [];
      for (const p of paragraphs) {
        paragraph(doc, typeof p === 'string' ? p : String(p));
      }
    }
  }

  // Controls table — the core evidence deliverable
  if (Array.isArray(report.controls) && report.controls.length > 0) {
    doc.addPage();
    sectionHeader(doc, {
      heading: 'Control coverage',
      caption: `${report.controls.length} controls assessed`,
    });
    evidenceTable(doc, {
      columns: [
        { key: 'id', label: 'Control', width: 0.18 },
        { key: 'name', label: 'Name', width: 0.42, render: (r) => r.name || '—' },
        { key: 'category', label: 'Category', width: 0.15, render: (r) => r.category || '—' },
        { key: 'status', label: 'Status', width: 0.13, render: (r) => String(r.status || 'unknown').toUpperCase() },
        { key: 'evidence', label: 'Evidence', width: 0.12, render: (r) => {
          if (r.evidence == null) return '—';
          if (typeof r.evidence === 'number') return String(r.evidence);
          if (Array.isArray(r.evidence)) return `${r.evidence.length} item(s)`;
          return String(r.evidence);
        } },
      ],
      rows: report.controls,
    });
  }

  // Warnings if any — last so they don't dominate
  if (Array.isArray(report.warnings) && report.warnings.length > 0) {
    doc.addPage();
    sectionHeader(doc, {
      heading: 'Warnings',
      caption: 'Items flagged by the formatter that require human judgement',
    });
    for (const w of report.warnings) {
      paragraph(doc, `• ${w}`, { colour: '#9a6b00' });
    }
  }
}

module.exports = {
  renderFramework,
  FORMAT_LABELS,
};
