/**
 * 'skills.*' endpoints — WP2.3 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #3).
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Skill execution, the QSKL-SAFETY review queue, and Crystal lifecycle
 * writes (from-execution / promote-draft / rollback-to-version). All of
 * these are DIRECT to quoxflow (service: 'quoxflow', port 3200), NOT
 * proxied by the collector — the collector only hand-mounts three
 * read-only proxy routes (GET /quoxflow/skills[/:id], evidence,
 * observations; see endpoints/quoxflow.js), confirmed by grepping
 * services/collector/server.js for 'quoxflow'. Same access-path
 * precedent as endpoints/triggers.js and endpoints/workflows.js
 * ('workflows.activate'/'workflows.deactivate').
 *
 * Route provenance (read directly from quoxflow source, not inferred):
 *
 *   - skills.run
 *     POST /api/workflows/:id/execute
 *     quoxflow/src/api/routes/executions.ts:206 (createWorkflowExecuteRoute),
 *     mounted at app.route('/api/workflows', workflowExecuteRoutes) (app.ts:243).
 *     Body: { triggerData?, async?: boolean (default false), orgId?: string }.
 *     Sync (default): runs to completion, 200/500 with the execution result.
 *     Async (async:true): fire-and-forget, 202 { executionId, status: 'running' }.
 *     "Crystals ARE workflows" — running a skill/crystal IS this route with
 *     the skill's/crystal's sourceWorkflowId as :id.
 *
 *   - skills.reviewQueue.list / .get / .approve / .reject
 *     quoxflow/src/api/routes/quox-skills.ts:392-553 (QSKL-SAFETY.F).
 *     GET  /api/quox-skills/review-queue?status=pending|approved|rejected
 *          (defaults to 'pending' if status is omitted/invalid)
 *     GET  /api/quox-skills/review-queue/:qid
 *     POST /api/quox-skills/review-queue/:qid/approve  body: { comment?: string }
 *     POST /api/quox-skills/review-queue/:qid/reject   body: { comment?: string }
 *     Org-scoped correctly (verified, unlike the triggers.* cross-tenant
 *     finding): resolveOrgId() takes orgId from the JWT in prod; each row's
 *     org_id is checked against the caller's orgId, 403 on mismatch, and the
 *     list query itself is `listByStatus(status, orgId)` — this route does
 *     NOT reproduce the unscoped-list bug found in quoxflow triggers.
 *
 *   - skills.fromExecution / .promoteDraft / .rollbackToVersion
 *     quoxflow/src/api/routes/skills.ts (legacy Crystal Skill Library,
 *     mounted at app.route('/api/skills', skillsRoutes), app.ts ~256).
 *     POST /api/skills/from-execution      body: { workflowId, workflowName? }
 *       Idempotent: 200 + existing record if one already exists for the
 *       source workflow, else 201 on fresh crystallisation, 422 NOT_READY
 *       if the execution history doesn't yet support crystallisation.
 *     POST /api/skills/promote-draft       body: { executionId, orgTier? }
 *       orgTier defaults to 'tier_a' (blocked, 402) if omitted — CLI must
 *       pass --tier tier_b explicitly to succeed.
 *     POST /api/skills/rollback-to-version body: { sourceWorkflowId, targetVersion: number }
 *       Writes a NEW version copying the target version's content (201), or
 *       200 + the unchanged latest if targetVersion is already latest.
 */

export const skills = {
  // SKILLRIGHTS #478 Phase 14, sealed execution pilot. Collector routes
  // (server.js /api/v1/skills/sealed[...]): the sealed content lives at the
  // collector, encrypted at rest, and is never returned by the read routes
  // below, only the manifest (name, description, inputContract,
  // contentSha256, createdAt) comes back. See
  // docs/SEALED_EXECUTION_PILOT_DESIGN.md for the full contract and the
  // binding claims language every one of these commands must carry.
  'skills.sealed.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/skills/sealed`,
    tags: ['skip-live'], // uploads real skill content; never in a live-contract sweep
  },
  'skills.sealed.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/skills/sealed`,
    tags: ['live-safe'],
  },
  'skills.sealed.get': {
    method: 'GET',
    service: 'collector',
    path: ({ sealedId }) => `/api/v1/skills/sealed/${sealedId}`,
    tags: ['live-safe'],
  },
  'skills.sealed.invoke': {
    method: 'POST',
    service: 'collector',
    path: ({ sealedId }) => `/api/v1/skills/sealed/${sealedId}/invoke`,
    tags: ['skip-live'], // executes real methodology with real side effects
  },
  // SKILLRIGHTS #478 Phase 10 — governed skill protection. Unlike every
  // other fragment here these two ARE collector routes (server.js
  // /api/v1/skills/protect + /protections): the collector owns the org
  // signing call, the open-registry registration and the AEE/WARD witness.
  'skills.protect': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/skills/protect`,
    tags: ['skip-live'], // registers in the real public registry; never in a live-contract sweep
  },
  'skills.protections': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/skills/protections`,
    tags: ['live-safe'],
  },
  // SKILLRIGHTS #478 Phase 11 — affirmative acceptance (collector). The offer
  // presents the exact artefact hash, declared rights, terms bytes and a
  // single-use challenge; the POST records assent to exactly that, before any
  // download under the 'require-acceptance' policy is authorized. Both are
  // USER-only server-side: a service key is refused with user_assent_required,
  // so neither belongs in a service-credentialled live sweep.
  'skills.acceptance.offer': {
    method: 'GET',
    service: 'collector',
    path: ({ packId } = {}) => `/api/v1/skills/acceptance/offer${packId ? `?packId=${encodeURIComponent(packId)}` : ''}`,
    tags: ['skip-live'],
  },
  'skills.acceptance.record': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/skills/acceptance`,
    tags: ['skip-live'], // records a real, append-only acceptance of licence terms
  },
  // Phase 12: the org rights disclosure ledger (read-model, collector).
  'skills.rightsLedger': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/skills/rights-ledger`,
    tags: ['live-safe'],
  },
  'skills.fromExecution': {
    method: 'POST',
    service: 'quoxflow',
    path: () => `/api/skills/from-execution`,
    tags: ['live-write'],
  },
  'skills.promoteDraft': {
    method: 'POST',
    service: 'quoxflow',
    path: () => `/api/skills/promote-draft`,
    tags: ['live-write'],
  },
  'skills.reviewQueue.approve': {
    method: 'POST',
    service: 'quoxflow',
    path: ({ qid }) => `/api/quox-skills/review-queue/${qid}/approve`,
    tags: ['live-write'],
  },
  'skills.reviewQueue.get': {
    method: 'GET',
    service: 'quoxflow',
    path: ({ qid }) => `/api/quox-skills/review-queue/${qid}`,
    tags: ['live-safe'],
  },
  'skills.reviewQueue.list': {
    method: 'GET',
    service: 'quoxflow',
    path: () => `/api/quox-skills/review-queue`,
    tags: ['live-safe'],
  },
  'skills.reviewQueue.reject': {
    method: 'POST',
    service: 'quoxflow',
    path: ({ qid }) => `/api/quox-skills/review-queue/${qid}/reject`,
    tags: ['live-write'],
  },
  'skills.rollbackToVersion': {
    method: 'POST',
    service: 'quoxflow',
    path: () => `/api/skills/rollback-to-version`,
    tags: ['live-write'],
  },
  // POST /api/workflows/:id/execute — deliberately NOT tagged 'live-write'.
  // It actually runs a workflow/crystal (side effects beyond a rejected
  // write); 'skip-live' keeps it out of the live-contract harness entirely
  // per the WP2.3 brief ("Do NOT seed execute as live").
  'skills.run': {
    method: 'POST',
    service: 'quoxflow',
    path: ({ id }) => `/api/workflows/${id}/execute`,
    tags: ['skip-live'],
  },
};
