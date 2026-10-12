/**
 * `quox facebook` — Facebook Pages plugin verbs, FB-3 (linkedin CLI parity).
 *
 * quox facebook post "<message>" --page <page_id> [--link <url>] [--image <https url>]
 * quox facebook pages [--limit <n>]
 * quox facebook posts --page <page_id> [--limit <n>]
 * quox facebook insights --page <page_id> [--metrics <a,b,c>] [--period <period>]
 * quox facebook lead-forms --page <page_id>
 * quox facebook leads --form <form_id>
 *
 * The write verb executes the facebook_pages connector tool through the
 * governed collector endpoint (POST /api/v1/tools/execute -> connector
 * bridge). The bridge gates it on requiresApproval: it files an owner
 * approval card and returns immediately with
 * { pending:true, status:'awaiting_approval', approvalId, inbox_item_id }.
 * The actual Facebook Graph API write only happens once the owner approves
 * via the dashboard inbox or `quox inbox respond <id> --action approve`.
 * Reads (pages, posts, insights, lead-forms, leads) execute directly.
 *
 * Pages are addressed by numeric Page ID by design: the CLI has no
 * org-scoped default-page lookup yet, so --page/--form are required on
 * every verb rather than silently guessed.
 */

import { formatDetail, printSuccess, printInfo } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

/**
 * Execute one facebook_pages connector tool via the governed collector
 * endpoint. A pending-approval response is a SUCCESS shape here (the card
 * was filed); only a non-pending success:false is an error.
 */
async function executeFacebookTool({ client, auth, program }, toolName, input) {
  auth.requireAuth();
  const orgId = resolveOrgId(auth, program);
  const ep = resolveEndpoint('v1.tools.execute');
  const body = { tool_name: toolName, input, org_id: orgId };
  const data = await client.post(ep.path, { service: ep.service, body });
  if (data && data.success === false && !data.pending) {
    throw new Error(`${toolName} via POST ${ep.path} returned success:false: ${data.error || 'unknown error'}`);
  }
  return data;
}

function printAwaitingApproval(action, data) {
  const itemRef = data.inbox_item_id || data.approvalId || 'unknown';
  printSuccess(`${action} filed for owner approval - inbox item ${itemRef} (awaiting approval). Nothing publishes until an approver says yes.`);
  if (data.inbox_item_id) {
    printInfo(`Review and approve: quox inbox get ${data.inbox_item_id}  (or: quox inbox respond ${data.inbox_item_id} --action approve)`);
  }
}

export function registerFacebookCommands(program, ctx) {
  const { client, auth } = ctx;

  const facebook = program
    .command('facebook')
    .description('Facebook Pages publishing (organic): governed, HITL-approved via HITL Inbox');

  // ── facebook post ────────────────────────────────────────────────────────

  facebook
    .command('post')
    .description('Draft a Facebook Page post. Files an owner approval card and returns immediately; never posts directly.')
    .argument('<message>', 'post text')
    .requiredOption('--page <page_id>', 'Facebook Page ID to post to')
    .option('--link <url>', 'attach a link URL')
    .option('--image <url>', 'attach an image from an https URL; the Graph API fetches it server-side')
    .action(async (message, options) => {
      const input = { page_id: options.page, message };
      if (options.link) input.link = options.link;
      if (options.image) input.image_url = options.image;

      const data = await executeFacebookTool({ client, auth, program }, 'facebook_pages_publish_page_post', input);

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printAwaitingApproval('Post', data);
    });

  // ── facebook pages (read) ────────────────────────────────────────────────

  facebook
    .command('pages')
    .description('List the Facebook Pages this token can manage (read-only, no approval needed).')
    .option('--limit <n>', 'max pages to return (max 100)', '25')
    .action(async (options) => {
      const limit = Math.min(parseInt(options.limit, 10) || 25, 100);
      const data = await executeFacebookTool({ client, auth, program }, 'facebook_pages_get_pages', { limit });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const pages = data.result || [];
      if (pages.length === 0) {
        printInfo('No pages returned.');
        return;
      }
      for (const p of pages) {
        console.log(`${p.id}  ${p.name}  ${p.category || ''}  followers:${p.followers ?? 'unknown'}`);
      }
    });

  // ── facebook posts (read) ────────────────────────────────────────────────

  facebook
    .command('posts')
    .description('List recent posts on a Facebook Page (read-only, no approval needed).')
    .requiredOption('--page <page_id>', 'Facebook Page ID')
    .option('--limit <n>', 'number of posts (max 50)', '10')
    .action(async (options) => {
      const limit = Math.min(parseInt(options.limit, 10) || 10, 50);
      const data = await executeFacebookTool({ client, auth, program }, 'facebook_pages_get_page_posts', {
        page_id: options.page,
        limit,
      });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const posts = data.result || [];
      if (posts.length === 0) {
        printInfo('No posts returned.');
        return;
      }
      for (const p of posts) {
        console.log(`${p.id}  ${p.created_time || ''}`);
        console.log(`  ${String(p.message || '').replace(/\n/g, '\n  ')}`);
      }
    });

  // ── facebook insights (read) ─────────────────────────────────────────────

  facebook
    .command('insights')
    .description('Show organic Page Insights (impressions, engagement, fans) for a Facebook Page.')
    .requiredOption('--page <page_id>', 'Facebook Page ID')
    .option('--metrics <metrics>', 'comma-separated metric names')
    .option('--period <period>', 'day|week|days_28|month|lifetime')
    .action(async (options) => {
      const input = { page_id: options.page };
      if (options.metrics) input.metrics = options.metrics;
      if (options.period) input.period = options.period;
      const data = await executeFacebookTool({ client, auth, program }, 'facebook_pages_get_page_insights', input);

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const series = data.result || [];
      if (series.length === 0) {
        printInfo('No insights returned.');
        return;
      }
      for (const m of series) {
        const latest = (m.values || [])[m.values.length - 1];
        console.log(`${m.title || m.name}: ${latest ? JSON.stringify(latest.value) : 'unknown'}`);
      }
    });

  // ── facebook lead-forms (read) ───────────────────────────────────────────

  facebook
    .command('lead-forms')
    .description('List the Lead Ads forms attached to a Facebook Page.')
    .requiredOption('--page <page_id>', 'Facebook Page ID')
    .action(async (options) => {
      const data = await executeFacebookTool({ client, auth, program }, 'facebook_pages_get_lead_forms', { page_id: options.page });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const forms = data.result || [];
      if (forms.length === 0) {
        printInfo('No lead forms returned.');
        return;
      }
      for (const f of forms) {
        console.log(`${f.id}  ${f.name}  status:${f.status || 'unknown'}  leads:${f.leads_count ?? 'unknown'}`);
      }
    });

  // ── facebook leads (read) ────────────────────────────────────────────────

  facebook
    .command('leads')
    .description('Retrieve submitted leads for a Lead Ads form.')
    .requiredOption('--form <form_id>', 'Lead form ID (from lead-forms)')
    .action(async (options) => {
      const data = await executeFacebookTool({ client, auth, program }, 'facebook_pages_get_leads', { form_id: options.form });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const leads = data.result || [];
      if (leads.length === 0) {
        printInfo('No leads returned.');
        return;
      }
      for (const l of leads) {
        console.log(`${l.id}  ${l.created_time || ''}`);
        console.log(`  ${JSON.stringify(l.fields || {})}`);
      }
    });
}
