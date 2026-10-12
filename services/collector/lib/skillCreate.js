'use strict';

/**
 * createPendingSkill: the ONE place a pending-review skill is created over
 * HTTP in quoxflow (POST /api/quox-skills). Shared by the skill_manage chat
 * tool (lib/agentTools.js) and NotesQ propose-skill (lib/notesq/api.js).
 *
 * The edition is forced to 'experimental', whatever the caller says. With
 * input.requireHumanReview (agent-authored), quoxflow also queues a human
 * review row and refuses to load the skill until a person approves it (#748).
 * The declared licence is stamped AT CREATION (SKILLRIGHTS-8): explicit input
 * wins, else the org default QSKL_DEFAULT_SKILL_LICENSE, else undeclared.
 *
 * ctx = { orgId, token?, userId?, agentId? }.
 * Resolves { ok:true, status, skill } or { ok:false, status, error, message }.
 * Never throws.
 */

const configResolver = require('./configResolver.js');

async function createPendingSkill(ctx, input) {
  const i = input || {};
  const payload = {
    orgId: ctx.orgId,
    scopeId: null,
    name: i.name,
    category: i.category,
    description: i.description,
    bodyMd: i.bodyMd,
    author: ctx.userId || ctx.agentId || 'chat-agent',
    tags: Array.isArray(i.tags) ? i.tags : [],
    bestForAgents: i.bestForAgents || (ctx.agentId ? [ctx.agentId] : []),
    requiredTools: i.requiredTools || [],
    kind: 'procedural',
    edition: 'experimental'
  };
  // quox#748: an AGENT-authored skill is queued for human review in quoxflow
  // and cannot be loaded by skill_view until a person approves it. A person
  // acting directly (e.g. proposing their own note) is the authorization.
  if (i.requireHumanReview === true) {
    payload.requireHumanReview = true;
    payload.reviewSource = i.reviewSource || 'chat';
  }

  const explicitLicense = typeof i.license === 'string' ? i.license.trim() : '';
  const defaultLicense = String(configResolver.getSetting(ctx.orgId, 'QSKL_DEFAULT_SKILL_LICENSE').value || '').trim();
  const stampedLicense = explicitLicense || defaultLicense;
  if (stampedLicense) payload.license = stampedLicense;

  const FLOW_URL = process.env.QUOXFLOW_URL || 'http://quoxflow:3200';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';

  try {
    const res = await fetch(`${FLOW_URL}/api/quox-skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ctx.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
        ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
        ...(ctx.orgId ? { 'X-Org-ID': ctx.orgId } : {})
      },
      body: JSON.stringify(payload)
    });
    const body = await res.json();
    if (!res.ok) {
      return { ok: false, status: res.status, error: body.error || 'create_failed', message: body.message || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, skill: body.data || body };
  } catch (err) {
    return { ok: false, status: 502, error: 'create_failed', message: `Failed to create skill: ${err.message}` };
  }
}

module.exports = { createPendingSkill };
