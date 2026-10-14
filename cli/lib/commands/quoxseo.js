/**
 * `quox seo` — the witnessed SEO warehouse from the terminal (QUOXSEO S2).
 *
 * Every call goes through the collector proxy: the governed boundary that
 * resolves the org and enforces the licence gate. No direct-to-:3110 flag,
 * deliberately (BLUEPRINT defect 5.1: a standalone CLI defaulting to the
 * ungoverned path). The repo-local `quoxseo` bin in quox-seo/ is the
 * OPERATOR tool on the box that hosts the warehouse; this command is the
 * governed parity surface every install gets.
 */

import { resolveEndpoint } from '../api/endpoints.js';

function annotate(err) {
  const msg = err?.message || String(err);
  if (/not licensed|entitlement/i.test(msg)) {
    err.message = `${msg}\nThe service is refusing you: that is the licence gate working, not a fault.`;
  } else if (/org_gate|org_required/i.test(msg)) {
    err.message = `${msg}\nNo organisation context. Run \`quox auth login\` or select an org first.`;
  } else if (/unavailable/i.test(msg)) {
    err.message = `${msg}\nThe QuoxSEO backend (:3110) is not reachable from the collector on this install.`;
  }
  throw err;
}

async function get(client, id, params = {}) {
  const ep = resolveEndpoint(id, params);
  return client.get(ep.path, { service: ep.service });
}

const short = (h, n = 12) => (typeof h === 'string' ? `${h.slice(0, n)}…` : '-');

export function registerQuoxseoCommands(program, ctx) {
  const { client } = ctx;

  // Honour the global --json / -o json flag on every seo subcommand: if set,
  // emit the raw API payload and skip human rendering (MOAT: `--json seo
  // changes` returned text). Returns true when it handled output.
  const jsonOut = (data) => {
    if (program.opts().output === 'json' || program.opts().json) {
      console.log(JSON.stringify(data, null, 2));
      return true;
    }
    return false;
  };

  const s = program
    .command('seo')
    .description('QuoxSEO: the URL warehouse with a witnessed history');

  s.command('status')
    .description('Latest crawl summary: health, coverage, orphans, witness state')
    .action(async () => {
      try {
        const data = await get(client, 'quoxseo.summary');
        if (jsonOut(data)) return;
        const { summary, empty } = data;
        if (empty || !summary) { console.log('Warehouse is empty; the daily ingest has not run yet.'); return; }
        const c = summary.crawl;
        console.log(`crawl #${c.id}  ${c.started_at}  ${summary.ok_count}/${summary.url_count} ok`);
        console.log(`ward: ${c.ward_seq != null ? `seq ${c.ward_seq} (witnessed ${c.witnessed_at})` : 'UNWITNESSED'}`);
        console.log(`root: ${c.root_hash}`);
        console.log(`orphans ${summary.orphans} · noindex ${summary.noindex} · no meta ${summary.missing_meta_description} · discovered-not-in-sitemap ${summary.discovered_not_in_sitemap}`);
        console.log(`gsc: ${summary.with_gsc} urls with data · ${summary.totals.impressions} impressions · ${summary.totals.clicks} clicks (${c.gsc_range_start}..${c.gsc_range_end})`);
      } catch (err) { annotate(err); }
    });

  // quox#583: registration parity. The backend was multi-site from day one
  // but the only entrance was an ungoverned loopback curl on the warehouse
  // host; these two verbs are the governed door.
  s.command('sites')
    .description("The org's registered properties")
    .action(async () => {
      try {
        const data = await get(client, 'quoxseo.sites');
        if (jsonOut(data)) return;
        const props = data.properties || [];
        if (!props.length) { console.log('No properties registered. Add one: quox seo add-site <origin>'); return; }
        for (const p of props) {
          console.log(`#${p.id}  ${p.origin}${p.gsc_property ? `  gsc:${p.gsc_property}` : ''}`);
        }
      } catch (err) { annotate(err); }
    });

  s.command('add-site <origin>')
    .description('Register a site for this org (governed write, witnessed at the collector boundary)')
    .option('--gsc <property>', 'GSC property (e.g. sc-domain:example.com)')
    .option('--ga4 <property>', 'GA4 property id')
    .action(async (origin, opts) => {
      try {
        const ep = resolveEndpoint('quoxseo.sites.add');
        const data = await client.post(ep.path, {
          service: ep.service,
          body: { origin, gsc_property: opts.gsc ?? null, ga4_property: opts.ga4 ?? null },
        });
        if (jsonOut(data)) return;
        const site = data.site || {};
        console.log(`registered #${site.id ?? '?'}  ${site.origin ?? origin}${site.gsc_property ? `  gsc:${site.gsc_property}` : ''}${site.ga4_property ? `  ga4:${site.ga4_property}` : ''}`);
        console.log('The daily ingest will pick this site up on its next run.');
      } catch (err) { annotate(err); }
    });

  s.command('remove-site <site>')
    .description('Remove a registered site and its warehouse data for this org (governed, witnessed). <site> is an origin or property id')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async (site, opts) => {
      try {
        const list = await get(client, 'quoxseo.sites');
        const props = list.properties || [];
        const norm = (v) => String(v).trim().replace(/\/+$/, '').toLowerCase();
        const target = props.find((p) => String(p.id) === String(site).trim() || norm(p.origin) === norm(site));
        if (!target) {
          throw new Error(`Site not found: ${site} is not registered for this org. List them with: quox seo sites`);
        }
        const warn = `This permanently removes ${target.origin} (#${target.id}) from this org and deletes its crawl, GSC and GA4 warehouse data. This cannot be undone.`;
        if (!opts.yes && program.opts().yes !== true) {
          if (!process.stdin.isTTY) {
            throw new Error(`${warn} Confirmation needed; re-run with --yes in a non-interactive shell: quox seo remove-site ${target.origin} --yes`);
          }
          console.log(warn);
          const { confirmDestructive } = await import('../core/confirm.js');
          const ok = await confirmDestructive(program, {}, `Remove ${target.origin}?`);
          if (!ok) { console.log('Aborted. Nothing was removed.'); return; }
        }
        const ep = resolveEndpoint('quoxseo.sites.remove', { id: target.id });
        let data;
        try {
          data = await client.delete(ep.path, { service: ep.service });
        } catch (err) {
          const code = err?.status ?? err?.statusCode ?? err?.response?.status;
          if (code === 404 || code === 405 || /\b(404|405)\b|not found|read.only/i.test(err?.message || '')) {
            err.message = `${err.message}\nThis install's QuoxSEO service does not support site removal (no DELETE route), or the site no longer exists. Nothing was removed.`;
          }
          throw err;
        }
        if (jsonOut(data)) return;
        console.log(`removed #${target.id}  ${target.origin}`);
      } catch (err) { annotate(err); }
    });

  s.command('urls')
    .description('Warehouse rows for the latest crawl')
    .option('--filter <f>', 'orphans | noindex | errors | no-gsc | discovered')
    .option('--q <text>', 'substring match on path/title')
    .option('--sort <s>', 'impressions')
    .option('--limit <n>', 'max rows', '50')
    .action(async (opts) => {
      try {
        const qs = new URLSearchParams();
        if (opts.filter) qs.set('filter', opts.filter);
        if (opts.q) qs.set('q', opts.q);
        if (opts.sort) qs.set('sort', opts.sort);
        qs.set('limit', opts.limit);
        const data = await get(client, 'quoxseo.urls', { query: `?${qs}` });
        if (jsonOut(data)) return;
        const { urls, total } = data;
        console.log(`${total} rows${urls.length < total ? ` (showing ${urls.length})` : ''}`);
        for (const u of urls) {
          const flags = [u.orphan ? 'ORPHAN' : null, u.in_sitemap ? null : 'NOT-IN-SITEMAP',
            u.meta_robots && /noindex/i.test(u.meta_robots) ? 'NOINDEX' : null].filter(Boolean).join(',');
          console.log(`${String(u.status ?? 'ERR').padEnd(4)} ${u.path}  imp=${u.gsc_impressions ?? '-'} pos=${u.gsc_position ?? '-'} inlinks=${u.inlinks_contextual}/${u.inlinks_all}${flags ? `  [${flags}]` : ''}`);
        }
      } catch (err) { annotate(err); }
    });

  s.command('url <path>')
    .description('Full latest warehouse record for one URL path')
    .action(async (urlPath) => {
      try {
        const { url } = await get(client, 'quoxseo.url.detail', { path: urlPath });
        console.log(JSON.stringify(url, null, 2));
      } catch (err) { annotate(err); }
    });

  s.command('crawls')
    .description('Ingest runs with root hashes and witness sequence')
    .action(async () => {
      try {
        const data = await get(client, 'quoxseo.crawls');
        if (jsonOut(data)) return;
        const { crawls } = data;
        for (const c of crawls) {
          console.log(`#${c.id} ${c.started_at} ${c.status} ${c.ok_count}/${c.url_count} root ${short(c.root_hash, 16)} ward ${c.ward_seq != null ? `seq ${c.ward_seq}` : 'UNWITNESSED'}`);
        }
      } catch (err) { annotate(err); }
    });

  s.command('changes')
    .description('Signed change events (the witnessed change log)')
    .option('--crawl <id>', 'events for one crawl instead of the recent log')
    .option('--limit <n>', 'max events', '50')
    .action(async (opts) => {
      try {
        const qs = opts.crawl ? `?crawl_id=${encodeURIComponent(opts.crawl)}` : `?limit=${encodeURIComponent(opts.limit)}`;
        const data = await get(client, 'quoxseo.changes', { query: qs });
        if (jsonOut(data)) return;
        const { changes } = data;
        if (!changes.length) { console.log('No change events yet. The first real site change will land here, signed.'); return; }
        for (const c of changes) {
          console.log(c.type === 'field_changed'
            ? `~ ${c.path} ${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)} (crawl #${c.crawl_id})`
            : `${c.type === 'url_added' ? '+' : '-'} ${c.path} (crawl #${c.crawl_id})`);
        }
      } catch (err) { annotate(err); }
    });

  s.command('trends')
    .description('GSC winners & losers over time (period compare: last 28d vs prior 28d)')
    .option('--scope <s>', 'url | query (default: url)', 'url')
    .option('--limit <n>', 'max movers', '25')
    .action(async (opts) => {
      try {
        const qs = new URLSearchParams();
        qs.set('scope', opts.scope);
        qs.set('limit', opts.limit);
        const data = await get(client, 'quoxseo.trends', { query: `?${qs}` });
        if (jsonOut(data)) return;
        if (!data.crawl_id) { console.log('No trend data yet; the ingest with Search Console access has not run.'); return; }
        const w = data.windows;
        if (w) console.log(`period ${w.previous.start}..${w.previous.end}  ->  ${w.current.start}..${w.current.end}`);
        const rows = opts.scope === 'query' ? data.queries : data.urls;
        const sum = opts.scope === 'query' ? data.query_summary : data.url_summary;
        if (sum) console.log(`winners ${sum.winner} · losers ${sum.loser} · new ${sum.new} · lost ${sum.lost} · flat ${sum.flat}`);
        if (!rows || !rows.length) { console.log('No movers above the impression floor this period.'); return; }
        const arrow = (r) => (r.position_improved ? '↑' : '');
        for (const r of rows) {
          const key = r.key;
          const tag = r.status.toUpperCase().padEnd(7);
          console.log(`${tag} ${key}  impr ${r.prev_impressions}→${r.impressions}  clk ${r.prev_clicks}→${r.clicks}  pos ${r.prev_position ?? '-'}→${r.position ?? '-'} ${arrow(r)}`);
        }
      } catch (err) { annotate(err); }
    });

  s.command('coverage')
    .description("Google index coverage: what's indexed, and where Google disagrees with the page")
    .option('--filter <f>', 'indexed | not-indexed')
    .option('--limit <n>', 'max rows', '30')
    .action(async (opts) => {
      try {
        const qs = new URLSearchParams();
        if (opts.filter) qs.set('filter', opts.filter);
        qs.set('limit', opts.limit);
        const data = await get(client, 'quoxseo.inspection', { query: `?${qs}` });
        if (jsonOut(data)) return;
        const c = data.coverage || { total: 0 };
        if (!c.total) { console.log('No URL Inspection data yet; the ingest inspects a rolling batch each run.'); return; }
        console.log(`coverage: ${c.indexed}/${c.total} indexed · ${c.not_indexed} not indexed`);
        for (const [state, n] of Object.entries(c.by_state || {}).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${String(n).padStart(4)}  ${state}`);
        }
        if (data.conflicts?.length) {
          console.log(`\nconflicts (Google vs the page), ${data.conflicts.length}:`);
          for (const x of data.conflicts) console.log(`  [${x.severity}] ${x.path} — ${x.type}: ${x.detail}`);
        }
      } catch (err) { annotate(err); }
    });

  s.command('verify')
    .description('Re-verify the WARD chain, signatures and root hashes server-side')
    .action(async () => {
      try {
        const r = await get(client, 'quoxseo.verify');
        if (jsonOut(r)) return;
        console.log(`chain ${r.chain_status} · ${r.crawls.length} witnessed crawls · ${r.all_ok ? 'ALL OK' : 'FAILURES'}`);
        for (const c of r.crawls) {
          console.log(`  crawl #${c.crawl_id} seq ${c.ward_seq} statement ${c.statement_hash_ok ? 'ok' : 'FAIL'} root ${c.root_hash_ok ? 'ok' : 'FAIL'}`);
        }
        if (!r.all_ok) process.exitCode = 1;
      } catch (err) { annotate(err); }
    });

  // Paid layer (DataForSEO), read-only over data already bought and persisted
  // by the CLI/scheduler on the warehouse host. None of these three trigger a
  // paid DataForSEO call; they only read what has already been stored.
  s.command('keywords')
    .description("Stored keyword universe for the org's primary property (DataForSEO)")
    .option('--limit <n>', 'max rows', '200')
    .action(async (opts) => {
      try {
        const qs = new URLSearchParams();
        qs.set('limit', opts.limit);
        const data = await get(client, 'quoxseo.keywords', { query: `?${qs}` });
        if (jsonOut(data)) return;
        const { property, keywords = [] } = data;
        if (!property) { console.log('No property registered. Add one: quox seo add-site <origin>'); return; }
        if (!keywords.length) { console.log('No keyword data yet. DataForSEO keywords are bought and stored by the CLI/scheduler, not fetched live here.'); return; }
        for (const k of keywords) {
          console.log(`${String(k.volume ?? '-').padStart(7)}  ${k.keyword}${k.difficulty != null ? `  kd=${k.difficulty}` : ''}${k.cpc != null ? `  cpc=${k.cpc}` : ''}${k.intent ? `  ${k.intent}` : ''}`);
        }
      } catch (err) { annotate(err); }
    });

  s.command('gaps [competitor]')
    .description('Competitor keyword and page gaps against the latest witnessed crawl (no argument lists known competitors)')
    .action(async (competitor) => {
      try {
        const qs = competitor ? `?competitor=${encodeURIComponent(competitor)}` : '';
        const data = await get(client, 'quoxseo.gaps', { query: qs });
        if (jsonOut(data)) return;
        if (!data.property) { console.log('No property registered. Add one: quox seo add-site <origin>'); return; }
        if (!competitor) {
          const comps = data.competitors || [];
          if (!comps.length) { console.log('No competitor keyword data yet. That set is bought and stored by the CLI/scheduler, not fetched live here.'); return; }
          for (const c of comps) console.log(`${c.competitor}  ${c.keywords} keywords  fetched ${c.fetched_at}`);
          return;
        }
        const sum = data.summary || {};
        console.log(`${data.competitor}: ${sum.gap_keywords ?? 0} gap keywords, ${sum.gap_volume ?? 0} combined volume (they beat us ${sum.they_beat_us ?? 0}, we are absent ${sum.we_are_absent ?? 0})`);
        for (const g of data.keyword_gaps || []) {
          console.log(`${String(g.volume ?? '-').padStart(7)}  ${g.keyword}  them=${g.their_position} us=${g.our_position ?? '-'}`);
        }
      } catch (err) { annotate(err); }
    });

  s.command('backlinks [competitor]')
    .description('Referring-domain profile, or the link gap against a competitor (no argument shows our own profile)')
    .action(async (competitor) => {
      try {
        const qs = competitor ? `?competitor=${encodeURIComponent(competitor)}` : '';
        const data = await get(client, 'quoxseo.backlinks', { query: qs });
        if (jsonOut(data)) return;
        if (!data.property) { console.log('No property registered. Add one: quox seo add-site <origin>'); return; }
        if (!competitor) {
          console.log(`${data.subject}: ${(data.referring_domains || []).length} referring domains`);
          for (const d of data.referring_domains || []) {
            console.log(`  rank=${d.rank ?? '-'} backlinks=${d.backlinks ?? '-'}${d.dofollow ? '' : ' nofollow'}  ${d.domain}`);
          }
          if (data.subjects?.length) {
            console.log('\nsubjects with stored data:');
            for (const sub of data.subjects) console.log(`  ${sub.subject}  ${sub.domains} domains  fetched ${sub.fetched_at}`);
          }
          return;
        }
        const sum = data.summary || {};
        console.log(`${data.competitor}: ${sum.missing_domains ?? 0} domains link to them but not us (${sum.missing_backlinks ?? 0} backlinks, top rank ${sum.top_rank ?? 0})`);
        for (const d of data.link_gap || []) console.log(`  rank=${d.rank ?? '-'} backlinks=${d.backlinks ?? '-'}  ${d.domain}`);
      } catch (err) { annotate(err); }
    });

  // quox#676: the governed report-delivery endpoint had no CLI verb, so
  // delivering meant calling the collector with the internal service key from
  // inside its container. Unset options are omitted so the server applies its
  // own defaults (recipient = your account email, its default channels).
  const report = s.command('report').description('QuoxSEO reports');
  report.command('deliver')
    .description('Deliver the latest SEO report (email via instance SMTP and/or the inbox; witnessed)')
    .option('--recipient <email>', 'who receives the email (default: your account email)')
    .option('--org <id>', 'org whose warehouse to report on (default: your session org)')
    .option('--channels <list>', 'comma-separated: email,inbox (default: server default)')
    .action(async (opts) => {
      try {
        const ep = resolveEndpoint('quoxseo.report.deliver');
        const body = {};
        if (opts.recipient) body.recipient = opts.recipient;
        if (opts.org) body.org_id = opts.org;
        if (opts.channels) body.channels = String(opts.channels).split(',').map((c) => c.trim()).filter(Boolean);
        const data = await client.post(ep.path, { service: ep.service, body });
        if (jsonOut(data)) return;
        if (data.email) {
          console.log(data.email.success === false
            ? `email: FAILED (${data.email.error || 'no reason given'})`
            : `email: sent${body.recipient ? ` to ${body.recipient}` : ''}`);
        }
        if (data.inbox) console.log(data.inbox.error ? `inbox: FAILED (${data.inbox.error})` : 'inbox: posted');
        if (data.csvIncluded != null) console.log(`csv attached: ${data.csvIncluded ? 'yes' : 'no'}`);
      } catch (err) { annotate(err); }
    });

  s.command('health')
    .description('Backend health through the governed proxy')
    .action(async () => {
      try {
        console.log(JSON.stringify(await get(client, 'quoxseo.health')));
      } catch (err) { annotate(err); }
    });
}

export default registerQuoxseoCommands;
