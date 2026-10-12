/**
 * ET-3 Phase C1+C2 — SCIM filter parser.
 *
 * Supports the subset real IdPs send:
 *   - eq, co, sw on string attrs
 *   - eq on boolean attrs
 *   - pr (present)
 *   - two-clause "and" OR two-clause "or" (no mixing — precedence
 *     is not supported in MVP, callers using more complex
 *     filters get a clear 400)
 *
 * Attribute whitelist is passed per-call so Users and Groups can
 * accept different sets. The parser never returns attrs outside
 * the whitelist.
 */

const DEFAULT_ALLOWED = ['userName', 'externalId', 'active'];
const STRING_OPS      = new Set(['eq', 'co', 'sw']);

function splitOnce(expr, token) {
    // Find the FIRST occurrence of ` <token> ` (lowercased) that is
    // outside a quoted string. MVP parser, not a full tokenizer.
    const lower = expr.toLowerCase();
    const needle = ` ${token} `;
    let inQuote = false;
    for (let i = 0; i < expr.length - needle.length; i++) {
        const ch = expr[i];
        if (ch === '"') inQuote = !inQuote;
        if (!inQuote && lower.slice(i, i + needle.length) === needle) {
            return [expr.slice(0, i), expr.slice(i + needle.length)];
        }
    }
    return null;
}

function parseClause(expr, allowedAttrs) {
    const trimmed = expr.trim();

    // Presence: "<attr> pr"
    const pr = trimmed.match(/^([a-zA-Z][a-zA-Z0-9]*)\s+(pr|PR|Pr)\s*$/);
    if (pr) {
        const attr = pr[1];
        if (!allowedAttrs.includes(attr)) {
            throw new Error(`unsupported attribute "${attr}" — expected one of ${allowedAttrs.join(', ')}`);
        }
        return { attr, op: 'pr', value: null };
    }

    // Binary: "<attr> <op> <value>"
    const bin = trimmed.match(/^([a-zA-Z][a-zA-Z0-9]*)\s+([a-zA-Z]+)\s+(?:"((?:[^"\\]|\\.)*)"|(true|false|TRUE|FALSE))\s*$/);
    if (!bin) {
        if (/\b(ew|gt|lt|ge|le|ne)\b/.test(trimmed)) {
            throw new Error('unsupported operator — only eq, co, sw, pr are supported in this MVP');
        }
        throw new Error('filter clause must be <attr> <op> "value" (quoted string) or <attr> pr');
    }
    const attr  = bin[1];
    const op    = bin[2].toLowerCase();
    const strV  = bin[3];
    const boolV = bin[4];

    if (!allowedAttrs.includes(attr)) {
        throw new Error(`unsupported attribute "${attr}" — expected one of ${allowedAttrs.join(', ')}`);
    }
    if (op === 'eq') {
        if (strV !== undefined) return { attr, op: 'eq', value: strV };
        if (boolV !== undefined) return { attr, op: 'eq', value: boolV.toLowerCase() === 'true' };
    }
    if (STRING_OPS.has(op)) {
        if (strV === undefined) {
            throw new Error(`operator "${op}" requires a quoted string value`);
        }
        return { attr, op, value: strV };
    }
    throw new Error(`unsupported operator "${op}" — only eq, co, sw, pr are supported in this MVP`);
}

export function parseScimFilter(input, { allowedAttrs = DEFAULT_ALLOWED } = {}) {
    if (input == null || input === '') return null;
    const expr = String(input).trim();
    if (!expr) return null;

    // Reject mixed and/or to avoid silent wrong answers on precedence.
    const lower = expr.toLowerCase();
    const hasAnd = /\band\b/.test(lower);
    const hasOr  = /\bor\b/.test(lower);
    if (hasAnd && hasOr) {
        throw new Error('mixing and/or in one filter is not supported — use separate requests');
    }

    // Compound?
    const joinToken = hasAnd ? 'and' : (hasOr ? 'or' : null);
    if (joinToken) {
        const parts = splitOnce(expr, joinToken);
        if (parts) {
            const left  = parseClause(parts[0], allowedAttrs);
            const right = parseClause(parts[1], allowedAttrs);
            return { op: joinToken, clauses: [left, right] };
        }
    }

    return parseClause(expr, allowedAttrs);
}
