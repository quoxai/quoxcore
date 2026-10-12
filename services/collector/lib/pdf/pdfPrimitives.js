/**
 * AUD-PDF Phase 0: shared PDF section primitives
 *
 * Every renderer (soa, framework, dpia, wardBundle) composes a PDF
 * from these. One visual language = one branded deliverable.
 *
 * Each primitive takes an already-constructed `PDFDocument` (from
 * pdfkit) and mutates its cursor. None of them create the document;
 * that lives in `compliancePdfGenerator`.
 */

const COLOURS = {
  text: '#0a0a12',
  muted: '#555',
  rule: '#d9d9e0',
  brand: '#6b4bf0',  // Quox purple, muted for print
  compliant: '#127a3b',
  partial: '#9a6b00',
  gap: '#a81e1e',
  info: '#2458b0',
};

const FONTS = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  mono: 'Courier',
};

const MARGIN = 50;
const PAGE_WIDTH = 595;   // A4 in pdfkit default units
const PAGE_HEIGHT = 842;
const USABLE_WIDTH = PAGE_WIDTH - 2 * MARGIN;

function isPdfDoc(doc) {
  // pdfkit docs expose `.fillColor` + `.text` + `.font`; good-enough duck type.
  return doc && typeof doc.fillColor === 'function' && typeof doc.text === 'function';
}

/**
 * Title page. Call ONCE as the first operation on a new document.
 */
function titlePage(doc, { title, subtitle, framework, period, generatedAt, orgLabel }) {
  if (!isPdfDoc(doc)) throw new Error('titlePage: invalid PDF doc');

  const y = 180;

  doc
    .fillColor(COLOURS.brand)
    .font(FONTS.bold)
    .fontSize(10)
    .text('QUOX COMPLIANCE REPORT', MARGIN, y, { characterSpacing: 3 });

  doc
    .fillColor(COLOURS.text)
    .font(FONTS.bold)
    .fontSize(28)
    .text(title || 'Compliance Report', MARGIN, y + 28, { width: USABLE_WIDTH });

  if (subtitle) {
    doc
      .font(FONTS.regular)
      .fontSize(14)
      .fillColor(COLOURS.muted)
      .text(subtitle, MARGIN, doc.y + 8, { width: USABLE_WIDTH });
  }

  // Meta block
  const metaY = 400;
  doc
    .fillColor(COLOURS.muted)
    .font(FONTS.regular)
    .fontSize(9);

  const metaRows = [
    ['Framework', framework || '—'],
    ['Period', period || '—'],
    ['Organisation', orgLabel || '—'],
    ['Generated', generatedAt || new Date().toISOString()],
  ];

  let cursorY = metaY;
  for (const [label, value] of metaRows) {
    doc
      .fillColor(COLOURS.muted)
      .font(FONTS.bold)
      .fontSize(8)
      .text(label.toUpperCase(), MARGIN, cursorY, { characterSpacing: 1.5 });
    doc
      .fillColor(COLOURS.text)
      .font(FONTS.regular)
      .fontSize(11)
      .text(value, MARGIN, cursorY + 11);
    cursorY += 36;
  }
}

/**
 * Section header. Starts a new logical section; adds a rule, big
 * heading, and small caption. Does NOT add a page break — caller
 * decides.
 */
function sectionHeader(doc, { heading, caption }) {
  if (!isPdfDoc(doc)) throw new Error('sectionHeader: invalid PDF doc');

  doc.moveDown(1);
  const y = doc.y;

  doc
    .strokeColor(COLOURS.rule)
    .lineWidth(0.5)
    .moveTo(MARGIN, y)
    .lineTo(PAGE_WIDTH - MARGIN, y)
    .stroke();

  doc
    .fillColor(COLOURS.text)
    .font(FONTS.bold)
    .fontSize(16)
    .text(heading, MARGIN, y + 12, { width: USABLE_WIDTH });

  if (caption) {
    doc
      .fillColor(COLOURS.muted)
      .font(FONTS.regular)
      .fontSize(10)
      .text(caption, MARGIN, doc.y + 2, { width: USABLE_WIDTH });
  }

  doc.moveDown(0.6);
}

/**
 * Prose paragraph. Respects page breaks.
 */
function paragraph(doc, text, opts = {}) {
  if (!isPdfDoc(doc)) throw new Error('paragraph: invalid PDF doc');
  doc
    .fillColor(opts.colour || COLOURS.text)
    .font(opts.bold ? FONTS.bold : FONTS.regular)
    .fontSize(opts.size || 11)
    .text(text || '', { width: USABLE_WIDTH, align: opts.align || 'left' });
  doc.moveDown(0.4);
}

/**
 * Evidence / control table. Renders a key-value grid of rows.
 * columns = [{ key, label, width (fraction of usable), render? }]
 * rows    = [ { ... } ]
 */
function evidenceTable(doc, { columns, rows }) {
  if (!isPdfDoc(doc)) throw new Error('evidenceTable: invalid PDF doc');
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    throw new Error('evidenceTable: columns + rows must be arrays');
  }

  const totalWidth = USABLE_WIDTH;
  const widths = columns.map((c) => Math.floor(totalWidth * (c.width || 1 / columns.length)));

  // Header row
  let x = MARGIN;
  doc
    .fillColor(COLOURS.brand)
    .font(FONTS.bold)
    .fontSize(8);
  const headerY = doc.y;
  for (let i = 0; i < columns.length; i++) {
    doc.text(columns[i].label.toUpperCase(), x, headerY, {
      width: widths[i],
      characterSpacing: 1,
    });
    x += widths[i];
  }
  doc.moveDown(0.3);

  // Rule under header
  const ruleY = doc.y;
  doc
    .strokeColor(COLOURS.brand)
    .lineWidth(0.8)
    .moveTo(MARGIN, ruleY)
    .lineTo(MARGIN + totalWidth, ruleY)
    .stroke();
  doc.moveDown(0.3);

  // Rows
  doc
    .fillColor(COLOURS.text)
    .font(FONTS.regular)
    .fontSize(9);

  for (const row of rows) {
    // Page break if we're past the bottom margin — leave 50px footer buffer.
    if (doc.y > PAGE_HEIGHT - MARGIN - 50) {
      doc.addPage();
    }

    let cx = MARGIN;
    const rowY = doc.y;
    let maxH = 0;

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const raw = col.render ? col.render(row) : (row[col.key] ?? '');
      const cell = String(raw);
      const h = doc.heightOfString(cell, { width: widths[i] });
      maxH = Math.max(maxH, h);
      doc.text(cell, cx, rowY, { width: widths[i] });
      cx += widths[i];
    }
    doc.y = rowY + maxH + 4;
    // thin separator
    doc
      .strokeColor(COLOURS.rule)
      .lineWidth(0.25)
      .moveTo(MARGIN, doc.y)
      .lineTo(MARGIN + totalWidth, doc.y)
      .stroke();
    doc.moveDown(0.2);
  }
}

/**
 * Small status pill — renders inline at the current cursor.
 */
function statusPill(doc, status) {
  if (!isPdfDoc(doc)) throw new Error('statusPill: invalid PDF doc');
  const map = {
    compliant: { bg: '#e7f6ec', fg: COLOURS.compliant, label: 'COMPLIANT' },
    partial:   { bg: '#faf0d9', fg: COLOURS.partial,   label: 'PARTIAL' },
    gap:       { bg: '#fce8e8', fg: COLOURS.gap,       label: 'GAP' },
    not_applicable: { bg: '#eee', fg: COLOURS.muted,   label: 'N/A' },
  };
  const cfg = map[status] || map.not_applicable;
  const label = cfg.label;
  const w = doc.widthOfString(label, { size: 8 }) + 10;
  const h = 12;
  doc
    .fillColor(cfg.bg)
    .rect(doc.x, doc.y, w, h)
    .fill();
  doc
    .fillColor(cfg.fg)
    .font(FONTS.bold)
    .fontSize(8)
    .text(label, doc.x + 5, doc.y + 2, { lineBreak: false });
  doc.x += w + 4;
}

/**
 * Footer written to the current page. Should be the LAST draw before
 * the next page break. Writes page number + the first 12 chars of the
 * manifest_hash so each page carries forensic provenance.
 */
function footer(doc, { manifestHashFragment, pageNumber, totalPages }) {
  if (!isPdfDoc(doc)) throw new Error('footer: invalid PDF doc');
  const y = PAGE_HEIGHT - MARGIN + 10;
  doc
    .strokeColor(COLOURS.rule)
    .lineWidth(0.4)
    .moveTo(MARGIN, y - 6)
    .lineTo(PAGE_WIDTH - MARGIN, y - 6)
    .stroke();

  doc
    .fillColor(COLOURS.muted)
    .font(FONTS.regular)
    .fontSize(8);
  doc.text(
    `Quox · signed-hash ${manifestHashFragment || '—'}`,
    MARGIN,
    y,
    { width: USABLE_WIDTH / 2, lineBreak: false }
  );
  doc.text(
    totalPages ? `Page ${pageNumber} of ${totalPages}` : `Page ${pageNumber}`,
    MARGIN + USABLE_WIDTH / 2,
    y,
    { width: USABLE_WIDTH / 2, align: 'right', lineBreak: false }
  );
}

/**
 * Iterate every page of a finished doc (after `end()` was NOT yet
 * called) and stamp the footer on each. pdfkit's `bufferPages: true`
 * option on doc construction is required for this to work.
 */
function stampFooters(doc, { manifestHash }) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  const fragment = (manifestHash || '').slice(0, 12);
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    footer(doc, {
      manifestHashFragment: fragment,
      pageNumber: i + 1,
      totalPages: total,
    });
  }
}

module.exports = {
  COLOURS,
  FONTS,
  MARGIN,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  USABLE_WIDTH,
  titlePage,
  sectionHeader,
  paragraph,
  evidenceTable,
  statusPill,
  footer,
  stampFooters,
};
