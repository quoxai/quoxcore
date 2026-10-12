/**
 * AUD-PDF Phase 2: DPIA renderer
 *
 * GDPR Article 35 — six mandatory sections. Input is a row from
 * `dpia_assessments` (id, org_id, processing_name, status, version,
 * sections_json). sections_json follows the shape defined in
 * lib/dpiaTemplate.js.
 */

const {
  titlePage,
  sectionHeader,
  paragraph,
} = require('../pdfPrimitives.js');

const SECTION_LABELS = {
  description: '1. Processing description',
  necessity: '2. Necessity & proportionality',
  risks: '3. Risk assessment',
  measures: '4. Mitigation measures',
  consultation: '5. Consultation',
  outcome: '6. Outcome & decision',
};

const SECTION_ORDER = [
  'description',
  'necessity',
  'risks',
  'measures',
  'consultation',
  'outcome',
];

function prettyKey(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderKeyValue(doc, key, value) {
  if (value === undefined || value === null || value === '') return;
  paragraph(doc, prettyKey(key), { bold: true, size: 10 });
  if (Array.isArray(value)) {
    if (value.length === 0) {
      paragraph(doc, '(none)', { colour: '#888' });
    } else {
      for (const item of value) {
        paragraph(doc, `• ${typeof item === 'string' ? item : JSON.stringify(item)}`);
      }
    }
  } else if (typeof value === 'object') {
    paragraph(doc, JSON.stringify(value, null, 2), { colour: '#555', size: 9 });
  } else if (typeof value === 'boolean') {
    paragraph(doc, value ? 'Yes' : 'No');
  } else {
    paragraph(doc, String(value));
  }
}

function renderRiskRegister(doc, risks) {
  if (!Array.isArray(risks) || risks.length === 0) {
    paragraph(doc, '(No risks recorded.)', { colour: '#888' });
    return;
  }
  paragraph(doc, `${risks.length} risk(s) assessed:`, { bold: true });
  for (const r of risks) {
    paragraph(doc, `• ${r.description || r.name || 'Unnamed risk'}`, { bold: true });
    if (r.likelihood != null) paragraph(doc, `   Likelihood: ${r.likelihood}`);
    if (r.impact != null) paragraph(doc, `   Impact: ${r.impact}`);
    if (r.score != null) paragraph(doc, `   Score: ${r.score}`);
    if (r.mitigation) paragraph(doc, `   Mitigation: ${r.mitigation}`, { colour: '#555' });
  }
}

function renderDpia(doc, dpia, options = {}) {
  const { orgLabel } = options;
  const sections = typeof dpia.sections_json === 'string'
    ? JSON.parse(dpia.sections_json || '{}')
    : (dpia.sections_json || dpia.sections || {});

  titlePage(doc, {
    title: 'Data Protection Impact Assessment',
    subtitle: dpia.processing_name || 'Unnamed processing activity',
    framework: 'GDPR Article 35',
    period: `DPIA v${dpia.version || 1} — ${dpia.status || 'draft'}`,
    generatedAt: dpia.updated_at || new Date().toISOString(),
    orgLabel: orgLabel || '—',
  });

  // One page per section, in canonical order
  for (const id of SECTION_ORDER) {
    doc.addPage();
    sectionHeader(doc, {
      heading: SECTION_LABELS[id],
      caption: `Required by GDPR Art.35(7)(${SECTION_ORDER.indexOf(id) + 1})`,
    });

    const section = sections[id];
    if (!section || (typeof section === 'object' && Object.keys(section).length === 0)) {
      paragraph(doc, '(Section not yet completed.)', { colour: '#888' });
      continue;
    }

    // Risk section gets a bespoke render; every other section is the
    // generic key/value dump with pretty labels.
    if (id === 'risks') {
      // risks may live at sections.risks.items or directly at sections.risks
      const risks = Array.isArray(section) ? section : (section.items || section.risks || []);
      renderRiskRegister(doc, risks);
      // also render any accompanying narrative
      if (!Array.isArray(section)) {
        for (const [k, v] of Object.entries(section)) {
          if (k === 'items' || k === 'risks') continue;
          renderKeyValue(doc, k, v);
        }
      }
      continue;
    }

    if (typeof section !== 'object') {
      paragraph(doc, String(section));
      continue;
    }

    for (const [k, v] of Object.entries(section)) {
      renderKeyValue(doc, k, v);
    }
  }
}

module.exports = { renderDpia, SECTION_LABELS, SECTION_ORDER };
