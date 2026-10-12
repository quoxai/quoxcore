'use strict';

// ─── EN patterns (skill-attached, future-tense only) ──────────────────────────

const EN_PATTERNS = [
  { regex: /\bI(['']ll| will)\s+(send|email|forward|deliver)\b/i, skill: 'email' },
  { regex: /\bI(['']ll| will)\s+(create|make|add)\s+(a\s+)?(task|todo|item)\b/i, skill: 'task' },
  { regex: /\bI(['']ll| will)\s+(schedule|set up|book)\s+(a\s+)?(meeting|call|appointment)\b/i, skill: 'calendar' },
  { regex: /\bI(['']ll| will)\s+(start|launch|kick off|trigger|run)\s+(the\s+)?(workflow|flow|pipeline)\b/i, skill: 'workflow' },
  { regex: /\bI(['']ll| will)\s+(route|send|forward|file|post)\s+(it|this)\s+(to|into)\s+(your\s+)?(hitl|inbox|approval)\b/i, skill: 'hitl' },
  { regex: /\bI(['']ll| will)\s+(save|crystallize|store|persist)\s+(this|it)\s+as\s+(a\s+)?(skill|crystal)\b/i, skill: 'crystal' },
];

// ─── ES patterns (skill-attached, future-tense only) ──────────────────────────

const ES_PATTERNS = [
  { regex: /\bvoy a\s+(enviar|mandar|reenviar|enviarte)\b/i, skill: 'email' },
  { regex: /\b(te\s+lo\s+)?(mando|envío)\s+(luego|después|en\s+un\s+rato)\b/i, skill: 'email' },
  { regex: /\bvoy a\s+(crear|añadir|agregar)\s+(una\s+)?(tarea|todo)\b/i, skill: 'task' },
  { regex: /\bvoy a\s+(iniciar|lanzar|ejecutar)\s+(el\s+)?(flujo|workflow)\b/i, skill: 'workflow' },
  { regex: /\bvoy a\s+(guardar|cristalizar|almacenar)\s+(esto|esta)\s+como\s+(skill|crystal)\b/i, skill: 'crystal' },
];

/**
 * detectPromise(text, ctx)
 *
 * Returns:
 *   { detected: true, inferred_action: { skill, target: null, when: null }, promise_text, language }
 * or
 *   { detected: false }
 */
function detectPromise(text) {
  if (typeof text !== 'string' || !text) {
    return { detected: false };
  }

  for (const { regex, skill } of EN_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      return {
        detected: true,
        inferred_action: { skill, target: null, when: null },
        promise_text: match[0],
        language: 'en',
      };
    }
  }

  for (const { regex, skill } of ES_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      return {
        detected: true,
        inferred_action: { skill, target: null, when: null },
        promise_text: match[0],
        language: 'es',
      };
    }
  }

  return { detected: false };
}

module.exports = { detectPromise };
