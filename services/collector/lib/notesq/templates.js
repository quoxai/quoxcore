'use strict';

/**
 * NotesQ templates (AQ-9D P4): built-ins, user template notes
 * (properties.template === true), variable expansion and rendering.
 */

const BUILTIN_TEMPLATES = {
  daily: {
    name: 'daily',
    title_pattern: 'Daily {{date}}',
    markdown: [
      '## Focus', '', '- ', '',
      '## Tasks', '', '- [ ] ', '- [ ] ', '- [ ] ', '',
      '## Notes', '', '',
      '## End of day', '', '- What went well:', '- What to carry over:', '',
    ].join('\n'),
  },
  weekly: {
    name: 'weekly',
    title_pattern: 'Week {{week}}',
    markdown: [
      '## Goals for the week', '', '- [ ] ', '- [ ] ', '',
      '## Schedule', '', '',
      '## Notes', '', '',
      '## Review', '', '- Wins:', '- Misses:', '- Next week:', '',
    ].join('\n'),
  },
  meeting: {
    name: 'meeting',
    title_pattern: 'Meeting {{date}}',
    markdown: [
      '**Date:** {{date}} {{time}}', '',
      '## Attendees', '', '- ', '',
      '## Agenda', '', '1. ', '',
      '## Discussion', '', '',
      '## Action items', '', '- [ ] ', '',
    ].join('\n'),
  },
  decision: {
    name: 'decision',
    title_pattern: 'Decision {{date}}',
    markdown: [
      '## Context', '', '',
      '## Options considered', '', '- ', '',
      '## Decision', '', '',
      '## Consequences', '', '',
      '## Owner and review date', '', '',
    ].join('\n'),
  },
};

function isoWeek(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const wk = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

function varsFor(ms, tz) {
  const zone = tz || 'UTC';
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  } catch {
    return varsFor(ms, 'UTC');
  }
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    time: `${p.hour}:${p.minute}`,
    week: isoWeek(Number(p.year), Number(p.month), Number(p.day)),
    year: p.year,
  };
}

function expand(s, vars) {
  return String(s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

function renderTemplate(tpl, vars, opts = {}) {
  const all = { ...vars };
  const title = opts.title ? String(opts.title) : expand(tpl.title_pattern || '{{date}}', all);
  all.title = title;
  let body = expand(tpl.markdown, all).replace(/^\s*#\s+[^\n]*\n?/, '');
  body = body.replace(/^\n+/, '');
  return { title, markdown: `# ${title}\n\n${body}` };
}

const noteTitle = (n) => String(n.title || (n.properties && n.properties.title) || '');

async function resolveTemplate(name, { listUserTemplates, loadNote } = {}) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  if (BUILTIN_TEMPLATES[key]) {
    const b = BUILTIN_TEMPLATES[key];
    return { name: b.name, title_pattern: b.title_pattern, markdown: b.markdown, source: 'builtin' };
  }
  if (typeof listUserTemplates !== 'function') return null;
  const notes = (await listUserTemplates()) || [];
  const hit = notes.find((n) => n && n.properties && n.properties.template === true && noteTitle(n).toLowerCase() === key);
  if (!hit) return null;
  let md = hit.markdown;
  if (typeof md !== 'string' && typeof loadNote === 'function') md = await loadNote(hit.id);
  md = String(md || '').replace(/^\s*#\s+[^\n]*\n?/, '').replace(/^\n+/, '');
  const title = noteTitle(hit);
  return {
    name: title,
    title_pattern: (hit.properties && hit.properties.title_pattern) || `${title} {{date}}`,
    markdown: md,
    source: 'note',
    id: hit.id,
  };
}

module.exports = { BUILTIN_TEMPLATES, varsFor, renderTemplate, resolveTemplate, noteTitle };
