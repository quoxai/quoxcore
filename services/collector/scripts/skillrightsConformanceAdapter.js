#!/usr/bin/env node
/**
 * SkillRights conformance adapter — second implementation.
 *
 * Maps quox-dashboard's actual skill-pack installer logic
 * (services/collector/lib/skillPackInstaller.js) onto the SkillRights
 * conformance contract, so the skillrights conformance fixture set (the
 * reference CLI is the first conformant implementation) can prove itself
 * usable by a real, differently-shaped downstream consumer. Contract doc:
 * /opt/quoxcore/skillrights/conformance/INTEGRATION.md.
 *
 * WHAT THIS ADAPTER DOES NOT DO: it does not reimplement frontmatter
 * parsing or licence classification. Every piece of logic that decides
 * `declaration` and `decision` comes straight from skillPackInstaller.js's
 * real, exported functions:
 *   - inspectSkillLicense(content)   — frontmatter/license-field reading
 *   - classifyLicenseVariant(id)     — identifier -> open/notrain/reserved
 *   - evaluateDistributionPolicy()   — the actual install-time policy engine
 * `decision` below is not hand-mapped from `declaration`; it is the literal
 * return value of evaluateDistributionPolicy() called once per policy name
 * against a synthetic one-file pack carrying this declaration, the same
 * function server.js's real skill-pack-sync route calls.
 *
 * The only logic that lives in THIS file:
 *   - stdin/stdout plumbing and SKILL.md file-existence (I/O, not parsing).
 *   - the LICENSES/ ancestor-text walk (findLicenseText below). This one is
 *     spec-defined filesystem lookup that skillPackInstaller.js has no
 *     function for by design: INTEGRATION.md states plainly that
 *     "skillPackInstaller.js never reads LICENSES/ at all; it reads only
 *     the frontmatter field" and that none of LICENSE_TEXT_MISSING /
 *     LICENSE_TEXT_EMPTY / LICENSE_TEXT_NO_IDENTIFIER_LINE /
 *     LICENSE_TEXT_IDENTIFIER_MISMATCH feed the decision model. There is no
 *     real collector function to import here — this is the honest "(b)
 *     genuinely out of scope" case, made concrete by reproducing the exact,
 *     bounded algorithm INTEGRATION.md documents (mirrors cli/lib/check.js's
 *     findLicenseText() in the skillrights repo) rather than skipping the
 *     LICENSE_TEXT_* findings or faking a pass.
 *
 * Contract: reads one line on stdin (an absolute directory path), writes
 * one JSON object to stdout, exits 0. See INTEGRATION.md for the full
 * declaration/findings/decision shape.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  inspectSkillLicense,
  classifyLicenseVariant,
  licenseFileNameForVariant,
  evaluateDistributionPolicy,
} = require('../lib/skillPackInstaller.js');

const IDENTIFIER_LINE_RE = /^Identifier:\s*(\S+)/m;
const MAX_LICENSE_WALK_LEVELS = 8;

// Two distinct org IDs so evaluateDistributionPolicy's cross-org check
// always engages — "the same posture that consumer takes for a cross-org
// pack install" (INTEGRATION.md's decision-model framing). Same-org
// installs never refuse under respect-reserved by design (the licensor's
// own fleet), so a same-org pair here would silently mask the policy this
// adapter exists to exercise.
const PACK_ORG_ID = 'skillrights-conformance-pack-org';
const HOST_ORG_ID = 'skillrights-conformance-host-org';

function isGitBoundary(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

// Mirrors the exact algorithm conformance/INTEGRATION.md documents for the
// LICENSES/ ancestor walk (same as cli/lib/check.js's findLicenseText() in
// the skillrights repo): walk upward from the skill directory for the
// nearest LICENSES/<fileName>, stopping at the first ancestor holding a
// .git directory (the package boundary) or after 8 levels, whichever comes
// first. Returns the file's text, or null if never found.
function findLicenseText(dir, fileName) {
  let levels = 0;
  let cur = dir;
  for (;;) {
    const candidate = path.join(cur, 'LICENSES', fileName);
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf8');
    }
    if (isGitBoundary(cur)) return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    if (levels >= MAX_LICENSE_WALK_LEVELS) return null;
    cur = parent;
    levels += 1;
  }
}

// The decision object is the literal output of the real policy engine, not
// a hand-copied restatement of it: one evaluateDistributionPolicy() call
// per named policy, against a synthetic single-file pack carrying this
// declaration's licence (or null when undeclared).
function decisionFor(declaration) {
  const files = [{ type: 'skill', ref: 'SKILL.md', license: declaration.identifier }];
  const allow = evaluateDistributionPolicy('allow', files, {});
  const requireDeclaration = evaluateDistributionPolicy('require-declaration', files, {});
  const respectReserved = evaluateDistributionPolicy('respect-reserved', files, {
    packOrgId: PACK_ORG_ID,
    hostOrgId: HOST_ORG_ID,
  });
  return {
    allow: allow.allowed,
    'require-declaration': requireDeclaration.allowed,
    'respect-reserved': respectReserved.allowed,
  };
}

function evaluate(dir) {
  const declaration = { present: false, identifier: null, variant: null };
  const findings = [];

  const skillMdPath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    findings.push('NO_SKILL_MD');
    return { declaration, findings, decision: decisionFor(declaration) };
  }

  const content = fs.readFileSync(skillMdPath, 'utf8');
  const inspected = inspectSkillLicense(content);

  if (!inspected.hasFrontmatter) {
    findings.push('NO_FRONTMATTER');
  } else if (inspected.licenseFieldCount > 1) {
    findings.push('DUPLICATE_LICENSE_FIELD');
  } else if (!inspected.license) {
    findings.push('NO_LICENSE_FIELD');
  } else {
    declaration.present = true;
    declaration.identifier = inspected.license;
    const variant = classifyLicenseVariant(inspected.license);
    declaration.variant = variant;

    if (!variant) {
      findings.push('UNKNOWN_VARIANT');
    } else {
      const fileName = licenseFileNameForVariant(variant);
      const text = findLicenseText(dir, fileName);
      if (text === null) {
        findings.push('LICENSE_TEXT_MISSING');
      } else if (text.trim().length === 0) {
        findings.push('LICENSE_TEXT_EMPTY');
      } else {
        const match = IDENTIFIER_LINE_RE.exec(text);
        if (!match) {
          findings.push('LICENSE_TEXT_NO_IDENTIFIER_LINE');
        } else if (match[1] !== inspected.license) {
          findings.push('LICENSE_TEXT_IDENTIFIER_MISMATCH');
        } else {
          findings.push('OK');
        }
      }
    }
  }

  return { declaration, findings, decision: decisionFor(declaration) };
}

function readStdinPath() {
  const raw = fs.readFileSync(0, 'utf8');
  return raw.trim();
}

function isMain() {
  return require.main === module;
}

if (isMain()) {
  const target = path.resolve(readStdinPath());
  const result = evaluate(target);
  process.stdout.write(JSON.stringify(result));
}

module.exports = { evaluate, findLicenseText, decisionFor };
