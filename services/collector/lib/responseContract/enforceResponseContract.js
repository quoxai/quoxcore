const { runAll, cases } = require('../responseInvariants');
const { EN_TO_ES_MAP, ES_TO_EN_MAP, containsMarkdownLeakage, containsFactualVerdict, matchesPhantomOrgScopingClaim } = require('../responseInvariants/rules.js');

const ES_FACTUAL_VERDICT = /\b(fue|es|está|están|fueron|era|eran) (entregad[ao]|en tránsito|complet[ao]|pendiente|aprobad[ao]|negad[ao]|en camino)\b/i;

const PHANTOM_CLAIM_CASE_IDS = [
  'no_phantom_email_claim',
  'no_phantom_task_creation_claim',
  'no_phantom_workflow_start_claim',
  'no_phantom_subagent_creation_claim',
  'no_phantom_hitl_routing_claim',
  'no_phantom_crystal_creation_claim',
];

const CLAIM_LABEL_MAP = {
  no_phantom_email_claim: 'email',
  no_phantom_task_creation_claim: 'task',
  no_phantom_workflow_start_claim: 'workflow',
  no_phantom_subagent_creation_claim: 'subagent',
  no_phantom_hitl_routing_claim: 'hitl',
  no_phantom_crystal_creation_claim: 'crystal',
};

function stripSentencesContaining(text, phrase) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter(s => !s.toLowerCase().includes(phrase.toLowerCase()));
  return filtered.join(' ').trim();
}

function verifyClaimedActions(text, ctx) {
  const allResults = runAll({ text, ctx });
  const claimsStripped = [];
  const unverifiableClaims = [];
  let currentText = text;
  let anyStripped = false;
  const originalPreview = text.slice(0, 200);

  for (const caseId of PHANTOM_CLAIM_CASE_IDS) {
    const r = allResults.results.find(x => x.case_id === caseId);
    if (!r) continue;

    if (!r.passed) {
      const label = CLAIM_LABEL_MAP[caseId];
      // HITL sentinel-mismatch: use a specific label to surface the routing failure
      const claimLabel = (caseId === 'no_phantom_hitl_routing_claim' && r.sentinel_mismatch)
        ? 'hitl_routed_to_sentinel_instead'
        : label;
      claimsStripped.push(claimLabel);

      const phraseMap = {
        email: ["sent the email", "emailed", "forwarded", "delivered", "enviar el correo", "envié", "reenvié", "mandé", "enviar el email", "enviar el mensaje", "voy a enviar"],
        task: ["created a task", "made a task", "added a task", "created a todo", "added a todo", "creé la tarea", "añadí la tarea", "agregué la tarea"],
        workflow: ["started the workflow", "launched the workflow", "ran the workflow", "kicked off the workflow", "triggered the workflow", "started the order processing workflow", "started the billing export workflow", "started the reporting workflow", "lancé el flujo", "inicié el flujo", "ejecuté el flujo"],
        subagent: ["created a sub-agent", "created an agent", "made a sub-agent", "spun up a sub-agent", "set up a sub-agent", "creé el agente", "configuré el agente", "monté el agente"],
        hitl: ["sent it to your HITL", "routed it to your inbox", "filed it", "posted it to the inbox", "envié esto a", "enruté esto"],
        crystal: ["save this as a skill", "save this as a crystal", "saved it as a skill", "saved it as a crystal", "crystallize this", "crystallized this", "store this as a skill", "stored this as a skill", "persist this as a crystal", "guardé esto como skill", "guardé esto como crystal", "cristalicé esto", "almacené esto como skill"],
      };

      const phrases = phraseMap[label] || [];
      let stripped = false;
      for (const phrase of phrases) {
        if (currentText.toLowerCase().includes(phrase.toLowerCase())) {
          currentText = stripSentencesContaining(currentText, phrase);
          stripped = true;
          break;
        }
      }

      if (!stripped) {
        currentText = currentText.trim();
      }
      anyStripped = true;
    } else if (r.reason && r.reason.includes('unverifiable')) {
      const label = CLAIM_LABEL_MAP[caseId];
      unverifiableClaims.push(label);
    }
  }

  if (anyStripped) {
    return {
      text: currentText,
      trace: {
        applied: true,
        claims_stripped: claimsStripped,
        original_preview: originalPreview,
      },
    };
  }

  if (unverifiableClaims.length > 0) {
    return {
      text,
      trace: {
        applied: false,
        unverifiable_claims: unverifiableClaims,
      },
    };
  }

  return { text, trace: { applied: false } };
}

function sanitizeOrgScopingClaim(text, ctx) {
  const orgId = ctx.orgId || ctx.org_id || '';
  const FALLBACK_ORG = /^(default|public|unknown|none|)$/i;
  if (!FALLBACK_ORG.test(orgId.trim())) {
    return { text, trace: { applied: false } };
  }
  const claim = matchesPhantomOrgScopingClaim(text);
  if (!claim.matched) {
    return { text, trace: { applied: false } };
  }
  // Phrase-replace: substitute the org-scoping phrase with a less specific equivalent
  const replacements = { en: 'for your account', es: 'para tu cuenta' };
  const replacement = replacements[claim.lang] || 'for your account';
  const safePhrase = claim.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = text.replace(new RegExp(safePhrase, 'gi'), replacement);
  return {
    text: result,
    trace: {
      applied: true,
      claims_stripped: ['org_scoping'],
      original_phrase: claim.phrase,
      replacement,
    },
  };
}

function verifyExternalFactClaims(text, ctx) {
  const allResults = runAll({ text, ctx });
  const factR = allResults.results.find(r => r.case_id === 'no_factual_assertion_without_skill_evidence');
  const skills = ctx.skillResults || [];
  const esFactMatch = ES_FACTUAL_VERDICT.test(text) && skills.length === 0;
  if ((factR && !factR.passed) || esFactMatch) {
    const isEs = ctx.userLang === 'es';
    const replacement = isEs
      ? 'No tengo información actual para verificar eso. Confirma y actuaré con los datos verificados.'
      : "I don't have current information to verify that. Please confirm and I'll act on the verified data.";
    return { text: replacement, trace: { applied: true, reason: 'no_skill_evidence' } };
  }
  return { text, trace: { applied: false } };
}

const PLAINTEXT_CHANNELS = new Set(['telegram', 'sms', 'plaintext']);

function sanitizeMarkdown(text, ctx) {
  const channel = ctx.channel || 'dashboard';
  if (!PLAINTEXT_CHANNELS.has(channel)) {
    return { text, trace: { applied: false } };
  }

  if (!containsMarkdownLeakage(text)) {
    return { text, trace: { applied: false } };
  }

  const strippedKinds = [];
  let result = text;

  if (/```[\s\S]*?```/.test(result)) {
    result = result.replace(/```[\s\S]*?```/g, '');
    strippedKinds.push('code_block');
  }

  if (/`[^`]+`/.test(result)) {
    result = result.replace(/`([^`]+)`/g, '$1');
    strippedKinds.push('inline_code');
  }

  if (/\*\*[^*]+\*\*/.test(result)) {
    result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
    strippedKinds.push('bold');
  }

  if (/\*[^*]+\*/.test(result)) {
    result = result.replace(/\*([^*]+)\*/g, '$1');
    strippedKinds.push('italic_star');
  }

  if (/_[^_]+_/.test(result)) {
    result = result.replace(/_([^_]+)_/g, '$1');
    strippedKinds.push('italic_underscore');
  }

  if (/\[[^\]]+\]\([^)]+\)/.test(result)) {
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
    strippedKinds.push('link');
  }

  if (/^#{1,6}\s/m.test(result)) {
    result = result.replace(/^#{1,6}\s/gm, '');
    strippedKinds.push('heading');
  }

  result = result.replace(/\n{2,}/g, '\n').trim();

  return { text: result, trace: { applied: true, stripped_kinds: strippedKinds } };
}

function enforceLanguageConsistency(text, ctx) {
  const userLang = ctx.userLang;

  if (userLang === 'es') {
    let swaps = 0;
    let result = text;
    for (const [en, es] of Object.entries(EN_TO_ES_MAP)) {
      const re = new RegExp(`\\b${en}\\b`, 'gi');
      result = result.replace(re, (match) => {
        swaps++;
        const isUpper = match[0] === match[0].toUpperCase();
        return isUpper ? es.charAt(0).toUpperCase() + es.slice(1) : es;
      });
    }
    if (swaps === 0) return { text, trace: { applied: false } };
    return { text: result, trace: { applied: true, swaps } };
  }

  if (userLang === 'en') {
    let swaps = 0;
    let result = text;
    for (const [es, en] of Object.entries(ES_TO_EN_MAP)) {
      const re = new RegExp(`\\b${es}\\b`, 'gi');
      result = result.replace(re, (match) => {
        swaps++;
        const isUpper = match[0] === match[0].toUpperCase();
        return isUpper ? en.charAt(0).toUpperCase() + en.slice(1) : en;
      });
    }
    if (swaps === 0) return { text, trace: { applied: false } };
    return { text: result, trace: { applied: true, swaps } };
  }

  return { text, trace: { applied: false } };
}

function enforceResponseContract(text, ctx) {
  const trace1 = verifyClaimedActions(text, ctx);
  text = trace1.text;
  const trace2 = verifyExternalFactClaims(text, ctx);
  text = trace2.text;
  const trace3 = sanitizeMarkdown(text, ctx);
  text = trace3.text;
  const trace4 = enforceLanguageConsistency(text, ctx);
  text = trace4.text;
  const trace5 = sanitizeOrgScopingClaim(text, ctx);
  text = trace5.text;
  return {
    text,
    traceMap: {
      verify_claimed_actions: trace1.trace,
      verify_external_fact_claims: trace2.trace,
      sanitize_markdown: trace3.trace,
      enforce_language_consistency: trace4.trace,
      sanitize_org_scoping: trace5.trace,
    },
  };
}

module.exports = { enforceResponseContract, verifyClaimedActions, verifyExternalFactClaims, sanitizeMarkdown, enforceLanguageConsistency, sanitizeOrgScopingClaim };
