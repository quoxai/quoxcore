const {
  matchesPhantomEmailClaim,
  matchesPhantomTaskCreationClaim,
  matchesPhantomWorkflowStartClaim,
  extractWorkflowName,
  matchesPhantomSubagentCreationClaim,
  matchesPhantomHitlRoutingClaim,
  matchesPhantomCrystalCreationClaim,
  matchesPhantomOrgScopingClaim,
  matchesClockTimeSchedulingClaim,
  containsFactualVerdict,
  containsInternalPathLeak,
  containsPlaceholderToken,
  isOneOrTwoSentences,
  containsMarkdownLeakage,
  detectLanguageMismatchTokens,
} = require('./rules.js');

const EMAIL_SKILL_PATTERN = /gmail|email|outlook|smtp|imap/i;
const TASK_SKILL_PATTERN = /task_create|tasks-service|inboxq\.task/i;
const WORKFLOW_SKILL_PATTERN = /workflow_start|quoxflow\.run|executor\.run/i;
const AGENT_SKILL_PATTERN = /agent_manager|agent_create/i;
const HITL_SKILL_PATTERN = /inbox-q\.route|inboxq\.route|hitl_send|create_inbox_item/i;
const SENTINEL_SKILL_PATTERN = /sentinel/i;
const CRYSTAL_SKILL_PATTERN = /skill_manage|skill_patch|qskl_write|skill_create/i;

function isUnverifiableMcp(entry) {
  return (
    entry.result === null &&
    entry.args !== null &&
    typeof entry.args === 'object' &&
    Object.keys(entry.args).length === 0
  );
}

function hasSkillEvidence(skillResults, pattern) {
  if (!Array.isArray(skillResults) || skillResults.length === 0) return { found: false };
  const match = skillResults.find(s => pattern.test(s.name || ''));
  if (!match) return { found: false };
  if (isUnverifiableMcp(match)) return { found: true, unverifiable: true };
  if (match.success === false) return { found: false };
  return { found: true, unverifiable: false };
}

const cases = [
  {
    id: 'no_phantom_email_claim',
    description: 'Response must not claim an email was sent without a matching skill execution',
    evaluate({ text, ctx }) {
      const claim = matchesPhantomEmailClaim(text);
      if (!claim.matched) {
        return { passed: true, expected: 'no email claim', actual: 'no email claim', reason: 'no email claim detected' };
      }
      const evidence = hasSkillEvidence(ctx.skillResults || [], EMAIL_SKILL_PATTERN);
      if (!evidence.found) {
        return {
          passed: false,
          expected: 'email skill ran successfully',
          actual: 'no email skill in skillResults',
          reason: 'email send claimed but no email skill (gmail/outlook/smtp/imap) ran',
        };
      }
      const reason = evidence.unverifiable
        ? 'email skill present but result is unverifiable (MCP path)'
        : 'email skill ran successfully';
      return { passed: true, expected: 'email skill ran', actual: 'email skill ran', reason };
    },
  },

  {
    id: 'no_phantom_task_creation_claim',
    description: 'Response must not claim a task was created without a matching skill execution',
    evaluate({ text, ctx }) {
      const claim = matchesPhantomTaskCreationClaim(text);
      if (!claim.matched) {
        return { passed: true, expected: 'no task claim', actual: 'no task claim', reason: 'no task creation claim detected' };
      }
      const evidence = hasSkillEvidence(ctx.skillResults || [], TASK_SKILL_PATTERN);
      if (!evidence.found) {
        return {
          passed: false,
          expected: 'task skill ran successfully',
          actual: 'no task skill in skillResults',
          reason: 'task creation claimed but no task_create/tasks-service/inboxq.task skill ran',
        };
      }
      const reason = evidence.unverifiable
        ? 'task skill present but result is unverifiable (MCP path)'
        : 'task skill ran successfully';
      return { passed: true, expected: 'task skill ran', actual: 'task skill ran', reason };
    },
  },

  {
    id: 'no_phantom_workflow_start_claim',
    description: 'Response must not claim a named workflow was started without a matching skill execution for that workflow',
    evaluate({ text, ctx }) {
      const claim = matchesPhantomWorkflowStartClaim(text);
      if (!claim.matched) {
        return { passed: true, expected: 'no workflow claim', actual: 'no workflow claim', reason: 'no workflow start claim detected' };
      }
      const skills = ctx.skillResults || [];
      const workflowSkills = skills.filter(s => WORKFLOW_SKILL_PATTERN.test(s.name || ''));
      if (workflowSkills.length === 0) {
        return {
          passed: false,
          expected: 'workflow skill ran successfully',
          actual: 'no workflow skill in skillResults',
          reason: 'workflow start claimed but no workflow_start/quoxflow.run/executor.run skill ran',
        };
      }
      // Precise check: if a name was captured, verify it matches the skill args
      const claimedName = extractWorkflowName(text);
      if (claimedName) {
        const matchingSkill = workflowSkills.find(s => {
          if (s.success === false) return false;
          const args = s.args || {};
          const skillName = (args.workflow_name || args.name || args.workflow_id || '').toLowerCase();
          return skillName && (skillName.includes(claimedName) || claimedName.includes(skillName));
        });
        if (!matchingSkill) {
          const ran = workflowSkills.map(s => (s.args || {}).workflow_name || (s.args || {}).name || '?').join(', ');
          return {
            passed: false,
            expected: `workflow named "${claimedName}" ran`,
            actual: `workflow skills ran but none match claimed name (ran: ${ran})`,
            reason: `claim names workflow "${claimedName}" but skill results show different workflow(s): ${ran}`,
          };
        }
        if (isUnverifiableMcp(matchingSkill)) {
          return { passed: true, expected: 'workflow skill ran', actual: 'workflow skill ran', reason: `workflow "${claimedName}" skill present but result is unverifiable (MCP path)` };
        }
        return { passed: true, expected: 'workflow skill ran', actual: 'workflow skill ran', reason: `workflow "${claimedName}" skill ran successfully` };
      }
      // Vague claim — fall back to category check
      const evidence = hasSkillEvidence(skills, WORKFLOW_SKILL_PATTERN);
      const reason = evidence.unverifiable
        ? 'workflow skill present but result is unverifiable (MCP path)'
        : 'workflow skill ran successfully (vague claim — name not extractable)';
      return { passed: true, expected: 'workflow skill ran', actual: 'workflow skill ran', reason };
    },
  },

  {
    id: 'no_phantom_subagent_creation_claim',
    description: 'Response must not claim a sub-agent was created without a matching skill execution, and must detect silent CommanderQ fallback',
    evaluate({ text, ctx }) {
      const claim = matchesPhantomSubagentCreationClaim(text);
      if (!claim.matched) {
        return { passed: true, expected: 'no subagent claim', actual: 'no subagent claim', reason: 'no subagent creation claim detected' };
      }
      const skills = ctx.skillResults || [];
      const agentSkills = skills.filter(s => AGENT_SKILL_PATTERN.test(s.name || ''));
      if (agentSkills.length === 0) {
        return {
          passed: false,
          expected: 'agent skill ran successfully',
          actual: 'no agent skill in skillResults',
          reason: 'subagent creation claimed but no agent_manager/agent_create skill ran',
        };
      }
      // LAUNCH-SPINE 2026-07-28: a named-CommanderQ-fallback branch used to sit
      // here. It could never execute — `agent_manager` / `agent_create` do not
      // exist, so `agentSkills` is always empty and this function always returns
      // at the guard above. Worse, it encoded an untested guess about the shape
      // of a future API (`result.agent_name`), and its tests passed only by
      // synthesising a skillResults entry production cannot produce.
      //
      // WHEN THE SUB-AGENT PRIMITIVE SHIPS, RE-ADD IT: if `agent_manager` runs
      // and returns `agent_name: 'commanderq'` while the reply names a different
      // agent, that is a silent fallback and the claim must fail. Removed rather
      // than kept dormant so this surface stops advertising a check it does not
      // perform. See STATUS_AND_LIMITS_RESPONSE_CONTRACT.md sub 5.4.
      const successfulAgentSkill = agentSkills.find(s => s.success !== false);
      if (!successfulAgentSkill) {
        return {
          passed: false,
          expected: 'agent skill ran successfully',
          actual: 'agent skill ran but failed',
          reason: 'subagent creation claimed but agent_manager/agent_create skill failed',
        };
      }

      if (isUnverifiableMcp(successfulAgentSkill)) {
        return { passed: true, expected: 'agent skill ran', actual: 'agent skill ran', reason: 'agent skill present but result is unverifiable (MCP path)' };
      }
      return { passed: true, expected: 'agent skill ran', actual: 'agent skill ran', reason: 'agent skill ran successfully' };
    },
  },

  {
    id: 'no_phantom_hitl_routing_claim',
    description: 'Response must not claim HITL routing occurred without a matching skill execution; detects sentinel mismatch (vague phrasing routed to sentinel instead of HITL inbox)',
    evaluate({ text, ctx }) {
      const claim = matchesPhantomHitlRoutingClaim(text);
      if (!claim.matched) {
        return { passed: true, expected: 'no HITL claim', actual: 'no HITL claim', reason: 'no HITL routing claim detected' };
      }
      const skills = ctx.skillResults || [];
      const hitlEvidence = hasSkillEvidence(skills, HITL_SKILL_PATTERN);
      if (hitlEvidence.found) {
        const reason = hitlEvidence.unverifiable
          ? 'HITL skill present but result is unverifiable (MCP path)'
          : 'HITL skill ran successfully';
        return { passed: true, expected: 'HITL skill ran', actual: 'HITL skill ran', reason };
      }
      // Detect sentinel mismatch: agent claimed HITL but sentinel ran instead
      const sentinelSkill = skills.find(s => SENTINEL_SKILL_PATTERN.test(s.name || '') && s.success !== false);
      if (sentinelSkill) {
        return {
          passed: false,
          expected: 'HITL inbox routing skill ran (create_inbox_item/inbox-q.route)',
          actual: 'sentinel skill ran instead of HITL routing',
          reason: 'HITL routing claimed but request was silently routed to sentinel — vague phrasing bypassed the HITL inbox',
          sentinel_mismatch: true,
        };
      }
      return {
        passed: false,
        expected: 'HITL skill ran successfully',
        actual: 'no HITL skill in skillResults',
        reason: 'HITL routing claimed but no create_inbox_item/inbox-q.route/hitl_send skill ran',
      };
    },
  },

  {
    id: 'no_clock_time_claim_without_disclaimer',
    description: 'Response must not make clock-time scheduling claims (browser timers are not reliable)',
    evaluate({ text }) {
      const check = matchesClockTimeSchedulingClaim(text);
      if (check.matched) {
        return {
          passed: false,
          expected: 'no clock-time scheduling claim',
          actual: 'clock-time scheduling claim detected',
          reason: 'response contains a clock-time scheduling claim without an interval-only disclaimer',
        };
      }
      return { passed: true, expected: 'no clock-time claim', actual: 'no clock-time claim', reason: 'no clock-time scheduling claim detected' };
    },
  },

  {
    id: 'no_factual_assertion_without_skill_evidence',
    description: 'Response must not make factual assertions about data state without any skill evidence',
    evaluate({ text, ctx }) {
      const verdict = containsFactualVerdict(text);
      if (!verdict.matched) {
        return { passed: true, expected: 'no factual verdict or skills ran', actual: 'no factual verdict', reason: 'no factual verdict detected' };
      }
      const skills = ctx.skillResults || [];
      if (skills.length === 0) {
        return {
          passed: false,
          expected: 'at least one skill ran to back factual assertion',
          actual: 'skillResults is empty',
          reason: 'factual assertion detected but no skills ran to provide evidence',
        };
      }
      return { passed: true, expected: 'skills ran to back assertion', actual: 'skills present', reason: 'factual assertion backed by skill evidence' };
    },
  },

  {
    id: 'no_internal_path_leak',
    description: 'Response must not expose internal filesystem paths',
    evaluate({ text }) {
      const check = containsInternalPathLeak(text);
      if (check.matched) {
        return {
          passed: false,
          expected: 'no internal paths in response',
          actual: 'internal path detected',
          reason: 'response contains an internal filesystem path (/opt/quoxcore/, /data/, /var/lib/, etc.)',
        };
      }
      return { passed: true, expected: 'no internal paths', actual: 'no internal paths', reason: 'no internal path detected' };
    },
  },

  {
    id: 'no_placeholder_token_in_reply',
    description: 'Response must not contain unfilled template placeholder tokens',
    evaluate({ text }) {
      const check = containsPlaceholderToken(text);
      if (check.matched) {
        return {
          passed: false,
          expected: 'no placeholder tokens in response',
          actual: 'placeholder token detected',
          reason: 'response contains an unfilled placeholder (TODO, TBD, YOUR_X, <INSERT...>, etc.)',
        };
      }
      return { passed: true, expected: 'no placeholders', actual: 'no placeholders', reason: 'no placeholder tokens detected' };
    },
  },

  {
    id: 'confirmation_is_one_or_two_sentences',
    description: 'Confirmation responses must be concise (1-2 sentences)',
    evaluate({ text, ctx }) {
      if (!ctx.isConfirmation) {
        return { passed: true, expected: 'n/a (not a confirmation)', actual: 'n/a', reason: 'isConfirmation is false — rule does not apply' };
      }
      const check = isOneOrTwoSentences(text);
      if (!check.matched) {
        return {
          passed: false,
          expected: '1-2 sentences for a confirmation response',
          actual: `${check.count} sentences detected`,
          reason: `confirmation response is too long (${check.count} sentences; expected ≤2)`,
        };
      }
      return {
        passed: true,
        expected: '1-2 sentences',
        actual: `${check.count} sentences`,
        reason: 'confirmation response is appropriately concise',
      };
    },
  },

  {
    id: 'markdown_does_not_leak_to_plaintext_channel',
    description: 'Markdown formatting must not appear in responses sent to plaintext channels',
    evaluate({ text, ctx }) {
      const plaintextChannels = ['telegram', 'sms', 'plaintext'];
      if (!plaintextChannels.includes(ctx.channel)) {
        return { passed: true, expected: 'n/a (non-plaintext channel)', actual: 'n/a', reason: `channel "${ctx.channel}" supports markdown` };
      }
      const check = containsMarkdownLeakage(text);
      if (check.matched) {
        return {
          passed: false,
          expected: 'no markdown in plaintext channel response',
          actual: 'markdown formatting detected',
          reason: `markdown formatting detected in response for plaintext channel "${ctx.channel}"`,
        };
      }
      return { passed: true, expected: 'no markdown', actual: 'no markdown', reason: 'no markdown in plaintext channel response' };
    },
  },

  {
    id: 'response_language_matches_user_language',
    description: 'Response datetime tokens must match the user\'s configured language',
    evaluate({ text, ctx }) {
      const check = detectLanguageMismatchTokens(text, ctx.userLang);
      if (check.matched) {
        const swapList = (check.swaps || []).map(s => `"${s.found}" → "${s.suggest || '?'}"`).join(', ');
        return {
          passed: false,
          expected: `datetime tokens in "${ctx.userLang}" language`,
          actual: `mismatched datetime tokens detected: ${swapList}`,
          reason: `response contains datetime tokens in the wrong language for userLang="${ctx.userLang}": ${swapList}`,
        };
      }
      return {
        passed: true,
        expected: 'datetime tokens match user language',
        actual: 'no mismatch detected',
        reason: 'no language mismatch detected in datetime tokens',
      };
    },
  },

  // ── Slice 5 new cases ────────────────────────────────────────────────────────

  {
    id: 'no_phantom_crystal_creation_claim',
    description: 'Response must not claim a Crystal/skill was saved without a matching skill_manage/skill_patch execution with a successful result',
    evaluate({ text, ctx }) {
      const claim = matchesPhantomCrystalCreationClaim(text);
      if (!claim.matched) {
        return { passed: true, expected: 'no crystal creation claim', actual: 'no crystal creation claim', reason: 'no crystal/skill save claim detected' };
      }
      const skills = ctx.skillResults || [];
      const crystalSkill = skills.find(s => CRYSTAL_SKILL_PATTERN.test(s.name || ''));
      if (!crystalSkill) {
        return {
          passed: false,
          expected: 'skill_manage/skill_patch skill ran successfully',
          actual: 'no crystal skill in skillResults',
          reason: 'crystal/skill save claimed but no skill_manage/skill_patch/qskl_write skill ran',
        };
      }
      if (isUnverifiableMcp(crystalSkill)) {
        return { passed: true, expected: 'crystal skill ran', actual: 'crystal skill ran', reason: 'crystal skill present but result is unverifiable (MCP path)' };
      }
      if (crystalSkill.success === false) {
        return {
          passed: false,
          expected: 'crystal skill ran successfully',
          actual: 'crystal skill ran but failed',
          reason: 'crystal/skill save claimed but skill_manage/skill_patch skill returned failure',
        };
      }
      // Check for persistence evidence: result.id (skill_manage returns {id, name, ...}),
      // or result.persisted===true, or result.success===true
      const r = crystalSkill.result || {};
      const persisted = r.persisted === true || r.success === true || (typeof r.id === 'string' && r.id.length > 0);
      if (!persisted) {
        return {
          passed: false,
          expected: 'crystal skill result indicates persistence (id/persisted/success)',
          actual: `crystal skill result lacks persistence evidence: ${JSON.stringify(r).slice(0, 80)}`,
          reason: 'crystal/skill save claimed but skill result does not indicate successful persistence',
        };
      }
      return { passed: true, expected: 'crystal skill ran and persisted', actual: 'crystal skill ran and persisted', reason: 'crystal/skill skill ran and result indicates persistence' };
    },
  },

  {
    id: 'no_phantom_org_scoping_claim',
    description: 'Response must not claim actions are org-scoped when ctx.orgId is absent or is a fallback placeholder',
    evaluate({ text, ctx }) {
      const claim = matchesPhantomOrgScopingClaim(text);
      if (!claim.matched) {
        return { passed: true, expected: 'no org-scoping claim', actual: 'no org-scoping claim', reason: 'no org-scoping claim detected' };
      }
      const orgId = ctx.orgId || ctx.org_id || '';
      const FALLBACK_ORG = /^(default|public|unknown|none|)$/i;
      if (FALLBACK_ORG.test(orgId.trim())) {
        return {
          passed: false,
          expected: 'ctx.orgId set to a real org identifier',
          actual: `ctx.orgId="${orgId}" (fallback/unset)`,
          reason: `org-scoping claim detected ("${claim.phrase}") but ctx.orgId is unset or a placeholder — the action is not truly org-scoped`,
          org_claim_phrase: claim.phrase,
        };
      }
      return {
        passed: true,
        expected: 'ctx.orgId set',
        actual: `ctx.orgId="${orgId}"`,
        reason: `org-scoping claim backed by real orgId "${orgId}"`,
      };
    },
  },
];

module.exports = { cases, hasSkillEvidence };
