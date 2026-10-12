/**
 * AUD-PDF Phase 1: compliance PDF orchestrator
 *
 * One entry point per report kind. Each returns a Buffer of the final
 * signed PDF bytes. Callers (the API handler in server.js) just
 * stream the buffer to `res`.
 */

const PDFDocument = require('pdfkit');
const {
  signReport,
  encodeManifestForPdf,
} = require('./pdfManifest.js');
const { stampFooters, MARGIN } = require('./pdfPrimitives.js');
const { renderFramework } = require('./renderers/framework.js');
const { renderSoA } = require('./renderers/soa.js');
const { renderDpia } = require('./renderers/dpia.js');
const { renderWardBundle } = require('./renderers/wardBundle.js');
const { redact } = require('./redact.js');
const { computeCacheKey, getCached, putCached } = require('./pdfCache.js');

/**
 * Cache-aware wrapper. If `cacheDb` + `cacheInput` are passed in
 * options, check the pdf_exports table for a prior identical render;
 * return it verbatim on hit. Otherwise render via `renderFn` and
 * persist the result for the next caller.
 *
 * cacheInput is the object whose canonical shape uniquely identifies
 * this render (e.g. the report JSON, or { soa_id, version }). Format
 * is always included in the cache key.
 */
async function throughCache({
  cacheDb, cacheKeyInput, cacheOrgId, cacheFormat,
  renderFn, manifest, metaBase, redacted,
}) {
  if (cacheDb && cacheKeyInput && cacheOrgId && cacheFormat) {
    const cache_key = computeCacheKey({ format: cacheFormat, input: cacheKeyInput });
    const hit = getCached(cacheDb, { org_id: cacheOrgId, cache_key });
    if (hit) {
      return { bytes: hit.bytes, manifest: { ...manifest, manifest_hash: hit.manifest_hash, from_cache: true }, pageCount: hit.page_count };
    }
    const fresh = await renderToBuffer(renderFn, manifest, metaBase);
    try {
      putCached(cacheDb, {
        org_id: cacheOrgId,
        format: cacheFormat,
        cache_key,
        manifest_hash: fresh.manifest.manifest_hash,
        pdf_bytes: fresh.bytes,
        page_count: fresh.pageCount,
        redacted: !!redacted,
      });
    } catch (err) {
      console.warn('[AUD-PDF] cache put failed (non-fatal):', err.message);
    }
    return fresh;
  }
  // No cache configured — render straight through.
  return renderToBuffer(renderFn, manifest, metaBase);
}

function isFrameworkFormat(format) {
  return [
    'soc2', 'hipaa', 'gdpr', 'iso27001',
    'euAiAct', 'iso42001', 'nistAiRmf',
  ].includes(format);
}

/**
 * Generate a framework-format compliance PDF (SOC 2 / HIPAA / GDPR /
 * ISO 27001 / EU AI Act / ISO 42001 / NIST AI RMF).
 *
 * @param {object} args
 * @param {object} args.report   JSON report from the matching formatter
 * @param {object} [args.options]
 * @param {string} [args.options.orgLabel]
 * @param {function} [args.options.getHookKeypair]  WARD keypair accessor
 * @returns {Promise<{ bytes: Buffer, manifest: object, pageCount: number }>}
 */
async function generateFrameworkPdf({ report, options = {} }) {
  if (!report || !isFrameworkFormat(report.format)) {
    throw new Error(`generateFrameworkPdf: unsupported format "${report?.format}"`);
  }
  const { report: effective, redactStats } = applyRedactionIfConfigured(report, options);
  const manifest = signReport(effective, options);
  if (redactStats) manifest.redacted_fields = redactStats.fieldsRedacted;
  return throughCache({
    cacheDb: options.cacheDb,
    cacheOrgId: options.cacheOrgId || report.org_id || '__default__',
    cacheFormat: effective.format,
    // Cache key covers the redacted report (if redaction applied) so
    // a redacted vs un-redacted render produce distinct entries.
    cacheKeyInput: effective,
    renderFn: (doc) => renderFramework(doc, effective, options),
    manifest,
    metaBase: {
      title: `Quox · ${effective.format}`,
      subject: `Compliance readiness report — ${effective.format}`,
    },
    redacted: !!redactStats,
  });
}

/**
 * Generate a Statement of Applicability PDF.
 * @param {object} args
 * @param {object} args.soa   Row from soa_assessments
 * @returns {Promise<{ bytes: Buffer, manifest: object, pageCount: number }>}
 */
async function generateSoAPdf({ soa, options = {} }) {
  if (!soa || !soa.framework) throw new Error('generateSoAPdf: soa.framework required');
  const canonicalSoA = {
    ...soa,
    controls_json: typeof soa.controls_json === 'string'
      ? JSON.parse(soa.controls_json || '[]')
      : (soa.controls_json || []),
  };
  const { report: effective, redactStats } = applyRedactionIfConfigured(canonicalSoA, options);
  const manifest = signReport(effective, options);
  if (redactStats) manifest.redacted_fields = redactStats.fieldsRedacted;
  return throughCache({
    cacheDb: options.cacheDb,
    cacheOrgId: options.cacheOrgId || soa.org_id || '__default__',
    cacheFormat: `soa-${soa.framework}`,
    cacheKeyInput: effective,
    renderFn: (doc) => renderSoA(doc, effective, options),
    manifest,
    metaBase: {
      title: 'Quox · Statement of Applicability',
      subject: `SoA — ${soa.framework}`,
    },
    redacted: !!redactStats,
  });
}

/**
 * Generate a DPIA (GDPR Art.35) PDF.
 * @param {object} args
 * @param {object} args.dpia   row from dpia_assessments
 */
async function generateDpiaPdf({ dpia, options = {} }) {
  if (!dpia) throw new Error('generateDpiaPdf: dpia required');
  const canonical = {
    ...dpia,
    sections_json: typeof dpia.sections_json === 'string'
      ? JSON.parse(dpia.sections_json || '{}')
      : (dpia.sections_json || {}),
  };
  const { report: effective, redactStats } = applyRedactionIfConfigured(canonical, options);
  const manifest = signReport(effective, options);
  if (redactStats) manifest.redacted_fields = redactStats.fieldsRedacted;
  return throughCache({
    cacheDb: options.cacheDb,
    cacheOrgId: options.cacheOrgId || dpia.org_id || '__default__',
    cacheFormat: 'dpia',
    cacheKeyInput: effective,
    renderFn: (doc) => renderDpia(doc, effective, options),
    manifest,
    metaBase: {
      title: 'Quox · Data Protection Impact Assessment',
      subject: `DPIA — ${dpia.processing_name || dpia.id}`,
    },
    redacted: !!redactStats,
  });
}

/**
 * Generate a WARD assurance-pack PDF.
 * @param {object} args
 * @param {object} args.pack   assurance pack object
 */
async function generateWardBundlePdf({ pack, options = {} }) {
  if (!pack) throw new Error('generateWardBundlePdf: pack required');
  const { report: effective, redactStats } = applyRedactionIfConfigured(pack, options);
  const manifest = signReport(effective, options);
  if (redactStats) manifest.redacted_fields = redactStats.fieldsRedacted;
  return throughCache({
    cacheDb: options.cacheDb,
    cacheOrgId: options.cacheOrgId || pack.org_id || '__default__',
    cacheFormat: 'assurance-pack',
    cacheKeyInput: effective,
    renderFn: (doc) => renderWardBundle(doc, effective, options),
    manifest,
    metaBase: {
      title: 'Quox · WARD Assurance Pack',
      subject: `Assurance pack — ${pack.pack_id || 'period'}`,
    },
    redacted: !!redactStats,
  });
}

/**
 * If options.redact is set, run the redaction pre-pass and return the
 * sanitised object. Otherwise passthrough.
 */
function applyRedactionIfConfigured(report, options) {
  if (!options || !options.redact) return { report, redactStats: null };
  const { redacted, stats } = redact(report, options.redact);
  return { report: redacted, redactStats: stats };
}

/**
 * Shared render → signed-buffer pipeline. The footer + PDF metadata
 * are applied uniformly before the doc is finalised.
 */
function renderToBuffer(renderFn, manifest, metaBase) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,  // required by stampFooters
      info: {
        Title: metaBase.title,
        Author: 'Quox Collector',
        Subject: metaBase.subject,
        Creator: 'Quox AOCL Compliance Suite',
        Producer: 'pdfkit (AUD-PDF renderer)',
        Keywords: encodeManifestForPdf(manifest),
      },
    });

    doc.on('data', (c) => chunks.push(c));
    let capturedPageCount = 0;
    doc.on('end', () => {
      resolve({
        bytes: Buffer.concat(chunks),
        manifest,
        pageCount: capturedPageCount,
      });
    });
    doc.on('error', reject);

    try {
      renderFn(doc);
      stampFooters(doc, { manifestHash: manifest.manifest_hash });
      // Capture before end() — the buffered-page array is cleared on finalize.
      capturedPageCount = doc.bufferedPageRange().count;
    } catch (err) {
      return reject(err);
    }
    doc.end();
  });
}

module.exports = {
  isFrameworkFormat,
  generateFrameworkPdf,
  generateSoAPdf,
  generateDpiaPdf,
  generateWardBundlePdf,
};
