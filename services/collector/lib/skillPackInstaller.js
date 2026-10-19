/**
 * skillPackInstaller.js — DEVSUITE-SKILLS Phase 2 (installer on dev-mode
 * activation).
 *
 * Given a dev_servers row's `host_id` and `enabled_capabilities` (see
 * devServersStore.js), resolves which Dev Skills Pack applies and installs
 * its referenced skill files onto that REMOTE host's filesystem via
 * bastionSshExecutor.js's `callBastion(hostId, command)` — a raw shell
 * string POSTed to Bastion's `/api/v1/exec`.
 *
 * SECURITY BOUNDARY (read before touching this file):
 * `callBastion` executes `command` as a shell string on a remote host. Any
 * untrusted content that reaches that string is a command-injection risk.
 * This module never interpolates raw pack content, host IDs, or capability
 * names into a command without validating/encoding them first:
 *
 *   1. Every skill file's content is base64-encoded (`Buffer#toString
 *      ('base64')`, no line wrapping) before it touches the command
 *      string. Base64 output is alphanumeric + `/+=` only — safe inside
 *      single quotes by construction, and it never contains a literal `'`,
 *      so it cannot break out of the single-quoted shell literal it's
 *      wrapped in. See buildInstallCommand().
 *   2. Every target path is validated to resolve inside the pack's own
 *      scoped subdirectory under `~/.claude/skills/` before it's used in
 *      any command — no `..`, no absolute-path escape. Mirrors the
 *      sanitizeInputPath() discipline in quoxagent's
 *      internal/runner/runner.go (clean the path, reject absolute/`..`,
 *      re-join against the base, and re-verify the joined path's relative
 *      form doesn't climb back out). See sanitizeRelPath().
 *   3. `host_id` must match the exact format already enforced on write
 *      into `dev_servers` (devServersStore.js persists whatever quoxagent's
 *      dev.register heartbeat reports as `host_id` — a plain hostname-style
 *      token). This module additionally REJECTS anything that isn't
 *      alphanumeric/hyphen rather than escaping it. See sanitizeHostId().
 *   4. Capability names are checked against the exact `dev.*` capability
 *      catalog quoxagent's dev plugin family declares (capabilities.go
 *      AllCapabilities) — anything else is rejected, not escaped. See
 *      sanitizeCapabilities().
 *
 * PACK SIGNATURE VERIFICATION — wired via quoxflow's GET /:id/verify.
 * quoxflow commit 73eca94 added `GET /api/skill-packs/:id/verify` (org
 * scoped via requireOrgScope/X-Org-Id, response
 * `{ success: true, data: { id, orgId, valid, reason? } }`, 404 on
 * not-found). `installSkillPack()` still accepts an explicit
 * `verification` argument for callers who already have a verified result
 * (e.g. a caller that batches verification across multiple packs) — that
 * path is unchanged and still fails closed on anything other than
 * `{ valid: true }`. When the caller does NOT pass `verification`, this
 * module now resolves it itself via `fetchPackVerification()`, which calls
 * the quoxflow endpoint using the same X-Service-Key + X-Org-Id
 * cross-service auth pattern used throughout this collector (see
 * agentProfile.js / approvalGate.js). `fetchPackVerification()` never
 * throws: any non-2xx response or network/timeout error resolves to
 * `{ valid: false, reason: 'verification_unavailable' }`, so a caller that
 * forgets `verification` gets a real check, not an install-anyway default.
 */

'use strict';

const path = require('path').posix;
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Known-format constants (mirrored, not imported — different repo/runtime)
// ---------------------------------------------------------------------------

// Mirrors quoxagent internal/plugins/dev/capabilities.go's AllCapabilities
// exactly (dev.register/build/clarify/gripe/docs). Anything outside this
// set is rejected rather than passed through.
const KNOWN_DEV_CAPABILITIES = Object.freeze([
  'dev.register',
  'dev.build',
  'dev.clarify',
  'dev.gripe',
  'dev.docs',
  // dev.plan is ADVERTISE-ONLY and has no skill pack, same shape as
  // dev.sessions below: it only needs to be a valid name a signed capability
  // profile may carry. The roadmap window it unlocks is served by this
  // collector's own governed QuoxPlan proxy, so the agent gains no new reach
  // from holding it. Without this entry `quox dev enable --capabilities
  // ...,dev.plan` 500s and the capability can never be granted.
  'dev.plan',
  // dev.sessions is the quoxified-loop substrate (DEVSUITE-DEVMODE fleet
  // spawn seam). It is a NATIVE quoxagent capability with no skill pack, so
  // it only needs to be a valid name a signed capability profile may carry
  // — sanitizeCapabilities gates profile issuance on this list, and the
  // profile issuer never installs a pack for it. Missing it here rejected
  // every `quox dev enable ... --capabilities dev.sessions` with "unknown
  // dev capability" (fixed 2026-08-14, first e2e loop rollout).
  'dev.sessions',
  // dev.backup and dev.restore (G2d) are NATIVE quoxagent capabilities with
  // no skill pack, same shape as dev.sessions above: the engines are
  // scripts/backup-quox.sh and scripts/restore-quox.sh, driven host-side, so
  // the name only has to be one a signed capability profile may carry.
  // sanitizeCapabilities gates profile issuance on this list, so without
  // these entries `quox dev enable --capabilities ...,dev.backup` 500s with
  // "unknown dev capability" and neither capability can ever be granted.
  // They are two names, not one, on purpose: writing an archive and writing
  // the box's live data back over itself are different grants, and a host may
  // hold dev.backup without dev.restore.
  'dev.backup',
  'dev.restore',
]);

// host_id as written into dev_servers comes from quoxagent's dev.register
// heartbeat (a hostname-style token) — alphanumeric + hyphen, 1-64 chars,
// must not start with a hyphen.
const HOST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;

// A pack-scoped subdirectory name is under our own control (hardcoded in
// CORE_DEV_PACK below) but still validated defensively with the same rule.
const PACK_SUBDIR_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;

// Local skills live on this box under ~/.claude/skills — overridable for
// tests via QUOX_SKILLS_ROOT.
// #1019: the default follows the running user's home, never a dev-box path baked into the shipped code.
const SKILLS_ROOT = require('path').resolve(process.env.QUOX_SKILLS_ROOT || require('path').join(require('os').homedir(), '.claude', 'skills'));

// Local base for 'file'-type entries (the DevSuite runtime layer: metron,
// precompacticus, the statusline) — one level up from SKILLS_ROOT at
// ~/.claude, overridable for tests via QUOX_CLAUDE_ROOT. A 'file' entry's
// `ref` is a path relative to this root (and the default remote dest is the
// same relative path under $HOME/.claude), so the source and install
// locations stay symmetric the way skill refs already are.
const CLAUDE_ROOT = require('path').resolve(process.env.QUOX_CLAUDE_ROOT || require('path').join(require('os').homedir(), '.claude'));

// Remote install root, relative to the remote user's $HOME (resolved by the
// remote shell itself via the literal, non-interpolated string `$HOME` —
// never a value we compute client-side and inline).
const REMOTE_SKILLS_ROOT = '.claude/skills';

// Remote base for 'file'-type entries — ~/.claude on the host. Same
// containment boundary as skills (nothing is ever written outside
// $HOME/.claude), one level up so a runtime tool lands at e.g.
// $HOME/.claude/metron/metron.py rather than under the skills tree.
const REMOTE_CLAUDE_ROOT = '.claude';

// 'file'-type mode is an octal chmod applied after the write. Reject anything
// that isn't 3-4 octal digits rather than escaping it (same reject-never-escape
// posture as the path/host/capability sanitizers above).
const FILE_MODE_PATTERN = /^[0-7]{3,4}$/;

const PACK_VERSION_MARKER_FILE = '.pack-version';

// DEVSUITE runtime layer (P8): when a pack ships this file entry, the installer
// RUNS it on the host after all files land — it safe-merges the runtime hooks +
// statusLine into ~/.claude/settings.json. This is the pack's one code-exec
// step; it only fires for a file entry with exactly this ref (signed pack
// content, verified before any install), and the path is a fixed literal.
const SETTINGS_WIRE_REF = 'quox-devsuite/settings-wire.py';

// SKILLRIGHTS #478 Phase 9: the rights manifest written beside the version
// marker on every install — the receiving host's durable record of what it
// received under which rights. JSON: { packId, version, rights: [{ref,
// license}] }. Written BEFORE the version marker so a partially-installed
// pack can never carry the marker without its rights record.
const RIGHTS_MANIFEST_FILE = '.pack-rights.json';

// quoxflow cross-service call config — same env vars + auth pattern as
// agentProfile.js / approvalGate.js in this collector (QUOXFLOW_URL,
// INTERNAL_SERVICE_KEY as X-Service-Key, org scope as X-Org-Id).
const QUOXFLOW_URL = process.env.QUOXFLOW_URL || 'http://quoxflow:3200';
const VERIFY_FETCH_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// The "core dev pack" — hardcoded for this pass per DEVSUITE-SKILLS Phase 2
// scope (a capability -> pack mapping table is future work). Contents are
// four real, small, currently-existing skill files on this box, matching
// the categories the DEVSUITE-SKILLS plan doc names as the initial pack
// contents (build rules, RepoBrain discipline, git discipline, verify
// discipline). "Clarify rules" and "quoxpert subskills per activated
// capability" are named in the plan doc too, but there is no dedicated
// `clarify` skill folder on this box today (clarify-mcp is an MCP server,
// not a skill folder) — not fabricated here, left for a future pack
// revision once that content exists on disk.
// ---------------------------------------------------------------------------

const CORE_DEV_PACK = Object.freeze({
  packId: 'quox-core-dev-pack',
  // v4 (F1 fix, 2026-08-15): skills now install FLAT at ~/.claude/skills/<name>
  // so Claude Code actually discovers them; legacy nested copies are removed.
  // v5 (quox#453, 2026-08-22): the discipline loops join the pack. The
  // skill-packs promo already claimed "the discipline arrived with the
  // host" and the resident's brief expected proof-loop/tdd, but the v4
  // MANIFEST never carried them: the registry attested "current, no drift"
  // on quoxdelaclaudicus01 while the loops were absent from disk, because
  // the drift check can only measure what the manifest names. Found working
  // the resident's own #453 escalation with it, live.
  // v6 (DEVSUITE-SLOTS, 2026-09-04): + quoxpert-quoxslots, so the rule that
  // tells a session to offer a durable slot address (see the new "QuoxSlots
  // session address" section in quox-dev-rules/RULES.md) has its recipes
  // sitting right beside it. A rule that points at a skill the pack never
  // installs is a dead pointer on any host that only has the core pack.
  // v7 (DEVSUITE runtime layer, P8): + the 'file'-type runtime tools so a
  // dev-enabled host visibly FEELS Quox in Claude Code out of the box — metron
  // (usage gate + statusline segment), precompacticus (context nudge + snapshot
  // + statusline segment), the combined statusline, and settings-wire.py which
  // safe-merges the two hooks + statusLine into the host's ~/.claude/settings.json
  // (backup + idempotent + never clobbers a user's own statusline). The
  // installer runs settings-wire.py after the files land (see SETTINGS_WIRE_REF).
  // v8 (2026-10-05): rules layer gains the Brain2 knowledge-recall section; statusline.sh
  // gets a recursion guard and settings-wire.py never saves a wrapper of our own
  // statusline as prior-statusline.cmd (fixed a 14,844-process fork storm). Content-only
  // bump, no entry changes.
  // v9 (BRAIN2-AUDIT, 2026-10-05): + quoxpert-qlarity, quoxpert-security, quoxify. The
  // RULES.md triggers point at them (Qlarity-first, security runs as an
  // engagement, load quoxify before capability work), same dead-pointer logic
  // as quoxslots in v6; both quoxpert skills privacy-swept first.
  version: '9',
  orgId: 'default',
  subdir: 'quox-core-dev-pack',
  contents: Object.freeze([
    Object.freeze({ type: 'skill', ref: 'docker-rebuild/SKILL.md', description: 'quox-build discipline — never docker compose build/up directly' }),
    Object.freeze({ type: 'skill', ref: 'nucleus/SKILL.md', description: 'RepoBrain discipline — query before grep/read, announce usage' }),
    Object.freeze({ type: 'skill', ref: 'push-all/SKILL.md', description: 'git discipline — status sweep, commit, push across repos' }),
    Object.freeze({ type: 'skill', ref: 'verify/SKILL.md', description: 'build/test verification after any code change' }),
    // v2 (DEVSUITE-SKILLS seq 5, owner 2026-08-15): the dev tools must be
    // DISCOVERED, not known about — plus the backend-neutral rules layer.
    Object.freeze({ type: 'skill', ref: 'context-load/SKILL.md', description: 'front-load architecture context at session start' }),
    Object.freeze({ type: 'skill', ref: 'codebase-mirror/SKILL.md', description: 'regenerate the codebase map from actual code' }),
    // v5: the discipline loops (see version note above).
    Object.freeze({ type: 'skill', ref: 'proof-loop/SKILL.md', description: 'claim to shipped evidence — drive the real surface, file every gap' }),
    Object.freeze({ type: 'skill', ref: 'fix-loop/SKILL.md', description: 'bug to passing test — failing test first, three attempts max' }),
    Object.freeze({ type: 'skill', ref: 'tdd/SKILL.md', description: 'strict TDD loop — failing tests first, full suite after every change' }),
    Object.freeze({ type: 'skill', ref: 'preflight/SKILL.md', description: 'blast-radius analysis before risky changes' }),
    Object.freeze({ type: 'rule', ref: 'quox-dev-rules/RULES.md', description: 'trigger discipline rendered to CLAUDE.md + AGENTS.md' }),
    // v3 (QUOXPERTICUS P5, 2026-08-15): the quoxpert sub-skills ship with the
    // pack, so a dev-enabled host's Claude is a Quox operator out of the box
    // and the resident agent has its own manual. Exactly the PUBLIC set (the
    // 14 packages the quoxpert repo's install channel ships, privacy-vetted
    // there); the internal-only sub-skills (devsuite/discord/qlarity/qloop/
    // security) stay out until they pass the same public bar. v6 adds
    // quoxpert-quoxslots as a deliberate exception ahead of that bar: it is
    // the recipe the RULES.md "QuoxSlots session address" rule points every
    // session at, so it ships with the pack rather than being a dead
    // pointer.
    Object.freeze({ type: 'skill', ref: 'quoxpert/SKILL.md', description: 'quoxpert router — orient, then load the matching sub-skill' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-core/SKILL.md', description: 'QuoxCORE platform orientation' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-cli/SKILL.md', description: 'the quox CLI and TUI' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-mcp/SKILL.md', description: 'QuoxMCP install and tool surface' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-flow/SKILL.md', description: 'quoxflow workflows, policies, HITL' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-bastion/SKILL.md', description: 'fleet hosts and governed exec' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-plugin-sdk/SKILL.md', description: 'building .quoxplugin extensions' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-protocols/SKILL.md', description: 'AEE, AOCL, VOLT, WARD' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-deploy/SKILL.md', description: 'install, upgrade, backup, restore' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-qluster/SKILL.md', description: 'multi-instance fleet control plane' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-convert/SKILL.md', description: 'convert an existing tool into a plugin' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-publish/SKILL.md', description: 'plugin signing and distribution, honest maturity' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-repobrain/SKILL.md', description: 'code intelligence discipline' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-quoxplan/SKILL.md', description: 'roadmap and stream planning' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-quoxslots/SKILL.md', description: 'durable session addresses — checkout, say, steer, release' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-qlarity/SKILL.md', description: 'governed browser inspection — inspectors, approvals' }),
    Object.freeze({ type: 'skill', ref: 'quoxpert-security/SKILL.md', description: 'QuoxSecurity engagements, scopes, scans' }),
    Object.freeze({ type: 'skill', ref: 'quoxify/SKILL.md', description: 'Quox house standard before any plugin/agent/capability work' }),
    // v7 (DEVSUITE runtime layer, P8): 'file'-type entries install to
    // ~/.claude/<ref> (ref == install path for all of these), executables at
    // mode 755. These are what a user SEES and feels — the statusline segments
    // and the hooks that fire them. settings-wire.py is run by the installer
    // after the writes to merge the hooks + statusLine into settings.json.
    Object.freeze({ type: 'file', ref: 'metron/metron.py', mode: '755', description: 'Metron — session-usage monitor + subagent-cooldown gate + statusline segment' }),
    Object.freeze({ type: 'file', ref: 'precompacticus/precompacticus.py', mode: '755', description: 'Precompacticus — context meter + pre-compaction snapshot/nudge + statusline segment' }),
    Object.freeze({ type: 'file', ref: 'precompacticus/precompacticus.conf.example', description: 'Precompacticus config template (copy to precompacticus.conf to customise)' }),
    Object.freeze({ type: 'file', ref: 'quox-devsuite/statusline.sh', mode: '755', description: 'DevSuite combined statusline — context + usage segments, composes onto any prior statusline' }),
    Object.freeze({ type: 'file', ref: 'quox-devsuite/settings-wire.py', mode: '755', description: 'safe-merge the DevSuite hooks + statusLine into ~/.claude/settings.json (backup, idempotent, non-clobbering)' }),
  ]),
});

// ---------------------------------------------------------------------------
// Sanitizers — reject, never escape.
// ---------------------------------------------------------------------------

function sanitizeHostId(hostId) {
  if (typeof hostId !== 'string' || !HOST_ID_PATTERN.test(hostId)) {
    throw new Error(`skillPackInstaller: invalid host_id '${hostId}'`);
  }
  return hostId;
}

function sanitizeCapabilities(capabilities) {
  const list = Array.isArray(capabilities) ? capabilities : [];
  for (const cap of list) {
    if (!KNOWN_DEV_CAPABILITIES.includes(cap)) {
      throw new Error(`skillPackInstaller: unknown dev capability '${cap}'`);
    }
  }
  return list;
}

function sanitizePackSubdir(subdir) {
  if (typeof subdir !== 'string' || !PACK_SUBDIR_PATTERN.test(subdir)) {
    throw new Error(`skillPackInstaller: invalid pack subdir '${subdir}'`);
  }
  return subdir;
}

// Mirrors quoxagent's sanitizeInputPath() (internal/runner/runner.go):
// clean the path, reject absolute paths and any leading `..`, re-join
// against the base, then re-verify the relative form of the joined path
// still starts inside the base (defence in depth against clever `..`
// sequences that survive the first clean).
function sanitizeRelPath(baseDir, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error(`skillPackInstaller: empty ref path`);
  }
  // Reject NUL bytes outright (SEC-AUDIT 2026-08-11): path.normalize() does
  // not strip an embedded/leading \x00, so a NUL could survive the traversal
  // checks below. This "reject, never escape" posture matches the rest of
  // this file and quoxagent's own sanitizeInputPath(); a NUL has no
  // legitimate place in a skill-file ref path.
  if (relPath.includes('\x00')) {
    throw new Error(`skillPackInstaller: NUL byte not allowed in ref path`);
  }
  const clean = path.normalize(relPath);

  if (path.isAbsolute(clean)) {
    throw new Error(`skillPackInstaller: absolute path not allowed: ${relPath}`);
  }
  if (clean === '..' || clean.startsWith('../')) {
    throw new Error(`skillPackInstaller: path traversal not allowed: ${relPath}`);
  }

  const target = path.join(baseDir, clean);
  const rel = path.relative(baseDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`skillPackInstaller: path traversal not allowed: ${relPath}`);
  }

  // QUOXTRUST FND_..SK5C (defence in depth): `clean` is interpolated into a double-quoted remote
  // path in buildFileWriteClause (`> "$HOME/.../<clean>"`), whose comment ALREADY claims paths are
  // "sanitized to [A-Za-z0-9._/-] so double quotes are safe" — but that charset was never actually
  // enforced here (only NUL/absolute/traversal were). A ref containing a `"` or `$` would break out
  // of those quotes. Pack refs come from the trusted server-side registry today (not caller input),
  // so this is latent, not live — but enforce the claimed charset now so the code matches its own
  // safety comment and a future caller-supplied pack cannot inject. Reject, never escape.
  if (!/^[A-Za-z0-9._/-]+$/.test(clean)) {
    throw new Error(`skillPackInstaller: ref path contains characters not allowed in a remote path: ${relPath}`);
  }

  return { clean, target };
}

// ---------------------------------------------------------------------------
// Pack resolution
// ---------------------------------------------------------------------------

// Single hardcoded pack for this pass — every dev-registered host (i.e. any
// host reporting at least dev.register) gets CORE_DEV_PACK. A real
// capability -> pack mapping table is future work (see plan doc phase 3,
// "sync/update channel + drift surfacing").
function resolvePackForCapabilities(enabledCapabilities) {
  const caps = sanitizeCapabilities(enabledCapabilities);
  if (!caps.includes('dev.register')) return null;
  return CORE_DEV_PACK;
}

// ---------------------------------------------------------------------------
// Local read + version marker
// ---------------------------------------------------------------------------

function resolveLocalSkillPath(ref) {
  const { target } = sanitizeRelPath(SKILLS_ROOT, ref);
  return target;
}

// Local read path for a 'file'-type entry — resolved under CLAUDE_ROOT
// (~/.claude), with the same traversal validation skills get under
// SKILLS_ROOT. Separate root, identical discipline.
function resolveLocalFilePath(ref) {
  const { target } = sanitizeRelPath(CLAUDE_ROOT, ref);
  return target;
}

// ---------------------------------------------------------------------------
// SKILLRIGHTS #478 Phase 9 — rights extraction, aggregation, policy.
// A SkillRights declaration is the `license:` field of a SKILL.md's YAML
// frontmatter (see skillrights.org — e.g. LicenseRef-SkillRights-NoTrain-1.0).
// The declaration is carried through distribution, never interpreted as a
// technical control: labelling and org-policy refusal are the enforcement
// surfaces, exactly what the standard honestly claims to support.
// ---------------------------------------------------------------------------

// Inspects the leading YAML frontmatter block for a `license:` field,
// reporting enough detail (frontmatter presence, field count, resolved
// value) for both the install-time carriage path (parseSkillLicense below)
// and the SkillRights conformance adapter's finding codes
// (services/collector/scripts/skillrightsConformanceAdapter.js), which
// needs to tell "no frontmatter" apart from "no license field" apart from
// "declared twice" rather than collapsing all three to null. A license:
// line OUTSIDE frontmatter is body text, not a declaration.
//
// SKILLRIGHTS conformance #2 (2026-09-11): a second "license:" line inside
// the same frontmatter block used to be silently resolved by taking the
// first match, which mirrors the exact bug fixed in the SkillRights CLI's
// own countField() ("Never resolve an ambiguous declaration by taking the
// first line"). Two "license" lines mean the author's intent cannot be
// attributed to either one, so `license` resolves to null (ambiguous,
// treated as absent) whenever licenseFieldCount is not exactly 1.
function inspectSkillLicense(content) {
  if (typeof content !== 'string') {
    return { hasFrontmatter: false, licenseFieldCount: 0, license: null };
  }
  if (!content.startsWith('---')) {
    return { hasFrontmatter: false, licenseFieldCount: 0, license: null };
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    return { hasFrontmatter: false, licenseFieldCount: 0, license: null };
  }
  const frontmatter = content.slice(0, end);
  const matches = frontmatter.match(/^license:[ \t]*(.+)$/gm) || [];
  if (matches.length !== 1) {
    return { hasFrontmatter: true, licenseFieldCount: matches.length, license: null };
  }
  const singleLineMatch = /^license:[ \t]*(.+)$/m.exec(frontmatter);
  const value = singleLineMatch[1].trim().replace(/^["']|["']$/g, '').trim();
  return { hasFrontmatter: true, licenseFieldCount: 1, license: value || null };
}

// Extracts the `license:` value from a leading YAML frontmatter block, or
// null when absent, ambiguous (declared more than once), or there is no
// frontmatter at all. Thin wrapper over inspectSkillLicense() so callers
// that only need the resolved value (the common case) don't have to
// destructure.
function parseSkillLicense(content) {
  return inspectSkillLicense(content).license;
}

// Classifies a declared licence identifier against the three known
// SkillRights 1.0 variants. Returns null for an absent, unparseable, or
// unrecognised identifier (including a well-formed but non-SkillRights
// `LicenseRef-` value) — mirrors cli/lib/identifiers.js's
// variantFromIdentifier() in the skillrights repo exactly, per
// conformance/INTEGRATION.md.
const KNOWN_VARIANT_IDENTIFIER_RE = /^LicenseRef-SkillRights-(Open|NoTrain|Reserved)-1\.0$/;
const VARIANT_LABEL_TO_KEY = Object.freeze({ Open: 'open', NoTrain: 'notrain', Reserved: 'reserved' });
const VARIANT_KEY_TO_LABEL = Object.freeze({ open: 'Open', notrain: 'NoTrain', reserved: 'Reserved' });

function classifyLicenseVariant(identifier) {
  if (typeof identifier !== 'string') return null;
  const match = KNOWN_VARIANT_IDENTIFIER_RE.exec(identifier);
  return match ? VARIANT_LABEL_TO_KEY[match[1]] : null;
}

// The SPDX-style provenance text filename for a known variant (e.g.
// "LicenseRef-SkillRights-Open-1.0.txt"), or null for an unrecognised
// variant key. skillPackInstaller.js itself never reads this text (see
// evaluateDistributionPolicy's doc comment); exported so the conformance
// adapter can name the same file the reference implementation looks for
// without hardcoding the identifier grammar a second time.
function licenseFileNameForVariant(variant) {
  const label = VARIANT_KEY_TO_LABEL[variant];
  return label ? `LicenseRef-SkillRights-${label}-1.0.txt` : null;
}

// Aggregates rights over SKILL entries (rules have no frontmatter licence
// convention today, so they are excluded from the counts by design).
function summarizePackRights(files) {
  const skills = (files || []).filter((f) => f.type === 'skill');
  const byLicense = {};
  let declared = 0;
  for (const f of skills) {
    if (f.license) {
      declared += 1;
      byLicense[f.license] = (byLicense[f.license] || 0) + 1;
    }
  }
  return {
    total: skills.length,
    declared,
    undeclared: skills.length - declared,
    byLicense,
    entries: skills.map((f) => ({ ref: f.ref, license: f.license || null })),
  };
}

// A Reserved-family SkillRights licence permits execution by authorised
// recipients only and reserves redistribution. Same-org distribution is the
// licensor's own fleet (authorised by construction); cross-org distribution
// of Reserved content is what 'respect-reserved' refuses.
//
// SKILLRIGHTS conformance #2 (2026-09-11): this used to be a loose
// /skillrights-reserved/i substring test against the raw licence string,
// which meant an unrecognised custom LicenseRef- identifier merely
// containing the word "reserved" in some other form (e.g.
// "LicenseRef-Custom-SkillRights-Reserved-2.0") wrongly tripped the policy,
// even though it is not the recognised SkillRights Reserved licence — see
// conformance/INTEGRATION.md's "respect-reserved" section in the
// skillrights repo. Reserved-ness is now decided by classifyLicenseVariant()
// against the exact identifier grammar, the same function the SkillRights
// conformance adapter uses to compute `declaration.variant`.
function isReservedLicense(license) {
  return classifyLicenseVariant(license) === 'reserved';
}

/**
 * Pure policy evaluation — no I/O, unit-testable in isolation.
 * Policies: 'allow' (default; unknown values also resolve here so a
 * misconfigured setting can never brick fleet sync), 'require-declaration'
 * (every skill entry must carry a licence), 'respect-reserved' (no
 * cross-org distribution of Reserved-declared skills).
 */
function evaluateDistributionPolicy(policy, files, { packOrgId, hostOrgId } = {}) {
  const skills = (files || []).filter((f) => f.type === 'skill');
  if (policy === 'require-declaration') {
    const offendingRefs = skills.filter((f) => !f.license).map((f) => f.ref);
    if (offendingRefs.length) return { allowed: false, policy, offendingRefs };
    return { allowed: true, policy };
  }
  // SKILLRIGHTS #478 Phase 11: 'require-acceptance' is NOT decidable here.
  // Whether the org has affirmatively accepted the current terms is a
  // durable-record question (skill_pack_acceptances), and this function is
  // deliberately pure. The sync handler enforces it BEFORE calling
  // installSkillPack (see devServerSkillPacksStore.js). Named explicitly so
  // it cannot fall through to the 'allow' default below and read as "this
  // policy permits everything", which is the opposite of what it means.
  if (policy === 'require-acceptance') {
    return { allowed: true, policy, decidedElsewhere: true };
  }
  if (policy === 'respect-reserved') {
    const crossOrg = !!packOrgId && !!hostOrgId && packOrgId !== hostOrgId;
    if (crossOrg) {
      const offendingRefs = skills.filter((f) => f.license && isReservedLicense(f.license)).map((f) => f.ref);
      if (offendingRefs.length) return { allowed: false, policy, offendingRefs };
    }
    return { allowed: true, policy };
  }
  return { allowed: true, policy: 'allow' };
}

// Reads every referenced skill file from THIS box's local filesystem (not
// the remote host) — the pack references content, it never embeds it. Each
// skill entry carries its parsed SkillRights declaration (null when the
// file declares none).
function loadPackFileContents(pack) {
  return pack.contents.map((entry) => {
    // 'file' entries read from ~/.claude (CLAUDE_ROOT); 'skill'/'rule' entries
    // read from ~/.claude/skills (SKILLS_ROOT). File entries carry their
    // dest/mode through for the write path; only skills parse a SkillRights
    // licence (files have no frontmatter convention).
    const localPath = entry.type === 'file' ? resolveLocalFilePath(entry.ref) : resolveLocalSkillPath(entry.ref);
    let content;
    try {
      content = fs.readFileSync(localPath, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
      // #1019: a server without the pack's source files says so, instead of a 500 naming a raw path.
      const e = new Error(`The ${pack.packId} source files are not installed on this server (missing: ${entry.ref}). Set QUOX_SKILLS_ROOT to where they live.`);
      e.code = 'pack_sources_unavailable';
      throw e;
    }
    return {
      ref: entry.ref,
      content,
      type: entry.type,
      license: entry.type === 'skill' ? parseSkillLicense(content) : null,
      ...(entry.type === 'file' ? { dest: entry.dest, mode: entry.mode } : {}),
    };
  });
}

// A short, deterministic marker of "this exact pack, this exact content"
// so re-activation can detect an already-installed, unchanged pack without
// rewriting files. Hash covers packId + version + every file's content, so
// an edit to a referenced skill file (without a version bump) still
// invalidates the marker.
function computePackContentHash(pack, files) {
  const hash = crypto.createHash('sha256');
  hash.update(pack.packId);
  hash.update(' ');
  hash.update(pack.version);
  for (const f of files) {
    hash.update(' ');
    hash.update(f.ref);
    hash.update(' ');
    hash.update(f.content);
  }
  return hash.digest('hex');
}

function buildVersionMarker(pack, files) {
  return JSON.stringify({
    packId: pack.packId,
    version: pack.version,
    contentHash: computePackContentHash(pack, files),
  });
}

// ---------------------------------------------------------------------------
// Remote command construction — every write goes through base64 + a
// path-validated target inside the pack's own subdirectory.
// ---------------------------------------------------------------------------

function remoteBaseDir(subdir) {
  sanitizePackSubdir(subdir);
  return `${REMOTE_SKILLS_ROOT}/${subdir}`;
}

// Builds one `mkdir -p ... && echo '<base64>' | base64 -d > ...` clause for
// a single file, with the target re-validated against the pack's remote
// base dir (same traversal check used for the local read path, applied
// again here so a bad `ref` can never reach either side of the write).
// F1 (field report examplevpn-db02, 2026-08-15): Claude Code only discovers
// skills at ~/.claude/skills/<name>/SKILL.md — it does not recurse. The v3
// pack nested everything under the pack subdir, so every delivered skill was
// INVISIBLE to the host's Claude. Skill-type entries therefore install FLAT
// under ~/.claude/skills/<ref> (the ref already carries the skill dir name);
// the pack subdir keeps only non-skill artifacts (rule sources, the version
// marker). The pack owns the skill names it ships and overwrites them.
//
// P8 (DEVSUITE runtime layer): 'file'-type entries are the runtime tools the
// owner wants a dev-enabled host to "feel" — metron, precompacticus, the
// statusline. They install under $HOME/.claude/<dest||ref> (REMOTE_CLAUDE_ROOT,
// one level up from skills), with `opts.dest` overriding the install path when
// it differs from the source ref, and `opts.mode` an octal chmod applied after
// the write (e.g. '755' for an executable). Same base64 + traversal-validation
// posture as every other write.
function buildFileWriteClause(subdir, ref, content, type = 'skill', opts = {}) {
  let base;
  let relPath;
  if (type === 'file') {
    base = REMOTE_CLAUDE_ROOT;
    relPath = opts.dest || ref;
  } else if (type === 'skill') {
    base = REMOTE_SKILLS_ROOT;
    relPath = ref;
  } else {
    base = remoteBaseDir(subdir);
    relPath = ref;
  }
  // Re-run the same traversal validation against the *remote* base so a
  // ref (or dest) that somehow only escaped the local check (it can't, both
  // use the identical function, but this keeps the remote path construction
  // from ever trusting a value that wasn't independently re-checked here) is
  // still caught before it reaches the command string.
  const { clean } = sanitizeRelPath(base, relPath);
  const remotePath = `$HOME/${base}/${clean}`;
  const remoteDir = `$HOME/${base}/${path.dirname(clean)}`;
  const base64 = Buffer.from(content, 'utf8').toString('base64');
  // Defence in depth: base64 output is alphanumeric + `/+=` only and can
  // never contain a `'`, so it cannot break out of this single-quoted
  // shell literal — but assert that invariant rather than assume it.
  if (!/^[A-Za-z0-9+/=]*$/.test(base64)) {
    throw new Error('skillPackInstaller: base64 encoding produced unexpected characters');
  }
  // "$HOME/..." double-quoted: a single-quoted $HOME is taken literally by
  // the remote shell (it would mkdir a directory NAMED $HOME). Paths are
  // sanitized to [A-Za-z0-9._/-] so double quotes are safe. Found 2026-08-15.
  let clause = `mkdir -p "${remoteDir}" && echo '${base64}' | base64 -d > "${remotePath}"`;
  if (type === 'file' && opts.mode !== undefined && opts.mode !== null) {
    // Reject a non-octal mode rather than escaping it (reject-never-escape).
    if (!FILE_MODE_PATTERN.test(opts.mode)) {
      throw new Error(`skillPackInstaller: invalid file mode '${opts.mode}'`);
    }
    clause += ` && chmod ${opts.mode} "${remotePath}"`;
  }
  return clause;
}

// RULES RENDERING (DEVSUITE-SKILLS seq 5): entries of type 'rule' also render
// into MANAGED MARKER BLOCKS in the user-level rules files of BOTH backends,
// $HOME/.claude/CLAUDE.md (Claude Code) and $HOME/.codex/AGENTS.md (Codex) —
// the QSKL backend-neutral pattern applied to rules. Idempotent by
// delete-markers-then-append; nothing outside the markers is ever touched.
// The body travels base64 (same injection posture as file writes).
function buildRulesRenderClause(pack, ruleFiles) {
  if (!ruleFiles.length) return null;
  const subdir = sanitizePackSubdir(pack.subdir);
  const beginMarker = `# >>> ${subdir} rules >>>`;
  const endMarker = `# <<< ${subdir} rules <<<`;
  const body = ruleFiles.map((f) => f.content).join('\n');
  const bodyB64 = Buffer.from(body, 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/=]*$/.test(bodyB64)) {
    throw new Error('skillPackInstaller: base64 encoding produced unexpected characters');
  }
  const targets = '"$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md"';
  return (
    `mkdir -p "$HOME/.claude" "$HOME/.codex" && for QT in ${targets}; do ` +
    `touch "$QT" && ` +
    `sed -i '/^${beginMarker}$/,/^${endMarker}$/d' "$QT" && ` +
    `{ printf '\n%s\n' '${beginMarker}'; echo '${bodyB64}' | base64 -d; printf '%s\n' '${endMarker}'; } >> "$QT"` +
    `; done`
  );
}

// ARG-LIMIT (2026-08-15): Linux caps a single exec argument at 128KB
// (MAX_ARG_STRLEN). The v3 pack's all-in-one command reached 269KB and every
// remote write failed on the FIRST real install this surface ever ran. The
// installer therefore executes ONE Bastion call per clause: files first,
// then the rules render, then the version marker LAST — so a partially
// written pack can never carry the marker that says it is complete.
function buildInstallClauses(pack, files) {
  const clauses = files.map((f) => ({
    label: f.ref,
    command: buildFileWriteClause(pack.subdir, f.ref, f.content, f.type, { dest: f.dest, mode: f.mode }),
  }));
  // Legacy v3 cleanup: remove the nested-and-invisible skill copies from the
  // old pack-subdir location so a host never carries two divergent copies.
  // Scoped strictly to skill dirs INSIDE the pack subdir; the marker and rule
  // sources stay.
  const legacyDirs = [...new Set(
    files.filter((f) => f.type === 'skill').map((f) => sanitizeRelPath(remoteBaseDir(pack.subdir), f.ref).clean.split('/')[0])
  )];
  if (legacyDirs.length) {
    clauses.push({
      label: 'legacy-nested-cleanup',
      command: legacyDirs.map((d) => `rm -rf "$HOME/${remoteBaseDir(pack.subdir)}/${d}"`).join(' && '),
    });
  }
  const rulesClause = buildRulesRenderClause(pack, files.filter((f) => f.type === 'rule'));
  if (rulesClause) clauses.push({ label: 'rules-render', command: rulesClause });
  // DEVSUITE runtime layer (P8): if the pack shipped the settings wiring tool,
  // run it now — AFTER every file (including the tool itself) is on disk, and
  // BEFORE the version marker, so a wiring failure aborts the install without
  // leaving the "complete" marker. The path is a fixed literal, and the tool
  // is signed pack content already verified upstream.
  if (files.some((f) => f.type === 'file' && f.ref === SETTINGS_WIRE_REF)) {
    clauses.push({
      label: 'settings-wire',
      command: `python3 "$HOME/${REMOTE_CLAUDE_ROOT}/${SETTINGS_WIRE_REF}"`,
    });
  }
  // SKILLRIGHTS Phase 9: the rights manifest goes over the wire BEFORE the
  // version marker (marker stays last, see ARG-LIMIT note above), so a host
  // carrying the "install complete" marker always carries its rights record.
  const rightsManifest = JSON.stringify({
    packId: pack.packId,
    version: pack.version,
    rights: summarizePackRights(files).entries,
  });
  const rightsBase64 = Buffer.from(rightsManifest, 'utf8').toString('base64');
  const rightsBase = remoteBaseDir(pack.subdir);
  clauses.push({
    label: 'rights-manifest',
    command: `mkdir -p "$HOME/${rightsBase}" && echo '${rightsBase64}' | base64 -d > "$HOME/${rightsBase}/${RIGHTS_MANIFEST_FILE}"`,
  });
  const marker = buildVersionMarker(pack, files);
  const markerBase64 = Buffer.from(marker, 'utf8').toString('base64');
  const base = remoteBaseDir(pack.subdir);
  clauses.push({
    label: 'version-marker',
    command: `mkdir -p "$HOME/${base}" && echo '${markerBase64}' | base64 -d > "$HOME/${base}/${PACK_VERSION_MARKER_FILE}"`,
  });
  return clauses;
}

function buildInstallCommand(pack, files) {
  const clauses = files.map((f) => buildFileWriteClause(pack.subdir, f.ref, f.content, f.type, { dest: f.dest, mode: f.mode }));
  const rulesClause = buildRulesRenderClause(pack, files.filter((f) => f.type === 'rule'));
  if (rulesClause) clauses.push(rulesClause);
  const marker = buildVersionMarker(pack, files);
  const markerBase64 = Buffer.from(marker, 'utf8').toString('base64');
  const base = remoteBaseDir(pack.subdir);
  clauses.push(`mkdir -p "$HOME/${base}" && echo '${markerBase64}' | base64 -d > "$HOME/${base}/${PACK_VERSION_MARKER_FILE}"`);
  return clauses.join(' && ');
}

function buildStatusCheckCommand(pack) {
  const base = remoteBaseDir(pack.subdir);
  return `cat "$HOME/${base}/${PACK_VERSION_MARKER_FILE}" 2>/dev/null || echo '__QUOX_PACK_NOT_INSTALLED__'`;
}

// ---------------------------------------------------------------------------
// Pack signature verification — cross-service call to quoxflow
// ---------------------------------------------------------------------------

/**
 * Calls quoxflow's `GET /api/skill-packs/:id/verify` to check a pack's
 * signature. Fails closed and NEVER throws: any non-2xx response, a
 * malformed body, or a network/timeout error all resolve to
 * `{ valid: false, reason: 'verification_unavailable' }` — mirroring the
 * "resolve to a safe default, never blow up the caller" discipline used
 * elsewhere in this collector (e.g. gpuNodesStore.js's error paths).
 *
 * @param {string} packId
 * @param {string} [orgId]
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
async function fetchPackVerification(packId, orgId) {
  const url = `${QUOXFLOW_URL}/api/skill-packs/${encodeURIComponent(packId)}/verify`;
  const headers = {
    ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {}),
    ...(orgId ? { 'X-Org-Id': orgId } : {}),
  };

  let response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS),
    });
  } catch (_err) {
    // Network error, timeout, DNS failure, etc. — fail closed, never throw.
    return { valid: false, reason: 'verification_unavailable' };
  }

  if (!response.ok) {
    // Includes 404 (pack not found upstream) and any 5xx — fail closed.
    return { valid: false, reason: 'verification_unavailable' };
  }

  try {
    const body = await response.json();
    // Response shape: { success: true, data: { id, orgId, valid, reason? } }
    const data = body && body.data;
    if (!data || typeof data.valid !== 'boolean') {
      return { valid: false, reason: 'verification_unavailable' };
    }
    return data.reason ? { valid: data.valid, reason: data.reason } : { valid: data.valid };
  } catch (_err) {
    // Malformed JSON — fail closed.
    return { valid: false, reason: 'verification_unavailable' };
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Checks whether `hostId` already has `pack` installed at the current
 * version/content hash, by reading the remote marker file. Never writes
 * anything.
 */
async function checkPackStatus({ callBastion }, hostId, pack) {
  const safeHostId = sanitizeHostId(hostId);
  const files = loadPackFileContents(pack);
  const expectedMarker = buildVersionMarker(pack, files);

  const result = await callBastion(safeHostId, buildStatusCheckCommand(pack));
  const remoteOutput = (result && (result.stdout || '')).trim();

  if (!result || result.success === false) {
    return { installed: false, upToDate: false, reason: 'status_check_failed', error: result && result.error };
  }
  if (remoteOutput === '__QUOX_PACK_NOT_INSTALLED__' || remoteOutput === '') {
    return { installed: false, upToDate: false, reason: 'not_installed' };
  }
  return { installed: true, upToDate: remoteOutput === expectedMarker, remoteMarker: remoteOutput, expectedMarker };
}

/**
 * Resolves the pack for `enabledCapabilities`, verifies signature status
 * (fail-closed), checks whether the host already has it at the current
 * version, and if not, installs it via `callBastion`.
 *
 * `verification` is optional. When the caller passes an explicit
 * pre-verified result, it is used as-is (unchanged behavior — still fails
 * closed unless `{ valid: true }`). When omitted, this function resolves
 * verification itself via `fetchPackVerification()` against quoxflow's
 * `GET /skill-packs/:id/verify` endpoint, scoped to `orgId` (falling back
 * to the pack's own `orgId` when not supplied).
 *
 * @param {{callBastion: Function}} deps
 * @param {{
 *   hostId: string,
 *   enabledCapabilities: string[],
 *   verification?: {valid: boolean, reason?: string},
 *   orgId?: string,
 * }} opts
 */
async function installSkillPack({ callBastion }, { hostId, enabledCapabilities, verification, orgId, pack: packOverride, distributionPolicy }) {
  if (typeof callBastion !== 'function') {
    throw new Error('skillPackInstaller: callBastion dependency is required');
  }

  const safeHostId = sanitizeHostId(hostId);
  // `pack` override is a DI seam (handlers/tests inject their own pack, the
  // same way createSkillPack*Handler already take a `pack` dep) — default
  // resolution is unchanged.
  const pack = packOverride || resolvePackForCapabilities(enabledCapabilities);
  if (!pack) {
    return { installed: false, reason: 'no_matching_pack' };
  }

  // Explicit verification wins when supplied (unchanged contract for
  // existing callers). Otherwise resolve it ourselves via quoxflow's
  // verify endpoint — fail-closed either way. The lookup targets the org the
  // PACK is registered and signed under (the shared core pack lives once,
  // under its own declared org), never the calling host's org: passing the
  // host org made quoxflow return not_found for every cross-org install
  // (found live 2026-08-15 enrolling the ExampleVPN dev servers).
  const resolvedVerification = verification || await fetchPackVerification(pack.packId, pack.orgId || orgId);

  if (!resolvedVerification || resolvedVerification.valid !== true) {
    return {
      installed: false,
      reason: 'unverified_pack',
      error: `Pack signature verification failed or unavailable (${(resolvedVerification && resolvedVerification.reason) || 'unknown'}). `
        + 'Refusing to install without a verified { valid: true } result.',
    };
  }

  // SKILLRIGHTS Phase 9: org distribution policy is evaluated BEFORE any
  // Bastion call (even the read-only status check), so a refused pack never
  // touches the host at all. Unknown/absent policy values resolve to
  // 'allow' inside evaluateDistributionPolicy — a misconfigured setting can
  // never brick fleet sync, it can only decline to restrict it.
  const files = loadPackFileContents(pack);
  const verdict = evaluateDistributionPolicy(distributionPolicy, files, { packOrgId: pack.orgId, hostOrgId: orgId });
  if (!verdict.allowed) {
    return {
      installed: false,
      reason: 'refused_by_rights_policy',
      policy: verdict.policy,
      offendingRefs: verdict.offendingRefs,
      packId: pack.packId,
      rights: summarizePackRights(files),
    };
  }

  const status = await checkPackStatus({ callBastion }, safeHostId, pack);
  if (status.installed && status.upToDate) {
    return { installed: false, reason: 'up_to_date', packId: pack.packId, version: pack.version, rights: summarizePackRights(files) };
  }

  const clauses = buildInstallClauses(pack, files);
  for (const clause of clauses) {
    const result = await callBastion(safeHostId, clause.command);
    if (!result || result.success === false) {
      return {
        installed: false,
        reason: 'write_failed',
        error: `clause '${clause.label}' failed: ${(result && (result.error || result.stderr)) || 'unknown'}`,
        packId: pack.packId,
      };
    }
  }

  return {
    installed: true,
    reason: status.installed ? 'updated' : 'first_install',
    packId: pack.packId,
    version: pack.version,
    files: files.map((f) => f.ref),
    rights: summarizePackRights(files),
  };
}

module.exports = {
  KNOWN_DEV_CAPABILITIES,
  CORE_DEV_PACK,
  RIGHTS_MANIFEST_FILE,
  SETTINGS_WIRE_REF,
  parseSkillLicense,
  inspectSkillLicense,
  classifyLicenseVariant,
  licenseFileNameForVariant,
  summarizePackRights,
  evaluateDistributionPolicy,
  sanitizeHostId,
  sanitizeCapabilities,
  sanitizePackSubdir,
  sanitizeRelPath,
  resolvePackForCapabilities,
  resolveLocalSkillPath,
  resolveLocalFilePath,
  loadPackFileContents,
  buildFileWriteClause,
  computePackContentHash,
  buildVersionMarker,
  buildInstallCommand,
  buildInstallClauses,
  buildRulesRenderClause,
  buildStatusCheckCommand,
  checkPackStatus,
  fetchPackVerification,
  installSkillPack,
};
