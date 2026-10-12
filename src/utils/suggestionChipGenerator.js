/**
 * Suggestion Chip Generator
 *
 * Pure function that generates follow-up suggestion chips from AI response text.
 * Client-side pattern matching — zero latency, no LLM call.
 * Used by TerminalChat to render clickable follow-up chips below assistant messages.
 *
 * @module suggestionChipGenerator
 */

const MAX_CHIPS = 4;

/**
 * Pattern table: regex → chip generator.
 * Each entry: { pattern, label, query, icon?, runnable? }
 * runnable chips are filtered out in audit mode.
 */
const CHIP_PATTERNS = [
  {
    pattern: /npm install\s+\S+|yarn add\s+\S+/i,
    label: 'Install dependencies',
    query: (match) => `Run the install command: ${match[0].trim().substring(0, 60)}`,
    icon: 'package',
    runnable: true
  },
  {
    pattern: /run\s+(?:the\s+)?tests?|test suite|npm\s+test|npx\s+vitest|pytest/i,
    label: 'Run tests',
    query: () => 'Run the tests and show me the results',
    icon: 'play',
    runnable: true
  },
  {
    pattern: /restart\s+(?:the\s+)?(?:service|daemon|container)|systemctl\s+restart|docker\s+restart/i,
    label: 'Restart service',
    query: (match) => `Restart the service: ${match[0].trim().substring(0, 60)}`,
    icon: 'refresh',
    runnable: true
  },
  {
    pattern: /(?:check|view|show|tail)\s+(?:the\s+)?logs?|journalctl|docker\s+logs/i,
    label: 'Show logs',
    query: () => 'Show me the relevant logs',
    icon: 'file-text',
    runnable: true
  },
  {
    pattern: /git\s+(status|diff|log|stash|branch)/i,
    label: (match) => `git ${match[1]}`,
    query: (match) => `Run git ${match[1]} and show me the output`,
    icon: 'git',
    runnable: true
  },
  {
    pattern: /```(?:bash|sh|shell|zsh)?\n(.+?)```/s,
    label: (match) => {
      const cmd = match[1].trim().split('\n')[0].substring(0, 40);
      return `Run: ${cmd}`;
    },
    query: (match) => {
      const cmd = match[1].trim().split('\n')[0];
      return `Run this command: ${cmd}`;
    },
    icon: 'terminal',
    runnable: true
  },
  {
    pattern: /(?:should|could|might)\s+(?:fix|resolve|solve)\s+(?:the|this|your)/i,
    label: 'Check if fixed',
    query: () => 'Did that fix the issue? Check the current state.',
    icon: 'check-circle',
    runnable: false
  },
  {
    pattern: /(?:let me know|feel free to ask|if you (?:need|want)|happy to)\s/i,
    label: 'Explain more',
    query: () => 'Can you explain that in more detail?',
    icon: 'help-circle',
    runnable: false
  }
];

/**
 * Check if the response is primarily a clarifying question.
 * Only suppress chips when the response is short and mostly questions —
 * not when a long helpful response has a courtesy question at the end
 * like "Would you like me to run this for you?"
 */
function responseIsPrimarilyQuestion(text) {
  const nonCodeText = text.replace(/```[\s\S]*?```/g, '');
  const lines = nonCodeText.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return false;
  const questionLines = lines.filter(
    line => line.trim().endsWith('?') && line.trim().length > 10
  );
  // Only suppress if short response (< 4 content lines) and majority are questions
  return lines.length <= 3 && questionLines.length >= Math.ceil(lines.length / 2);
}

/**
 * Generate suggestion chips from AI response text.
 *
 * @param {string} responseText - The AI assistant's response
 * @param {{ mode?: string }} options - Current terminal mode
 * @returns {Array<{ label: string, query: string, icon: string }>}
 */
export function generateSuggestionChips(responseText, { mode } = {}) {
  if (!responseText || typeof responseText !== 'string') return [];

  // Skip if AI response is primarily a clarifying question
  if (responseIsPrimarilyQuestion(responseText)) return [];

  const chips = [];
  const seenLabels = new Set();
  const isAudit = mode === 'audit';

  for (const entry of CHIP_PATTERNS) {
    if (chips.length >= MAX_CHIPS) break;

    const match = responseText.match(entry.pattern);
    if (!match) continue;

    // Skip runnable chips in audit mode
    if (isAudit && entry.runnable) continue;

    const label = typeof entry.label === 'function' ? entry.label(match) : entry.label;

    // Deduplicate by label
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);

    const query = typeof entry.query === 'function' ? entry.query(match) : entry.query;

    chips.push({
      label,
      query,
      icon: entry.icon || 'message-circle'
    });
  }

  return chips;
}
