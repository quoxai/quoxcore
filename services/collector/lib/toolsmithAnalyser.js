/**
 * TOOLSMITH Slice 3a — Static Analyser
 *
 * Scans a Python script.py for dangerous patterns (network, filesystem,
 * subprocess, secrets, blocked calls).
 *
 * Per feedback_regex_unit_tests_blind_to_false_positives.md:
 * - Every pattern has a positive case (must flag) AND a counter case (must NOT flag).
 * - Pre-pass strips Python comments and string literals before scanning,
 *   preventing false positives from commented-out or string-embedded patterns.
 *
 * Public API:
 *   stripCommentsAndStrings(source: string) → string
 *   analyse(scriptPy: string) → { flags: Flag[], suggestedPermissions: Permissions }
 *
 * Flag shape: { pattern: string, line: number, severity: string, suggestion: string }
 * Permissions shape: { network: boolean, filesystem: boolean, secrets: string[],
 *                      subprocess: boolean, approval_required: boolean }
 */

'use strict';

// ---------------------------------------------------------------------------
// Pre-pass: strip Python comments and string literals
// ---------------------------------------------------------------------------

/**
 * Strip Python comments (#...) and string literals ("...", '...', triple-quoted)
 * from a Python source string. Returns a version safe for pattern-scanning.
 *
 * Strategy:
 *   1. Remove triple-double-quoted strings (first, greediest)
 *   2. Remove triple-single-quoted strings
 *   3. Remove inline single-line strings ("..." and '...')
 *   4. Remove # comments to end of line
 *
 * This is deliberately a fast regex pre-pass, not a full Python tokenizer.
 * It handles the most common false-positive sources without needing a grammar.
 * Known gap: strings with backslash-escaped quotes may not be stripped perfectly —
 * acceptable for MVP static analysis (false negatives beat false positives).
 *
 * @param {string} source  Raw Python source
 * @returns {string}       Stripped source
 */
function stripCommentsAndStrings(source) {
  let s = source;

  // 1. Triple double-quoted strings (multi-line)
  s = s.replace(/"""[\s\S]*?"""/g, '""');

  // 2. Triple single-quoted strings (multi-line)
  s = s.replace(/'''[\s\S]*?'''/g, "''");

  // 3. Double-quoted single-line strings (non-greedy, not crossing newlines)
  s = s.replace(/"[^"\n\\]*(?:\\.[^"\n\\]*)*"/g, '""');

  // 4. Single-quoted single-line strings (non-greedy, not crossing newlines)
  s = s.replace(/'[^'\n\\]*(?:\\.[^'\n\\]*)*'/g, "''");

  // 5. Inline # comments to end of line
  s = s.replace(/#[^\n]*/g, '');

  return s;
}

// ---------------------------------------------------------------------------
// Pattern catalog
// ---------------------------------------------------------------------------

/**
 * Each pattern entry:
 *   id        — unique dot-namespaced identifier
 *   regex     — RegExp to run against the stripped source (per-line for line# tracking)
 *   severity  — 'info' | 'warning' | 'error' | 'block'
 *   permission — which permission flag this sets ('network' | 'filesystem' | 'subprocess' | 'blocked')
 *   suggestion — human-readable remediation text
 *   secret    — whether this pattern extracts secret names (for secrets[] array)
 */
const PATTERNS = [
  // ── Network ──────────────────────────────────────────────────────────────
  {
    id: 'network.requests',
    // Matches "import requests" or "from requests import ..." as a statement
    // (not "requests_lib" or "urllib_requests")
    regex: /(?:^|\s)import\s+requests(?:\s|$|,)|\bfrom\s+requests\b/,
    severity: 'warning',
    permission: 'network',
    suggestion: 'Set permissions.network = true in tool.json to enable outbound HTTP via the egress proxy.',
  },
  {
    id: 'network.urllib',
    regex: /(?:^|\s)import\s+urllib(?:\s|$|,)|\bfrom\s+urllib\b/,
    severity: 'warning',
    permission: 'network',
    suggestion: 'Set permissions.network = true in tool.json to enable outbound HTTP via the egress proxy.',
  },
  {
    id: 'network.socket',
    // Must be "import socket" (the module), not "my_socket_var"
    regex: /(?:^|\s)import\s+socket(?:\s|$|,)|\bfrom\s+socket\b/,
    severity: 'warning',
    permission: 'network',
    suggestion: 'Set permissions.network = true in tool.json to enable socket access via the egress proxy.',
  },
  {
    id: 'network.httpx',
    regex: /(?:^|\s)import\s+httpx(?:\s|$|,)|\bfrom\s+httpx\b/,
    severity: 'warning',
    permission: 'network',
    suggestion: 'Set permissions.network = true in tool.json to enable outbound HTTP via the egress proxy.',
  },
  {
    id: 'network.aiohttp',
    regex: /(?:^|\s)import\s+aiohttp(?:\s|$|,)|\bfrom\s+aiohttp\b/,
    severity: 'warning',
    permission: 'network',
    suggestion: 'Set permissions.network = true in tool.json to enable outbound HTTP via the egress proxy.',
  },
  {
    id: 'network.http_client',
    regex: /(?:^|\s)import\s+http\.client(?:\s|$|,)|\bfrom\s+http\.client\b/,
    severity: 'warning',
    permission: 'network',
    suggestion: 'Set permissions.network = true in tool.json to enable outbound HTTP via the egress proxy.',
  },

  // ── Filesystem ───────────────────────────────────────────────────────────
  {
    id: 'filesystem.open_write',
    // Matches open(..., 'w') or open(..., 'a') or open(..., 'wb') etc.
    // Does NOT match open('file') — read-only default
    regex: /\bopen\s*\([^)]*,\s*['"](?:w|a|wb|ab|w\+|a\+|r\+|x|xb)['"]/,
    severity: 'warning',
    permission: 'filesystem',
    suggestion: 'Set permissions.filesystem = true in tool.json. The sandbox provides a /workspace volume (100MB, deleted on exit).',
  },
  {
    id: 'filesystem.os_write',
    regex: /\bos\.write\s*\(/,
    severity: 'warning',
    permission: 'filesystem',
    suggestion: 'Set permissions.filesystem = true in tool.json.',
  },
  {
    id: 'filesystem.shutil',
    regex: /\bshutil\.(copy|move|rmtree|copytree)\s*\(/,
    severity: 'warning',
    permission: 'filesystem',
    suggestion: 'Set permissions.filesystem = true in tool.json.',
  },
  {
    id: 'filesystem.path_write',
    regex: /\.write_(?:text|bytes)\s*\(/,
    severity: 'warning',
    permission: 'filesystem',
    suggestion: 'Set permissions.filesystem = true in tool.json.',
  },

  // ── Subprocess (requires approval) ───────────────────────────────────────
  {
    id: 'subprocess.os_system',
    regex: /\bos\.system\s*\(/,
    severity: 'error',
    permission: 'subprocess',
    suggestion: 'os.system is a high-risk call. Set permissions.subprocess = true and permissions.approval_required = true. An admin HITL approval is required before install.',
  },
  {
    id: 'subprocess.subprocess',
    regex: /(?:^|\s)import\s+subprocess(?:\s|$|,)|\bfrom\s+subprocess\b|\bsubprocess\.(run|call|Popen|check_output|check_call)\s*\(/,
    severity: 'error',
    permission: 'subprocess',
    suggestion: 'subprocess requires admin approval. Set permissions.subprocess = true and permissions.approval_required = true.',
  },
  {
    id: 'subprocess.os_exec',
    regex: /\bos\.exec[vple]+\s*\(/,
    severity: 'error',
    permission: 'subprocess',
    suggestion: 'os.exec* requires admin approval. Set permissions.subprocess = true and permissions.approval_required = true.',
  },

  // ── Blocked patterns ─────────────────────────────────────────────────────
  {
    id: 'blocked.pickle_load',
    regex: /\bpickle\.load\s*\(/,
    severity: 'block',
    permission: 'blocked',
    suggestion: 'pickle.load from untrusted input is a code-execution vulnerability. Use JSON or msgpack instead.',
  },
  {
    id: 'blocked.marshal',
    regex: /\bmarshal\.loads\s*\(/,
    severity: 'block',
    permission: 'blocked',
    suggestion: 'marshal.loads is a code-execution vulnerability. Use JSON serialization instead.',
  },
  {
    id: 'blocked.eval',
    regex: /\beval\s*\(/,
    severity: 'block',
    permission: 'blocked',
    suggestion: 'eval() is prohibited. Use ast.literal_eval() for safe evaluation of literals.',
  },
  {
    id: 'blocked.exec',
    regex: /\bexec\s*\(/,
    severity: 'block',
    permission: 'blocked',
    suggestion: 'exec() is prohibited. Restructure to avoid dynamic code execution.',
  },
];

// Secret pattern — not in PATTERNS because it needs to extract the key name
// Matches: os.environ.get('KEY') or os.environ.get("KEY")
const SECRET_PATTERN = /\bos\.environ(?:\.get\s*\(\s*['"]([^'"]+)['"]|\s*\[\s*['"]([^'"]+)['"]\])/g;

// ---------------------------------------------------------------------------
// Analyser
// ---------------------------------------------------------------------------

/**
 * Strip only # comments from Python source, preserving string literals.
 * Used for patterns that need to inspect string argument content (e.g. open_write mode).
 *
 * @param {string} source
 * @returns {string}
 */
function stripCommentsOnly(source) {
  return source.replace(/#[^\n]*/g, '');
}

/**
 * Analyse a Python script.py for dangerous patterns.
 *
 * Uses two scanning passes:
 *   1. Full strip (comments + strings) — for import/call name detection (avoids false positives)
 *   2. Comment-only strip — for patterns that need to inspect string arguments (e.g. open write mode)
 *
 * @param {string} scriptPy  Raw Python source
 * @returns {{ flags: object[], suggestedPermissions: object }}
 */
function analyse(scriptPy) {
  if (typeof scriptPy !== 'string') {
    return { flags: [], suggestedPermissions: emptyPermissions() };
  }

  // Pass 1: strip comments AND string literals — for import / function name detection
  const stripped = stripCommentsAndStrings(scriptPy);
  const strippedLines = stripped.split('\n');

  // Pass 2: strip comments only — for patterns that need string argument values
  const commentStripped = stripCommentsOnly(scriptPy);
  const commentStrippedLines = commentStripped.split('\n');

  const flags = [];
  const permissions = emptyPermissions();

  // Run each pattern against the appropriate stripped source
  for (const pattern of PATTERNS) {
    // For open_write and similar argument-inspection patterns, use comment-stripped source
    // so that write mode strings ("w", "a", etc.) are preserved.
    // For all other patterns (import detection), use full-stripped source.
    const scanLines = pattern.id.startsWith('filesystem.') ? commentStrippedLines : strippedLines;

    // Scan line by line to capture line number
    for (let i = 0; i < scanLines.length; i++) {
      if (pattern.regex.test(scanLines[i])) {
        flags.push({
          pattern: pattern.id,
          line: i + 1, // 1-indexed
          severity: pattern.severity,
          suggestion: pattern.suggestion,
        });

        // Set the relevant permission
        if (pattern.permission === 'network') {
          permissions.network = true;
        } else if (pattern.permission === 'filesystem') {
          permissions.filesystem = true;
        } else if (pattern.permission === 'subprocess') {
          permissions.subprocess = true;
          permissions.approval_required = true;
        }
        // 'blocked' patterns don't set a permission toggle — they produce a block flag

        break; // one flag per pattern per file
      }
    }
  }

  // Secret extraction — scan comment-stripped source for os.environ.get calls
  // (need string values to extract key names; use comment-stripped not full-stripped)
  const secretMatches = commentStripped.matchAll(SECRET_PATTERN);
  for (const m of secretMatches) {
    const secretName = m[1] || m[2];
    if (secretName && !permissions.secrets.includes(secretName)) {
      permissions.secrets.push(secretName);
    }
  }

  return { flags, suggestedPermissions: permissions };
}

function emptyPermissions() {
  return {
    network: false,
    filesystem: false,
    secrets: [],
    subprocess: false,
    approval_required: false,
  };
}

module.exports = { analyse, stripCommentsAndStrings };
