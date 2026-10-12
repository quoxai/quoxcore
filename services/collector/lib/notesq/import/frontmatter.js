'use strict';

/**
 * Minimal YAML frontmatter reader for Obsidian/markdown import (the collector
 * has no YAML dependency). Understands what NotesQ properties can hold:
 * scalars (string, number, boolean) and lists of strings, written inline
 * (`[a, b]`) or as a `- item` block. Anything else (nested maps) is skipped
 * and reported in `warnings`, never silently dropped.
 */

const unquote = (s) => {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) return t.slice(1, -1);
  return t;
};

function scalar(raw) {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null') return undefined;
  if (/^["']/.test(t)) return unquote(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function parseFrontmatter(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { props: {}, body: src, warnings: [] };
  const lines = m[1].split(/\r?\n/);
  const props = {};
  const warnings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z0-9_][A-Za-z0-9_ .-]*):(?:\s+(.*))?$/.exec(line);
    if (!kv) continue; // continuation of something already skipped
    const key = kv[1].trim();
    const rest = (kv[2] || '').trim();
    if (rest === '') {
      // block list, or nested map (unsupported)
      const items = [];
      let nested = false;
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        const next = lines[++i];
        const li = /^\s*-\s+(.*)$/.exec(next);
        if (li) items.push(String(unquote(li[1])));
        else if (next.trim()) nested = true;
      }
      if (nested) warnings.push(`frontmatter key "${key}" skipped (nested structure not supported)`);
      else if (items.length) props[key] = items;
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      props[key] = rest.slice(1, -1).split(',').map((x) => unquote(x)).filter((x) => x !== '');
      continue;
    }
    if (rest.startsWith('{') || rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      warnings.push(`frontmatter key "${key}" skipped (structure not supported)`);
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) i++;
      continue;
    }
    const v = scalar(rest);
    if (v !== undefined) props[key] = v;
  }
  return { props, body: src.slice(m[0].length), warnings };
}

module.exports = { parseFrontmatter };
