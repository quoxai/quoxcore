/**
 * AUD-PDF Phase 2: WARD assurance pack verification PDF
 *
 * Input: a pack object from assurancePack.js::buildAssurancePack.
 * Shape: { pack_id, version, generated_at, org_id, period,
 *   ward_chain, volt_bundles, audit_events, stats, manifest_hash,
 *   signature, public_key_pem }
 *
 * The PDF is a human-readable wrapper around the signed JSON pack.
 * It summarises the chain of evidence and exposes the manifest_hash +
 * signature in text form so the auditor can verify independently.
 */

const {
  titlePage,
  sectionHeader,
  paragraph,
  evidenceTable,
} = require('../pdfPrimitives.js');

function renderWardBundle(doc, pack, options = {}) {
  const { orgLabel } = options;

  titlePage(doc, {
    title: 'WARD Assurance Pack',
    subtitle: pack.pack_id || 'Assurance bundle',
    framework: `WARD v${pack.version || '1.0'}`,
    period: pack.period
      ? `${pack.period.from} → ${pack.period.to}`
      : '—',
    generatedAt: pack.generated_at,
    orgLabel: orgLabel || pack.org_id || '—',
  });

  doc.addPage();
  sectionHeader(doc, {
    heading: 'Summary',
    caption: 'Counts across the evidence chain for the reported period',
  });
  const stats = pack.stats || {};
  paragraph(doc, `VOLT bundles: ${stats.volt_bundles ?? 0}`, { bold: true });
  paragraph(doc, `WARD chain entries: ${stats.ward_entries ?? 0}`, { bold: true });
  paragraph(doc, `Audit events: ${stats.audit_events ?? 0}`, { bold: true });

  // WARD chain section
  if (pack.ward_chain) {
    doc.addPage();
    sectionHeader(doc, {
      heading: 'WARD chain',
      caption: 'Hash-chained write-once witness records for the period',
    });
    if (pack.ward_chain.error) {
      paragraph(doc, `Chain lookup failed: ${pack.ward_chain.error}`, { colour: '#a81e1e' });
    } else {
      paragraph(doc, `Chain ID: ${pack.ward_chain.chain_id || '—'}`);
      paragraph(doc, `Entries: ${pack.ward_chain.entries_count ?? 0}`);
      const tips = Array.isArray(pack.ward_chain.tips) ? pack.ward_chain.tips : [];
      if (tips.length > 0) {
        evidenceTable(doc, {
          columns: [
            { key: 'seq', label: 'Seq', width: 0.15 },
            { key: 'tip_chain_hash', label: 'Tip hash', width: 0.5, render: (r) => (r.tip_chain_hash || '').slice(0, 40) + '…' },
            { key: 'timestamp', label: 'Timestamp', width: 0.35, render: (r) => r.timestamp || r.ts || '—' },
          ],
          rows: tips,
        });
      }
    }
  }

  // VOLT bundles section
  if (Array.isArray(pack.volt_bundles)) {
    doc.addPage();
    sectionHeader(doc, {
      heading: 'VOLT bundles',
      caption: `${pack.volt_bundles.length} signed run bundle(s) in period`,
    });
    if (pack.volt_bundles.length === 0) {
      paragraph(doc, '(No VOLT bundles in the reported period.)', { colour: '#888' });
    } else {
      evidenceTable(doc, {
        columns: [
          { key: 'bundle_id', label: 'Bundle', width: 0.25, render: (r) => r.bundle_id || '—' },
          { key: 'run_id', label: 'Run', width: 0.3, render: (r) => r.run_id || '—' },
          { key: 'created_ts', label: 'Created', width: 0.25, render: (r) => r.created_ts || '—' },
          { key: 'events', label: 'Events', width: 0.2, render: (r) => r.data?.event_count ?? r.data?.manifest?.event_count ?? '—' },
        ],
        rows: pack.volt_bundles,
      });
    }
  }

  // Manifest + signature (the forensic section auditors actually care about)
  doc.addPage();
  sectionHeader(doc, {
    heading: 'Manifest + signature',
    caption: 'Re-derive the hash over the canonical pack JSON to verify',
  });
  paragraph(doc, 'Manifest hash (SHA-256, canonical JSON, manifest_hash + signature excluded):', { bold: true });
  paragraph(doc, pack.manifest_hash || '(missing)', { size: 9, colour: '#333' });
  paragraph(doc, 'Signature (base64, Ed25519 over the canonical pack message):', { bold: true });
  paragraph(doc, pack.signature || '(unsigned)', { size: 9, colour: '#333' });
  if (pack.public_key_pem) {
    paragraph(doc, 'Public key (PEM):', { bold: true });
    paragraph(doc, pack.public_key_pem, { size: 8, colour: '#555' });
  }
}

module.exports = { renderWardBundle };
