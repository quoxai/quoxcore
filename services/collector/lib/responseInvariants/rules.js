const PHANTOM_EMAIL_EN = /\bI('ll| will|'ve| have|'m going to| am going to|'m about to| am about to| just| was about to)?\s+(send|sent|sending|email|emailed|emailing|forward|forwarded|forwarding|deliver|delivered|delivering|mail|mailed|mailing)\b[\s\w'\-.]{1,30}?\b(team|email|summary|message|note|update|report|details|copy|invoice|receipt|reminder|notification)\b/i;
const PHANTOM_EMAIL_ES = /(voy a |acabo de |estoy )?(enviar|envío|envié|enviando|reenviar|reenvié|mandar|mandé|mandando) (el |un |la |una |tu |su )?(correo|email|mensaje|nota|resumen|reporte|informe)/i;

function matchesPhantomEmailClaim(text) {
  const matched = PHANTOM_EMAIL_EN.test(text) || PHANTOM_EMAIL_ES.test(text);
  return { matched, claim: matched ? 'email' : undefined };
}

const PHANTOM_TASK_EN = /\bI('ll| will|'ve| have|'m going to| am going to| just|'m)?\s+(create|created|creating|make|made|making|add|added|adding|file|filed|filing|log|logged|logging)\b[\s\w'\-.]{1,30}?\b(task|todo|item|ticket|issue|action)\b/i;
const PHANTOM_TASK_ES = /(voy a |acabo de |estoy )?(crear|creé|creando|añadir|añadí|añadiendo|agregar|agregué|agregando|hacer|hice|haciendo|registrar|registré)\s+(la |una |un |el |tu )?(tarea|pendiente|ticket|asunto|acción)/i;

function matchesPhantomTaskCreationClaim(text) {
  const matched = PHANTOM_TASK_EN.test(text) || PHANTOM_TASK_ES.test(text);
  return { matched };
}

const PHANTOM_WORKFLOW_EN = /\bI('ll| will|'ve| have|'m going to| am going to| just)?\s+(start|started|starting|launch|launched|launching|run|ran|running|kick off|kicked off|kicking off|trigger|triggered|triggering|execute|executed|executing)\b[\s\w'\-.]{1,30}?\b(workflow|flow|pipeline|automation)\b/i;
const PHANTOM_WORKFLOW_ES = /(voy a |acabo de |estoy )?(lanzar|lancé|lanzando|iniciar|inicié|iniciando|ejecutar|ejecuté|ejecutando|disparar|disparé|disparando)\s+(el |un |la |tu |este )?(flujo|workflow|pipeline|automatización)/i;

function matchesPhantomWorkflowStartClaim(text) {
  const matched = PHANTOM_WORKFLOW_EN.test(text) || PHANTOM_WORKFLOW_ES.test(text);
  return { matched };
}

// Extract the named workflow from a claim (best-effort; returns undefined if vague)
// Matches: "I started the order-processing workflow" → "order-processing"
// Matches: "I started the billing-export workflow" → "billing-export"
// Does NOT match vague: "I started the workflow for this task" → undefined
const ARTICLE = /^(?:the|a|an|el|un|la|este|ese)\s+/i;
const SKIP_WORDS = new Set(['the', 'a', 'an', 'el', 'un', 'la', 'este', 'ese', 'for', 'this', 'task', 'that', 'it', 'workflow', 'flow', 'pipeline', 'automation', 'flujo', 'automatización']);

// Pattern 1: "started the <name> workflow" — name comes BEFORE the keyword
const WORKFLOW_NAME_BEFORE = /\b(?:start(?:ed)?|launch(?:ed)?|ran?|run(?:ning)?|kick(?:ed)?\s+off|trigger(?:ed)?|execut(?:ed)?|executing)\s+([\w][\w\s/-]{1,50}?)\s+(?:workflow|flow|pipeline|automation)\b/i;

// Pattern 2 (ES): "lancé el flujo de procesamiento" — name comes AFTER the keyword
const WORKFLOW_NAME_ES = /\b(?:lanzar|lancé|lanzando|iniciar|inicié|iniciando|ejecutar|ejecuté|ejecutando|disparar|disparé|disparando)\s+(?:el |un |la |este |ese )?(?:flujo|workflow|pipeline|automatización)\s+(?:de\s+)?([\w][\w\s/-]{1,40}?)(?:\s+flujo|\s+workflow|\s+pipeline)?(?:\s|$|[.,!?])/i;

function extractWorkflowName(text) {
  let m = WORKFLOW_NAME_BEFORE.exec(text);
  if (m) {
    let name = m[1].trim().toLowerCase().replace(ARTICLE, '').trim();
    // Skip if the extracted part is just a vague filler word (e.g. "the" alone, "for this")
    if (!name || SKIP_WORDS.has(name) || name.split(/\s+/).every(w => SKIP_WORDS.has(w))) {
      return undefined;
    }
    return name;
  }
  m = WORKFLOW_NAME_ES.exec(text);
  if (m && m[1]) {
    const name = m[1].trim().toLowerCase();
    if (!name || SKIP_WORDS.has(name)) return undefined;
    return name;
  }
  return undefined;
}

const PHANTOM_SUBAGENT_EN = /\bI('ll| will|'ve| have|'m going to| am going to| just)?\s+(create|created|creating|make|made|making|spin up|spun up|spinning up|set up|setting up|spawn|spawned|spawning|deploy|deployed|deploying)\b[\s\w'\-.]{1,30}?\b(sub-?agent|agent|worker)\b/i;
const PHANTOM_SUBAGENT_ES = /(voy a |acabo de |estoy )?(crear|creé|creando|configurar|configuré|configurando|montar|monté|montando|desplegar|desplegué|desplegando)\s+(el |un |la |una |tu )?(sub-?agente|agente|trabajador)/i;

function matchesPhantomSubagentCreationClaim(text) {
  const matched = PHANTOM_SUBAGENT_EN.test(text) || PHANTOM_SUBAGENT_ES.test(text);
  return { matched };
}

const PHANTOM_HITL_EN = /\bI('ll| will|'ve| have|'m going to| am going to| just)?\s+(send|sent|sending|route|routed|routing|file|filed|filing|post|posted|posting|forward|forwarded|forwarding)\b[\s\w'/\-.]{1,30}?\b(HITL|hitl|inbox|approval queue)\b/i;
const PHANTOM_HITL_ES = /(voy a |acabo de |estoy )?(enviar|envié|enviando|enrutar|enruté|enrutando|archivar|archivé|archivando|reenviar|reenvié)\s+(esto |eso |lo |el ítem |la solicitud )?(a |en )?(tu |la |su )?(bandeja|HITL|inbox|cola de aprobación)/i;

function matchesPhantomHitlRoutingClaim(text) {
  const matched = PHANTOM_HITL_EN.test(text) || PHANTOM_HITL_ES.test(text);
  return { matched };
}

// ── Crystal-creation invariant (5.3) ─────────────────────────────────────────
const PHANTOM_CRYSTAL_EN = /\bI('ll| will|'ve| have|'m going to| am going to| just|'m)?\s+(save|saved|saving|crystallize|crystallized|crystallizing|store|stored|storing|persist|persisted|persisting)\b[\s\w'-]{1,30}?\b(as|in)\s+(a |the |your )?(skill|crystal|skl)\b/i;
const PHANTOM_CRYSTAL_ES = /(voy a |acabo de |estoy )?(guardar|guardé|guardando|cristalizar|cristalicé|almacenar|almacené|persistir|persistí)\s+(esto |eso |lo )?(como )?(una |un |la |el )?(skill|crystal|conocimiento|cristal)\b/i;

function matchesPhantomCrystalCreationClaim(text) {
  const matched = PHANTOM_CRYSTAL_EN.test(text) || PHANTOM_CRYSTAL_ES.test(text);
  return { matched };
}

// ── Org-scoping invariant (5.5) ───────────────────────────────────────────────
const PHANTOM_ORG_SCOPING_EN = /\b(for|to|in|across)\s+(your|the)\s+(org(?:aniz(?:ation|ation))?|organisation|company|workspace|tenant)\b/i;
const PHANTOM_ORG_SCOPING_ES = /(para|a|en|de)\s+(tu|su|la)\s+(organización|empresa|compañía|workspace|tenant|inquilino)\b/i;

function matchesPhantomOrgScopingClaim(text) {
  const enMatch = PHANTOM_ORG_SCOPING_EN.exec(text);
  const esMatch = PHANTOM_ORG_SCOPING_ES.exec(text);
  if (enMatch) return { matched: true, phrase: enMatch[0], lang: 'en' };
  if (esMatch) return { matched: true, phrase: esMatch[0], lang: 'es' };
  return { matched: false };
}

const CLOCK_TIME_SCHEDULE = /(at|by|every|each) \d{1,2}(:\d{2})?\s?(am|pm|AM|PM|UTC|GMT)?\b.*\b(schedule|run|fire|trigger)/i;
const INTERVAL_ONLY = /interval[- ]?only|cada \d+ (minuto|hora)/i;

function matchesClockTimeSchedulingClaim(text) {
  const matched = CLOCK_TIME_SCHEDULE.test(text) && !INTERVAL_ONLY.test(text);
  return { matched };
}

const INTERNAL_PATH = /(\/data\/|\/var\/lib\/|\/home\/[^/\s]+\/|\/tmp\/quox|\/opt\/quox)/;

function containsInternalPathLeak(text) {
  const matched = INTERNAL_PATH.test(text);
  return { matched };
}

const PLACEHOLDER_TOKEN = /\b(TODO|TBD|XXX|YOUR_[A-Z_]+|TRACKINGCODE|<INSERT[^>]*>|\[INSERT[^\]]*\])\b/;

function containsPlaceholderToken(text) {
  const matched = PLACEHOLDER_TOKEN.test(text);
  return { matched };
}

function isOneOrTwoSentences(text) {
  if (!text || !text.trim()) return { matched: true, count: 0 };
  const parts = text.trim().split(/[.!?]\s+/);
  const count = parts.filter(p => p.trim().length > 0).length;
  return { matched: count <= 2, count };
}

const MARKDOWN_PATTERN = /(```[\s\S]*?```|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|^#{1,6}\s)/m;

function containsMarkdownLeakage(text) {
  const matched = MARKDOWN_PATTERN.test(text);
  return { matched };
}

const FACTUAL_VERDICT =
  /\b(is|was|are|were) (at |currently |now )?(\$?[\d,]+(\.\d+)?|delivered|in transit|out for delivery|complete[d]?|pending|approved|denied)\b/i;

function containsFactualVerdict(text) {
  const matched = FACTUAL_VERDICT.test(text);
  return { matched };
}

const EN_DATETIME_TOKENS =
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)\b/;

const ES_DATETIME_TOKENS =
  /\b(lunes|martes|miércoles|jueves|viernes|sábado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i;

const EN_TO_ES_MAP = {
  Monday: 'lunes', Tuesday: 'martes', Wednesday: 'miércoles', Thursday: 'jueves',
  Friday: 'viernes', Saturday: 'sábado', Sunday: 'domingo',
  January: 'enero', February: 'febrero', March: 'marzo', April: 'abril',
  May: 'mayo', June: 'junio', July: 'julio', August: 'agosto',
  September: 'septiembre', October: 'octubre', November: 'noviembre', December: 'diciembre',
};

const ES_TO_EN_MAP = Object.fromEntries(
  Object.entries(EN_TO_ES_MAP).map(([en, es]) => [es, en]),
);

function detectLanguageMismatchTokens(text, userLang) {
  if (userLang === 'es') {
    const matches = text.match(new RegExp(EN_DATETIME_TOKENS.source, 'gi')) || [];
    if (matches.length === 0) return { matched: false };
    const swaps = matches.map(m => {
      const key = Object.keys(EN_TO_ES_MAP).find(k => k.toLowerCase() === m.toLowerCase());
      return { found: m, suggest: key ? EN_TO_ES_MAP[key] : undefined };
    });
    return { matched: true, swaps };
  }

  if (userLang === 'en') {
    const matches = text.match(new RegExp(ES_DATETIME_TOKENS.source, 'gi')) || [];
    if (matches.length === 0) return { matched: false };
    const swaps = matches.map(m => {
      const key = Object.keys(ES_TO_EN_MAP).find(k => k.toLowerCase() === m.toLowerCase());
      return { found: m, suggest: key ? ES_TO_EN_MAP[key] : undefined };
    });
    return { matched: true, swaps };
  }

  return { matched: false };
}

module.exports = {
  matchesPhantomEmailClaim,
  matchesPhantomTaskCreationClaim,
  matchesPhantomWorkflowStartClaim,
  extractWorkflowName,
  matchesPhantomSubagentCreationClaim,
  matchesPhantomHitlRoutingClaim,
  matchesPhantomCrystalCreationClaim,
  matchesPhantomOrgScopingClaim,
  matchesClockTimeSchedulingClaim,
  containsInternalPathLeak,
  containsPlaceholderToken,
  isOneOrTwoSentences,
  containsMarkdownLeakage,
  containsFactualVerdict,
  detectLanguageMismatchTokens,
  EN_TO_ES_MAP,
  ES_TO_EN_MAP,
};
