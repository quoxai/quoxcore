/**
 * core-dev-pack-seed.ts — the WELL-KNOWN core dev pack manifest quoxflow
 * seeds into its own skill-pack registry at boot (DEVSUITE-SKILLS seq 4).
 *
 * MUST MIRROR the collector's CORE_DEV_PACK
 * (quox-dashboard/services/collector/lib/skillPackInstaller.js): the
 * collector decides WHAT gets installed on a dev server; this registry row
 * is the governance record its verification checks. Nothing enforces the
 * mirror mechanically yet — change BOTH in one commit and bump `version`
 * whenever `contents` changes, or hosts will verify a manifest that no
 * longer describes what ships (drift finding filed on DEVSUITE-SKILLS).
 */

import type { CreatePackInput } from './skill-pack-store.js';

export const CORE_DEV_PACK_SEED: CreatePackInput & { id: string } = {
  id: 'quox-core-dev-pack',
  orgId: 'default',
  // v3 (QUOXPERTICUS P5): + the 14 public quoxpert sub-skills.
  // v4 (F1 fix, 2026-08-15): skills install FLAT at ~/.claude/skills/<name>
  // so Claude Code discovers them; legacy nested copies removed on sync.
  // v5 (quox#453, 2026-08-22): + the discipline loops (proof-loop, fix-loop,
  // tdd, preflight). MIRROR of collector skillPackInstaller.js CORE_DEV_PACK
  // — change both in one commit; coreDevPackMirror.test.js enforces parity.
  // v6 (DEVSUITE-SLOTS, 2026-09-04): + quoxpert-quoxslots, so the rule that
  // tells a session to offer a durable slot address (see the new "QuoxSlots
  // session address" section in quox-dev-rules/RULES.md) has its recipes
  // sitting right beside it. A rule that points at a skill the pack never
  // installs is a dead pointer on any host that only has the core pack.
  // v7 (DEVSUITE runtime layer, P8): + the 'file'-type runtime tools (metron,
  // precompacticus + conf template, the combined statusline, settings-wire.py)
  // so a dev-enabled host visibly FEELS Quox in Claude Code. MIRROR of collector
  // skillPackInstaller.js CORE_DEV_PACK — change both in one commit; the mirror
  // guards enforce parity. dest/mode ride the signed manifest; ref == install
  // path for all of these so no dest override is needed.
  // v8 (2026-10-05): rules layer gains the Brain2 knowledge-recall section; statusline.sh
  // gets a recursion guard and settings-wire.py never saves a wrapper of our own
  // statusline as prior-statusline.cmd (fixed a 14,844-process fork storm). Content-only
  // bump, no entry changes.
  // v9 (BRAIN2-AUDIT, 2026-10-05): + quoxpert-qlarity, quoxpert-security, quoxify. The
  // RULES.md triggers point at them (Qlarity-first, security runs as an
  // engagement, load quoxify before capability work), same dead-pointer logic
  // as quoxslots in v6; both quoxpert skills privacy-swept first.
  version: '9',
  contents: [
    { type: 'skill', ref: 'docker-rebuild/SKILL.md', description: 'quox-build discipline — never docker compose build/up directly' },
    { type: 'skill', ref: 'nucleus/SKILL.md', description: 'RepoBrain discipline — query before grep/read, announce usage' },
    { type: 'skill', ref: 'push-all/SKILL.md', description: 'git discipline — status sweep, commit, push across repos' },
    { type: 'skill', ref: 'verify/SKILL.md', description: 'build/test verification after any code change' },
    // v2 (DEVSUITE-SKILLS seq 5): dev tools must be discovered, not known
    // about — plus the backend-neutral rules layer (CLAUDE.md + AGENTS.md).
    { type: 'skill', ref: 'context-load/SKILL.md', description: 'front-load architecture context at session start' },
    { type: 'skill', ref: 'codebase-mirror/SKILL.md', description: 'regenerate the codebase map from actual code' },
    // v5: the discipline loops (see version note above).
    { type: 'skill', ref: 'proof-loop/SKILL.md', description: 'claim to shipped evidence — drive the real surface, file every gap' },
    { type: 'skill', ref: 'fix-loop/SKILL.md', description: 'bug to passing test — failing test first, three attempts max' },
    { type: 'skill', ref: 'tdd/SKILL.md', description: 'strict TDD loop — failing tests first, full suite after every change' },
    { type: 'skill', ref: 'preflight/SKILL.md', description: 'blast-radius analysis before risky changes' },
    { type: 'rule', ref: 'quox-dev-rules/RULES.md', description: 'trigger discipline rendered to CLAUDE.md + AGENTS.md' },
    // v3 (QUOXPERTICUS P5, 2026-08-15): the public quoxpert family — a
    // dev-enabled host's Claude is a Quox operator out of the box. Internal
    // sub-skills (devsuite/discord/qlarity/qloop/security) deliberately out.
    // v6 adds quoxpert-quoxslots as a deliberate exception ahead of that
    // bar: it is the recipe the RULES.md "QuoxSlots session address" rule
    // points every session at, so it ships with the pack rather than being
    // a dead pointer.
    { type: 'skill', ref: 'quoxpert/SKILL.md', description: 'quoxpert router — orient, then load the matching sub-skill' },
    { type: 'skill', ref: 'quoxpert-core/SKILL.md', description: 'QuoxCORE platform orientation' },
    { type: 'skill', ref: 'quoxpert-cli/SKILL.md', description: 'the quox CLI and TUI' },
    { type: 'skill', ref: 'quoxpert-mcp/SKILL.md', description: 'QuoxMCP install and tool surface' },
    { type: 'skill', ref: 'quoxpert-flow/SKILL.md', description: 'quoxflow workflows, policies, HITL' },
    { type: 'skill', ref: 'quoxpert-bastion/SKILL.md', description: 'fleet hosts and governed exec' },
    { type: 'skill', ref: 'quoxpert-plugin-sdk/SKILL.md', description: 'building .quoxplugin extensions' },
    { type: 'skill', ref: 'quoxpert-protocols/SKILL.md', description: 'AEE, AOCL, VOLT, WARD' },
    { type: 'skill', ref: 'quoxpert-deploy/SKILL.md', description: 'install, upgrade, backup, restore' },
    { type: 'skill', ref: 'quoxpert-qluster/SKILL.md', description: 'multi-instance fleet control plane' },
    { type: 'skill', ref: 'quoxpert-convert/SKILL.md', description: 'convert an existing tool into a plugin' },
    { type: 'skill', ref: 'quoxpert-publish/SKILL.md', description: 'plugin signing and distribution, honest maturity' },
    { type: 'skill', ref: 'quoxpert-repobrain/SKILL.md', description: 'code intelligence discipline' },
    { type: 'skill', ref: 'quoxpert-quoxplan/SKILL.md', description: 'roadmap and stream planning' },
    { type: 'skill', ref: 'quoxpert-quoxslots/SKILL.md', description: 'durable session addresses — checkout, say, steer, release' },
    { type: 'skill', ref: 'quoxpert-qlarity/SKILL.md', description: 'governed browser inspection — inspectors, approvals' },
    { type: 'skill', ref: 'quoxpert-security/SKILL.md', description: 'QuoxSecurity engagements, scopes, scans' },
    { type: 'skill', ref: 'quoxify/SKILL.md', description: 'Quox house standard before any plugin/agent/capability work' },
    // v7 (DEVSUITE runtime layer, P8): 'file'-type entries, installed to
    // ~/.claude/<ref> (ref == install path), executables at mode 755. The
    // collector runs settings-wire.py after the writes to merge the hooks +
    // statusLine into settings.json.
    { type: 'file', ref: 'metron/metron.py', mode: '755', description: 'Metron — session-usage monitor + subagent-cooldown gate + statusline segment' },
    { type: 'file', ref: 'precompacticus/precompacticus.py', mode: '755', description: 'Precompacticus — context meter + pre-compaction snapshot/nudge + statusline segment' },
    { type: 'file', ref: 'precompacticus/precompacticus.conf.example', description: 'Precompacticus config template (copy to precompacticus.conf to customise)' },
    { type: 'file', ref: 'quox-devsuite/statusline.sh', mode: '755', description: 'DevSuite combined statusline — context + usage segments, composes onto any prior statusline' },
    { type: 'file', ref: 'quox-devsuite/settings-wire.py', mode: '755', description: 'safe-merge the DevSuite hooks + statusLine into ~/.claude/settings.json (backup, idempotent, non-clobbering)' },
  ],
};
