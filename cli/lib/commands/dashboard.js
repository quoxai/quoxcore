/**
 * `quox dashboard [page]`: open the web dashboard already signed in, via a one-time link
 * (10 minutes, single use). Same engine as /dashboard in the Quox client (lib/quoxon/slash/dashboard.js).
 * Over SSH it prints the link and does not open a browser. The link is a credential: it is printed
 * to the terminal only, never logged.
 */
import { resolveEndpoint } from '../api/endpoints.js';
import { runDashboard, dashboardLines, PAGES } from '../quoxon/slash/dashboard.js';
import { supportsHyperlinks } from '../quoxon/markdown.js';
import { resolveDashboardBase, detectLanIp } from '../quoxon/hostUrls.js';
import { loadJourney } from '../quoxon/onboarding/journey.js';

/**
 * Z2H-R4: the address to print, resolved exactly like /dashboard in the Quox client (api.js
 * dashboardBase): server app URL, else a non-loopback profile URL, else the install finale's URL,
 * else this machine's LAN IP. Over SSH a localhost link only works on the Quox box itself.
 */
export async function commandDashboardBase({ client, config, journey = loadJourney, lanIp = detectLanIp() } = {}) {
  const profileUrl = config.getActiveProfile?.()?.url || config.getBaseUrl();
  let serverApp = null;
  try { const ep = resolveEndpoint('admin.instance.basics.get'); const r = await client.get(ep.path, { service: ep.service, retries: 0 }); serverApp = r?.effective?.appBaseUrl || null; } catch { serverApp = null; }
  let journeyUrl = null; try { journeyUrl = journey()?.dashboardUrl || null; } catch { journeyUrl = null; }
  return resolveDashboardBase({ serverApp, profileUrl, journeyUrl, lanIp }).url;
}

export function registerDashboardCommands(program, ctx) {
  const { client, auth, config, lanIp = detectLanIp, journey = loadJourney } = ctx;
  program
    .command('dashboard')
    .description(`Open the web dashboard signed in (one-time link, 10 minutes). Pages: ${Object.keys(PAGES).join(', ')}`)
    .argument('[page]', 'dashboard page to land on')
    .action(async (page) => {
      auth.requireAuth();
      const baseUrl = await commandDashboardBase({ client, config, journey, lanIp: lanIp() });
      const r = await runDashboard({ page, baseUrl, mint: () => { const ep = resolveEndpoint('auth.login-link'); return client.post(ep.path, { service: ep.service, body: {}, retries: 0 }); } });
      if (program.opts().output === 'json') {
        console.log(JSON.stringify({ kind: r.kind, url: r.url ?? null, opened: Boolean(r.opened), remote: Boolean(r.remote), error: r.error ?? null }, null, 2));
      } else {
        for (const l of dashboardLines(r, { hyperlinks: supportsHyperlinks() })) console.log(l.text);
      }
      if (r.kind === 'error') process.exitCode = 1;
    });
}
