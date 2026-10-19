/**
 * /watch <anything>: turn a site, repo, server, competitor page, metric or condition into an ongoing observer.
 * Backend (real): an agent schedule on the tasks service (POST /api/agent-schedules). Each tick the scheduler runs
 * the watch prompt as an objective and escalates to the owner's Approvals inbox per the escalation policy.
 */
const DAY = 1440;
const PAGE_WORDS = /\b(competitor|competitors|pricing|price|prices|plans?|changelog|blog|docs|landing)\b/i;
const SERVER_WORDS = /\b(server|host|box|vm|node|gitea|nginx|postgres|redis|db|database|service|container|docker|disk|cpu|memory|ram|load|health|healthy|status)\b/i;
const METRIC_WORDS = /\b(metric|signups?|sign-ups?|revenue|mrr|arr|traffic|errors?|latency|conversion|sales|users?|churn|orders?|visits?)\b/i;
const URL_RE = /\bhttps?:\/\/[^\s]+/i;
const GITHUB_RE = /\b(?:https?:\/\/)?github\.com\/[\w.-]+\/[\w.-]+/i;
const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i;

const DEFAULT_CONDITION = {
  site: 'it is down, returns an error status, or responds very slowly',
  server: 'it is unhealthy or unreachable',
  page: 'the page changes in a way that matters (prices, plans, wording, new sections)',
  repo: 'something needs attention: failing CI, new issues or security alerts'
};
const unitMin = (n, u) => { const x = u.toLowerCase(); return x.startsWith('h') ? n * 60 : x.startsWith('d') ? n * DAY : n; };
const strip = (s) => s.replace(/[),.;]+$/, '');

/** "quox.ai for downtime every 5 minutes" -> { kind, target, condition, everyMin|null } */
export function parseWatch(text) {
  let t = String(text || '').trim();
  let everyMin = null;
  const ev = t.match(/\b(?:every|each)\s+(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i);
  if (ev) { everyMin = unitMin(Number(ev[1]), ev[2]); t = t.replace(ev[0], ' '); }
  else {
    const w = t.match(/\b(hourly|daily)\b/i);
    if (w) { everyMin = w[1].toLowerCase() === 'hourly' ? 60 : DAY; t = t.replace(w[0], ' '); }
  }
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return { kind: 'none', target: '', condition: '', everyMin };

  let left = t, cond = '';
  const m = t.match(/^(.*?)\s+(?:for|when|whenever|if)\s+(.+)$/i);
  if (m && m[1].trim()) { left = m[1].trim(); cond = m[2].trim(); }

  const url = left.match(URL_RE)?.[0];
  const gh = left.match(GITHUB_RE)?.[0];
  const dom = !url && !gh ? left.match(DOMAIN_RE)?.[0] : null;
  const out = (kind, target, condition) => ({ kind, target, condition, everyMin });

  if (gh || /\brepo(sitory)?\b/i.test(left)) {
    return out('repo', gh ? strip(gh).replace(/^https?:\/\//, '') : (left.replace(/\brepo(sitory)?\b/i, '').trim() || left), cond || DEFAULT_CONDITION.repo);
  }
  if (url || dom) {
    const target = strip(url || dom);
    const pageish = PAGE_WORDS.test(left) && !/\b(down|downtime|uptime|outage)\b/i.test(cond);
    return pageish ? out('page', target, cond || DEFAULT_CONDITION.page) : out('site', target, cond || DEFAULT_CONDITION.site);
  }
  if (PAGE_WORDS.test(left) && !METRIC_WORDS.test(left)) return out('page', left, cond || DEFAULT_CONDITION.page);
  if (METRIC_WORDS.test(left)) return out('metric', left, cond || left);
  if (SERVER_WORDS.test(left) && left.split(' ').length <= 3) {
    const target = left.replace(/\b(health|healthy|status)\b/gi, '').replace(/\s+/g, ' ').trim() || left;
    return out('server', target, cond || DEFAULT_CONDITION.server);
  }
  return out('condition', cond ? left : t, cond || t);
}

/** Cron-friendly interval in minutes (floor 5, whole hours above an hour, cap one day). */
export function normalizeEvery(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return 15;
  if (n >= DAY) return DAY;
  if (n < 5) return 5;
  if (n < 60) return [5, 10, 15, 20, 30, 60].reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
  return Math.min(23, Math.max(1, Math.round(n / 60))) * 60;
}
export function everyToCron(min) {
  const n = normalizeEvery(min);
  if (n >= DAY) return '0 9 * * *';
  if (n === 60) return '0 * * * *';
  if (n > 60) return `0 */${n / 60} * * *`;
  return `*/${n} * * * *`;
}
export const everyLabel = (min) => { const n = normalizeEvery(min); return n >= DAY ? 'day' : n === 60 ? 'hour' : n > 60 ? `${n / 60} h` : `${n} min`; };

const KIND = { site: 'website', server: 'server', page: 'web page', repo: 'repository', metric: 'metric', condition: 'condition' };
const slug = (s) => { const x = String(s).replace(/^https?:\/\//i, '').replace(/\/+$/, ''); return x.length > 60 ? `${x.slice(0, 59)}…` : x; };

const watchPrompt = (name, w) => [
  `You are running a scheduled watch named "${name}".`,
  `Target (${KIND[w.kind] || w.kind}): ${w.target}.`,
  `Condition to detect: ${w.condition}.`,
  'Check the target now using the read-only tools you have. Change nothing.',
  'If the condition is NOT met, finish with the single line "ok" and raise nothing: stay quiet.',
  'If it IS met, raise it to the owner as a notification or inbox item: what you saw, when, and the evidence, in 3 lines or fewer.',
  'If you cannot check it at all (no tool, no access), say exactly that once; do not pretend it is fine.'
].join('\n');

/** -> { body (POST /api/agent-schedules), card[] , every } */
export function buildWatchPlan(w) {
  const every = normalizeEvery(w.everyMin ?? 15);
  const cron = everyToCron(every);
  const name = `watch:${slug(w.target)}`;
  const budget = { maxTokensPerRun: 20000, maxToolCallsPerRun: 10, maxDurationMs: 120000 };
  const body = {
    agentId: 'quox', name, cronExpression: cron, timezone: 'UTC',
    taskTemplate: { title: name, prompt: watchPrompt(name, w) },
    escalationPolicy: { onFailure: 'ESCALATE', escalateTo: null },
    budget, maxConsecutiveFailures: 5
  };
  const card = [
    ['Watch preview (nothing is created until you answer):', 'accent'],
    `  Watching   ${w.target}  (${KIND[w.kind] || w.kind})`,
    `  Triggers   ${w.condition}`,
    `  Checks     every ${everyLabel(every)} (cron ${cron}, UTC)`,
    '  Notifies   you, in your Approvals inbox, only when it triggers or the watch keeps failing',
    `  Runs as    agent quox, read-only by instruction, ${budget.maxToolCallsPerRun} tool calls per check`
  ];
  return { body, card, every };
}

const USAGE = 'Usage: /watch <what> [for <condition>] [every 5 min]   e.g. /watch quox.ai for downtime, /watch gitea health. Also /watch list, /watch stop <id>.';
const why = (e) => `${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}`;

export function createWatchCmd({ api, say, confirm }) {
  const listed = async () => {
    const rows = await api.watchList();
    return (Array.isArray(rows) ? rows : rows?.schedules || []).filter((s) => String(s.name || '').startsWith('watch:'));
  };
  async function list() {
    let rows;
    try { rows = await listed(); } catch (e) { return say(`Could not list watches: ${why(e)}`, 'warn'); }
    if (!rows.length) return say('No watches yet. /watch quox.ai for downtime sets one up.');
    say(`Watches (${rows.length}):`);
    for (const s of rows) say(`  ${s.id}  ${s.name.slice(6)}  cron ${s.cron_expression}  ${Number(s.enabled) === 0 ? 'stopped' : (s.last_status || 'no check yet')}`);
    return say('Stop one with /watch stop <id>.', 'dim');
  }
  async function stop(idArg) {
    if (!idArg) return say('Usage: /watch stop <id>  (/watch list shows ids)', 'warn');
    let rows;
    try { rows = await listed(); } catch (e) { return say(`Could not read watches: ${why(e)}`, 'warn'); }
    const hits = rows.filter((s) => s.id === idArg || s.id.toLowerCase().startsWith(idArg.toLowerCase()));
    if (hits.length !== 1) return say(hits.length ? `"${idArg}" matches ${hits.length} watches; use more of the id.` : `No watch "${idArg}". /watch list shows them.`, 'warn');
    try { await api.watchStop(hits[0].id); } catch (e) { return say(`Could not stop ${hits[0].id}: ${why(e)}`, 'warn'); }
    return say(`✔ Stopped watch ${hits[0].id} (${hits[0].name.slice(6)}).`, 'ok');
  }
  function create(text) {
    const w = parseWatch(text);
    if (!w.target) return say(USAGE, 'warn');
    const plan = buildWatchPlan(w);
    confirm.ask(plan.card, async () => {
      let r;
      try { r = await api.watchCreate(plan.body); } catch (e) { return say(`Could not create the watch: ${why(e)}. Nothing is watching.`, 'warn'); }
      if (!r?.id) return say('The server returned no watch id, so I cannot confirm it exists. /watch list shows what is there.', 'warn');
      say(`✔ Watching ${w.target} (id ${r.id}). First check within ${everyLabel(plan.every)}.`, 'ok');
      say(`  Stop it: /watch stop ${r.id}    See all: /watch list`);
    }, { prompt: 'Create this watch?' });
    return undefined;
  }
  return {
    handle(arg) {
      const a = String(arg || '').trim();
      if (!a) return say(USAGE);
      if (!api.watchCreate) return say('Watches are not available in this mode.', 'warn');
      if (/^list$/i.test(a)) return list();
      const s = a.match(/^(?:stop|rm)\b\s*(.*)$/i);
      return s ? stop(s[1].trim()) : create(a);
    }
  };
}
