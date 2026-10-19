/**
 * `quox router` : read-only MikroTik RouterOS views via the NETWATCH tools (ROUTEROS-WIRE).
 *
 *   quox router health                    CPU, memory, temperature, uptime
 *   quox router leases                    DHCP leases
 *   quox router pools                     DHCP pool usage
 *   quox router conflicts                 IP address conflicts (ARP vs DHCP leases)
 *   quox router free-ip [--count n] [--pool name]   spare addresses for static use (reserves nothing)
 *   quox router vpn                       VPN tunnel health (WireGuard + IPsec)
 *   quox router wireguard                 WireGuard peers and whether they are connected
 *   quox router inventory                 routers and the devices connected to them
 *   quox router trust --show              the router's current TLS fingerprint (sends NO credentials; pins nothing)
 *
 * Every verb is one tool call through POST /api/v1/tools/execute. No verb writes to the router.
 * Engine: lib/core/router.js.
 */
import { resolveOrgId } from './helpers.js';
import { ROUTER_TOOLS, ROUTER_FORMATTERS, makeRouterExec, formatTrust } from '../core/router.js';
import { resolveEndpoint } from '../api/endpoints.js';

const DESCRIPTIONS = {
  health: 'Router CPU, memory, temperature and uptime (read only)',
  leases: 'DHCP leases: which devices hold an address (read only)',
  pools: 'DHCP pool usage: size, used, free (read only)',
  conflicts: 'IP address conflicts seen by the router, ARP vs DHCP leases (read only)',
  'free-ip': 'Spare pool addresses for static assignment; reserves nothing (read only)',
  vpn: 'VPN tunnel health, WireGuard and IPsec (read only)',
  wireguard: 'WireGuard peers and whether each is connected (read only)',
  inventory: 'MikroTik routers and the devices connected to them (read only)',
};

export function registerRouterCommands(program, ctx) {
  const { client, auth } = ctx;
  const json = () => program.opts().output === 'json';

  const router = program
    .command('router')
    .description('MikroTik RouterOS read-only views via NETWATCH (health, DHCP, VPN, inventory)');

  for (const verb of Object.keys(ROUTER_TOOLS)) {
    const cmd = router.command(verb).description(DESCRIPTIONS[verb]);
    if (verb === 'free-ip') {
      cmd.option('--count <n>', 'how many addresses (1-20)', '3').option('--pool <name>', 'only this DHCP pool');
    }
    cmd.action(async (opts = {}) => {
      auth.requireAuth();
      const exec = makeRouterExec({ client, orgId: resolveOrgId(auth, program) });
      const input = {};
      if (verb === 'free-ip') {
        const n = Number.parseInt(opts.count, 10);
        if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('--count must be a whole number from 1 to 20');
        input.count = n;
        if (opts.pool) input.pool = String(opts.pool);
      }
      const p = await exec(ROUTER_TOOLS[verb], input);
      if (json()) console.log(JSON.stringify(p, null, 2));
      else console.log(ROUTER_FORMATTERS[verb](p).join('\n'));
    });
  }

  // quoxai/quox#1236: the operator reads the endpoint's fingerprint here (no credentials sent),
  // compares it out of band, then sets MIKROTIK_TLS_PIN themselves. This verb never pins.
  router
    .command('trust')
    .description("Show the router's current TLS fingerprint, sending no credentials (never pins; you set MIKROTIK_TLS_PIN yourself)")
    .option('--show', "print the fingerprint the router's HTTPS endpoint presents now")
    .action(async (opts = {}) => {
      auth.requireAuth();
      if (!opts.show) {
        throw new Error('quox router trust only has --show. It never pins anything: compare the fingerprint out of band, then set MIKROTIK_TLS_PIN yourself.');
      }
      const ep = resolveEndpoint('router.tlsFingerprint');
      const data = await client.get(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
      if (json()) { console.log(JSON.stringify(data, null, 2)); return; }
      console.log(formatTrust(data).join('\n'));
    });
}
