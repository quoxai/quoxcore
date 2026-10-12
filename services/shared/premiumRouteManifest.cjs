// LICENSE-LAUNCH LL-6c — the premium route manifest.
//
// WHY THIS EXISTS
// ---------------
// LL-1b, LE-3f, LE-3g, LL-6a and LL-6b each closed a licence hole, and each
// one was found the same way: somebody read a router top to bottom and noticed
// a door with no lock next to a door with one. The plugin storage routes were
// registered BEFORE the gated catch-all and never crossed its gate. Bundle and
// CSS bytes served to any member. /data and /secrets/reveal open while /bundle
// 402'd. Every QuoxChat spend path open while /message 402'd. That is five
// instances of one defect class, and reading harder is not a fix for it.
//
// So the licensed surface gets written DOWN, in one place, as data. Each row
// says what the route is, which plugin entitlement governs it, what it must do
// to a caller who does not hold that entitlement, and what a test needs to seed
// to drive it. Adding a premium route means adding a row; the coverage tests
// then refuse to pass until something drives it.
//
// .cjs so both sides can read it: auth/tasks are ESM, collector is CJS, same
// reasoning as services/shared/routeIntrospection.cjs.
//
// WHO CONSUMES IT
// ---------------
//   services/auth/tests/premium-route-402-coverage.test.js       (node --test)
//   services/collector/test/premiumRouteCoverage.test.js         (vitest)
//   services/collector/test/quoxchat-license-route-coverage.test.js (node --test)
//
// Each binds a DRIVER to every row it owns and asserts the row's expectation.
// None of them may silently skip a row: each asserts that every row scoped to
// it has a driver, so a row added here with no driver anywhere turns a suite
// red rather than quietly widening the manifest.
//
// ROW SHAPE
// ---------
//   id            stable key; drivers bind by it
//   service       'auth' | 'collector'
//   family        groups rows that share a gate; also the completeness unit
//   method        HTTP method, uppercase
//   path          path as a client sees it (mount included)
//   routerPath    path as DECLARED on its router, for the route-table guard
//   plugin        the governing entitlement id, or ':pluginId' when the route
//                 is generic over the governed set
//   gate          the middleware/function that refuses (documentation, and the
//                 thing a source-shape assertion looks for)
//   seeds         what a test must set up to reach the gate at all
//   expect        { unentitled, unauthenticated } — see below
//   note          why this row is the way it is
//
// expect.unentitled is one of:
//   { status: 402, error: 'LICENSE_REQUIRED' }   the normal case
//   { entitlementGated: false, why: '...' }      deliberately NOT gated; the
//                                                driver asserts the compensating
//                                                control instead
// expect.unauthenticated is a status (401) or null when the route sits behind
// a service-key boundary that answers differently.

'use strict';

const PREMIUM_ROUTES = [
  // ── auth: plugin distribution (LE-3g) ────────────────────────────────────
  {
    id: 'auth.plugin.bundle',
    service: 'auth',
    family: 'plugin-distribution',
    method: 'GET',
    path: '/api/orgs/:orgId/plugins/:pluginId/bundle',
    routerPath: '/orgs/:orgId/plugins/:pluginId/bundle',
    plugin: ':pluginId',
    gate: 'requireBundleEntitlement',
    seeds: ['org', 'active member', 'plugin_install with a bundle blob'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
    note: 'The bytes themselves. LE-3g option 2: withhold the bundle until signed activation.',
  },
  {
    id: 'auth.plugin.css',
    service: 'auth',
    family: 'plugin-distribution',
    method: 'GET',
    path: '/api/orgs/:orgId/plugins/:pluginId/css',
    routerPath: '/orgs/:orgId/plugins/:pluginId/css',
    plugin: ':pluginId',
    gate: 'requireBundleEntitlement',
    seeds: ['org', 'active member', 'plugin_install with a css blob'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
    note: 'Same blob row as /bundle; a separate route, so a separate row.',
  },

  // ── auth: per-plugin aux surfaces (LL-6b) ────────────────────────────────
  {
    id: 'auth.plugin.data.list',
    service: 'auth',
    family: 'plugin-aux',
    method: 'GET',
    path: '/api/orgs/:orgId/plugins/:pluginId/data',
    routerPath: '/orgs/:orgId/plugins/:pluginId/data',
    plugin: ':pluginId',
    gate: 'requirePluginEntitlement',
    seeds: ['org', 'active member'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
  },
  {
    id: 'auth.plugin.data.get',
    service: 'auth',
    family: 'plugin-aux',
    method: 'GET',
    path: '/api/orgs/:orgId/plugins/:pluginId/data/:key',
    routerPath: '/orgs/:orgId/plugins/:pluginId/data/:key',
    plugin: ':pluginId',
    gate: 'requirePluginEntitlement',
    seeds: ['org', 'active member'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
  },
  {
    id: 'auth.plugin.data.put',
    service: 'auth',
    family: 'plugin-aux',
    method: 'PUT',
    path: '/api/orgs/:orgId/plugins/:pluginId/data/:key',
    routerPath: '/orgs/:orgId/plugins/:pluginId/data/:key',
    plugin: ':pluginId',
    gate: 'requirePluginEntitlement',
    seeds: ['org', 'active member'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
  },
  {
    id: 'auth.plugin.data.delete',
    service: 'auth',
    family: 'plugin-aux',
    method: 'DELETE',
    path: '/api/orgs/:orgId/plugins/:pluginId/data/:key',
    routerPath: '/orgs/:orgId/plugins/:pluginId/data/:key',
    plugin: ':pluginId',
    gate: 'requirePluginEntitlement',
    seeds: ['org', 'active member'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
  },
  {
    id: 'auth.plugin.secrets.list',
    service: 'auth',
    family: 'plugin-aux',
    method: 'GET',
    path: '/api/orgs/:orgId/plugins/:pluginId/secrets',
    routerPath: '/orgs/:orgId/plugins/:pluginId/secrets',
    plugin: ':pluginId',
    gate: 'requirePluginEntitlement',
    seeds: ['org', 'active member'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
  },
  {
    id: 'auth.plugin.secrets.put',
    service: 'auth',
    family: 'plugin-aux',
    method: 'PUT',
    path: '/api/orgs/:orgId/plugins/:pluginId/secrets/:name',
    routerPath: '/orgs/:orgId/plugins/:pluginId/secrets/:name',
    plugin: ':pluginId',
    gate: 'requirePluginEntitlement',
    seeds: ['org', 'org admin'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
  },
  {
    id: 'auth.plugin.secrets.reveal',
    service: 'auth',
    family: 'plugin-aux',
    method: 'POST',
    path: '/api/orgs/:orgId/plugins/:pluginId/secrets/:name/reveal',
    routerPath: '/orgs/:orgId/plugins/:pluginId/secrets/:name/reveal',
    plugin: ':pluginId',
    gate: 'requirePluginEntitlement',
    seeds: ['org', 'active member', 'stored secret'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
    note: 'Plaintext egress. The single most expensive row in this table to get wrong.',
  },
  {
    id: 'auth.plugin.secrets.delete',
    service: 'auth',
    family: 'plugin-aux',
    method: 'DELETE',
    path: '/api/orgs/:orgId/plugins/:pluginId/secrets/:name',
    routerPath: '/orgs/:orgId/plugins/:pluginId/secrets/:name',
    plugin: ':pluginId',
    gate: 'requirePluginEntitlement',
    seeds: ['org', 'org admin'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
  },

  // ── auth: the INSTALL plane (LL-6b signature policy, LL-6d entitlement) ──
  //
  // LICENSE-LAUNCH LL-6d closed the carve-out these rows used to sit in. It
  // rested on "the row is inert without an entitlement", which was only ever
  // true for a caller who has to ASK the server for bytes. Install and migrate
  // callers supply their own, so both mint a live plugin for an unlicensed org.
  // All three rows are 402 rows now; signature policy still applies on top.
  {
    id: 'auth.plugin.install',
    service: 'auth',
    family: 'plugin-install',
    method: 'POST',
    path: '/api/orgs/:orgId/plugins',
    routerPath: '/orgs/:orgId/plugins',
    plugin: ':pluginId (from the posted manifest)',
    gate: 'requireBundleEntitlement + enforceSignaturePolicy',
    seeds: ['org', 'org admin'],
    expect: {
      unentitled: { status: 402, error: 'LICENSE_REQUIRED' },
      unauthenticated: 401,
    },
    note: 'LICENSE-LAUNCH LL-6d: the exact twin of the migrate hole below, one route up, '
      + 'and it was left open when LL-7 closed migrate. An admin of an unentitled org could '
      + 'POST a governed manifest plus the bundle its own browser had cached and get a 201. '
      + 'The row put the plugin back in /me/plugins, spared the cached bytes from the '
      + "client's entitlement sweep, and let it activate without ever requesting /bundle, so "
      + 'the 402 on distribution was never reached.',
  },
  {
    id: 'auth.plugin.upgrade',
    service: 'auth',
    family: 'plugin-install',
    method: 'PATCH',
    path: '/api/orgs/:orgId/plugins/:pluginId',
    routerPath: '/orgs/:orgId/plugins/:pluginId',
    plugin: ':pluginId',
    gate: 'requireBundleEntitlement (upgrade branch) + enforceSignaturePolicy',
    seeds: ['org', 'org admin', 'existing plugin_install'],
    expect: {
      unentitled: { status: 402, error: 'LICENSE_REQUIRED' },
      unauthenticated: 401,
    },
    note: 'LICENSE-LAUNCH LL-6d gated the UPGRADE branch. Upgrade cannot mint a row (it '
      + '404s without one), so it is not the resurrection shape migrate and install are, but '
      + 'an org with no licence has no business rewriting the governed code its members run. '
      + 'Gated inside the upgrade branch only: the is_enabled toggle on this same route and '
      + 'DELETE uninstall stay open, so a lapsed admin can always disable or remove. Gating '
      + 'those would be a lockout, not enforcement.',
  },
  {
    id: 'auth.plugin.migrate',
    service: 'auth',
    family: 'plugin-install',
    method: 'POST',
    path: '/api/orgs/:orgId/plugins/migrate',
    routerPath: '/orgs/:orgId/plugins/migrate',
    plugin: ':pluginId (from the posted manifest)',
    gate: 'requireBundleEntitlement + enforceSignaturePolicy',
    seeds: ['org', 'org admin'],
    expect: {
      unentitled: { status: 402, error: 'LICENSE_REQUIRED' },
      unauthenticated: 401,
    },
    note: 'LICENSE-LAUNCH LL-7 moved this row OUT of the install-plane carve-out it '
      + 'shared with auth.plugin.upgrade. That carve-out is only safe while the row it '
      + 'writes is INERT, and this row is not: migrate mints an install from bytes the '
      + 'CALLER already holds, and the dashboard re-POSTs its IndexedDB cache here on '
      + 'boot. An admin whose licence had lapsed therefore re-created the row on the next '
      + 'page load, which put the plugin back in /me/plugins, spared the client cache from '
      + 'the entitlement sweep, and let it activate from cache without ever requesting '
      + '/bundle. LL-6d then found POST /plugins doing the identical thing and gated it too, '
      + 'along with the upgrade branch, so the install plane no longer holds a carve-out.',
  },

  // ── collector: plugin storage (LL-1b) ────────────────────────────────────
  {
    id: 'collector.plugin.storage.get',
    service: 'collector',
    family: 'plugin-storage',
    method: 'GET',
    path: '/api/v1/plugins/:pluginId/storage/:key',
    routerPath: '/api/v1/plugins/:pluginId/storage/:key',
    plugin: ':pluginId',
    gate: 'requirePluginStorageOrg',
    seeds: ['user token carrying org_id'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
    note: 'Registered BEFORE the catch-all proxy, so it never crossed the proxy gate. That is the whole reason this manifest exists.',
  },
  {
    id: 'collector.plugin.storage.put',
    service: 'collector',
    family: 'plugin-storage',
    method: 'PUT',
    path: '/api/v1/plugins/:pluginId/storage/:key',
    routerPath: '/api/v1/plugins/:pluginId/storage/:key',
    plugin: ':pluginId',
    gate: 'requirePluginStorageOrg',
    seeds: ['user token carrying org_id'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
  },
  {
    id: 'collector.plugin.storage.delete',
    service: 'collector',
    family: 'plugin-storage',
    method: 'DELETE',
    path: '/api/v1/plugins/:pluginId/storage/:key',
    routerPath: '/api/v1/plugins/:pluginId/storage/:key',
    plugin: ':pluginId',
    gate: 'requirePluginStorageOrg',
    seeds: ['user token carrying org_id'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
  },
  {
    id: 'collector.plugin.storage.list',
    service: 'collector',
    family: 'plugin-storage',
    method: 'GET',
    path: '/api/v1/plugins/:pluginId/storage',
    routerPath: '/api/v1/plugins/:pluginId/storage',
    plugin: ':pluginId',
    gate: 'requirePluginStorageOrg',
    seeds: ['user token carrying org_id'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
  },

  // ── collector: plugin backend proxy (LE-3f + LL-6b) ──────────────────────
  {
    id: 'collector.plugin.backendProxy',
    service: 'collector',
    family: 'plugin-backend-proxy',
    method: 'ALL',
    path: '/api/v1/plugins/:pluginId/*',
    routerPath: '/api/v1/plugins/:pluginId/*',
    plugin: ':pluginId',
    gate: 'proxyToPlugin (and the route-level check in server.js)',
    seeds: ['a registered plugin backend', 'user token carrying org_id'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
    note: 'The one gate that covers EVERY backend-shaped plugin at once, which is why a '
      + 'backend plugin does not need its own row. Route modules mounted outside this '
      + 'prefix do not get that protection — see ACKNOWLEDGED_UNGATED_FAMILIES.',
  },

  // ── collector: plugin-native route modules (LL-6d) ───────────────────────
  //
  // Four governed products ship their own collector route module mounted
  // OUTSIDE the /api/v1/plugins prefix, so the LE-3f catch-all proxy never sees
  // them. LL-6c catalogued all four as ACKNOWLEDGED_UNGATED_FAMILIES; LL-6d
  // gates them with the shared lib/requirePluginEntitlement.js middleware at
  // their server.js mount points (same 402 body as the proxy) and moves them
  // here as driven rows. The driver lives in
  // test/premiumRouteCoverage.test.js, which exercises the REAL middleware and
  // then source-asserts each mount wires it.
  ...[
    ['discordPro', 'discord-pro', '/api/discord-pro/*', 'Status/binding proxy for the Discord Pro daemon (separate repo). Was auth-only.'],
    ['github', 'github', '/github/*', 'Proxies the customer\'s own GitHub token — spends nothing of ours, but a governed catalogue product served with no entitlement check. Internal reuse (securityReportActions) goes through the exported getGitHubToken/ghFetch, not this router, so it is unaffected.'],
    ['quoxbox', 'quoxbox-macmini', '/api/quoxbox/*', 'Proxy to a customer-owned QuoxBox Mac-mini gateway. quoxbox-macmini is a stripped first-party plugin (LL-7i1): an ENTITLED org resolves once provisioned and passes, an unentitled one 402s.'],
    ['quoxlens', 'quoxlens', '/api/v1/lens/*', 'QuoxLens data plane (findings/apply). LE-5 already gated this mount with a prose 403; LL-6d normalises it to the 402 LICENSE_REQUIRED contract every other collector surface uses.'],
  ].map(([suffix, plugin, routerPath, note]) => ({
    id: `collector.${suffix}.proxy`,
    service: 'collector',
    family: 'plugin-native-proxy',
    method: 'ALL',
    path: routerPath,
    routerPath,
    plugin,
    gate: 'requirePluginEntitlement (at the server.js mount, after requireServiceOrUserAuth)',
    seeds: ['user token carrying org_id'],
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
    note,
  })),

  // ── collector: QuoxChat (LL-6a + LL-6c) ──────────────────────────────────
  // Driven by test/quoxchat-license-route-coverage.test.js, which owns the
  // request-building for this family.
  ...[
    ['knowledge.crawl', 'POST', '/knowledge/crawl', 'crawl a site into the KB (embedding spend)'],
    ['knowledge.upload', 'POST', '/knowledge/upload', 'upload documents into the KB (embedding spend)'],
    ['knowledge.qa', 'POST', '/knowledge/qa', 'add a Q&A pair (embedding spend)'],
    ['knowledge.search', 'POST', '/knowledge/search', 'query the KB (embedding spend)'],
    ['teach.propose', 'POST', '/teach/propose', 'ask the teacher for a proposal (LLM spend)'],
    ['simulate', 'POST', '/simulate', 'run scenarios against the widget (LLM spend)'],
    ['knowledge.sources.list', 'GET', '/knowledge/sources', 'enumerate corpus rows (no spend, LL-6c)'],
    ['knowledge.sources.delete', 'DELETE', '/knowledge/sources/:sourceId', 'destroy corpus rows and their vectors (no spend, LL-6c)'],
    ['knowledge.sources.supersede', 'PATCH', '/knowledge/sources/:sourceId', 'mark a corpus row reference-only (no spend)'],
    ['knowledge.reconcile', 'POST', '/knowledge/reconcile', 'classify and prune unmanaged vectors (no spend)'],
  ].map(([suffix, method, routerPath, note]) => ({
    id: `collector.quoxchat.${suffix}`,
    service: 'collector',
    family: 'quoxchat',
    method,
    path: `/quoxchat${routerPath}`,
    routerPath,
    plugin: 'quoxchat',
    gate: 'licenseGuardAdmin',
    seeds: ['service key', 'a widget whose org is resolvable via auth /meta'],
    // Service-key gated, so an unauthenticated caller gets requireServiceKey's
    // 401 before licensing is consulted at all.
    expect: { unentitled: { status: 402, error: 'LICENSE_REQUIRED' }, unauthenticated: 401 },
    note,
  })),
  {
    id: 'collector.quoxchat.message',
    service: 'collector',
    family: 'quoxchat',
    method: 'POST',
    path: '/quoxchat/message',
    routerPath: '/message',
    plugin: 'quoxchat',
    gate: 'licenseGuard',
    seeds: ['a widget whose org is resolvable via auth /meta'],
    expect: {
      // The visitor-facing gate: same 402 + LICENSE_REQUIRED, but prose in
      // `message` rather than a machine-readable `plugin`, because a website
      // visitor sees this body. Drivers must not assert `plugin` on this row.
      unentitled: { status: 402, error: 'LICENSE_REQUIRED', visitorFacing: true },
      unauthenticated: null,
    },
    note: 'The original gate, and for a long time the only one. Public: no service key.',
  },
];

// ── Route-table completeness (guard A) ──────────────────────────────────────
//
// The manifest tells you what IS gated. It cannot tell you what is MISSING —
// that is precisely the failure mode every LL-6 unit has been cleaning up. So
// the consuming tests walk the real Express route table of each router named
// below and require every route on it to be either (a) a manifest row or (b)
// listed here with a reason. A route added to a covered router and left out of
// both turns the suite red.
//
// Heuristic, stated plainly: this covers ROUTERS, not services. A premium route
// bolted into services/collector/server.js outside the /api/v1/plugins prefix,
// or onto a router not listed in COVERED_ROUTERS, is invisible to guard A.
// Guard B below is the partial answer to that; between them they cover the
// shapes every LL-6 hole so far has actually taken.
const COVERED_ROUTERS = [
  { service: 'auth', module: 'routes/plugins.js', mount: '/api' },
  { service: 'collector', module: 'routes/quoxchat.js (the spend-surface prefixes only)', mount: '/quoxchat' },
  { service: 'collector', module: 'server.js (the /api/v1/plugins prefix only)', mount: '' },
];

// routes/quoxchat.js carries far more than the licensed surface: the visitor
// transport, conversation polling, widget config, Matrix relay hooks. Guard A
// on that router is therefore scoped to the SPEND SURFACE — the prefixes an
// operator drives to make the product do paid work. Every route under one of
// these must be a manifest row.
//
// `/internal/*` is deliberately NOT in the list and never should be: it is the
// service-to-service plane (INTERNAL_SERVICE_KEY only, inside the trust
// boundary), and it is gated by that key rather than by an entitlement, the
// same carve-out the plugin storage and proxy gates make for req.service.
const QUOXCHAT_GOVERNED_PREFIXES = ['/knowledge', '/teach', '/simulate', '/message'];

// method + routerPath, exactly as the route-table guard renders them.
const ROUTES_NOT_LICENCE_GOVERNED = [
  // auth routes/plugins.js
  { key: 'GET /orgs/:orgId/plugins', why: 'Lists what is installed. Metadata only, no blob, no plugin data. An org must be able to see its own install rows to know what to license.' },
  { key: 'GET /orgs/:orgId/plugins/:pluginId', why: 'Same: one install row, metadata only, explicitly no blob.' },
  { key: 'DELETE /orgs/:orgId/plugins/:pluginId', why: 'Uninstall. Refusing to let an unlicensed org REMOVE a plugin would be gating the wrong direction.' },
  { key: 'GET /orgs/:orgId/plugins/:pluginId/assignments', why: 'Visibility administration, not use. Reads no plugin data and serves no bytes.' },
  { key: 'POST /orgs/:orgId/plugins/:pluginId/assignments', why: 'As above.' },
  { key: 'DELETE /orgs/:orgId/plugins/:pluginId/assignments/:assigneeType/:assigneeId?', why: 'As above.' },
  { key: 'GET /orgs/:orgId/me/plugins', why: 'Tells the caller which plugins are visible to them. It must remain readable or the dashboard cannot render the locked state.' },
  { key: 'GET /orgs/:orgId/trusted-keys', why: 'Org signing-key administration. Governs WHO may publish plugins here, not which plugins this org may run.' },
  { key: 'POST /orgs/:orgId/trusted-keys', why: 'As above.' },
  { key: 'DELETE /orgs/:orgId/trusted-keys/:keyId', why: 'As above.' },
];

// ── Catalogue-family completeness (guard B) ─────────────────────────────────
//
// Guard A cannot see a NEW router. Guard B is the cheap heuristic that can:
//
//   A governed catalogue id "gains a route family" when a dedicated collector
//   route module appears for it — services/collector/routes/<id>.js — because
//   that is how every collector-native plugin surface in this repo has actually
//   been added. The filename is mapped to a catalogue id by exact match, then
//   by the alias table below for the two modules whose filename carries a
//   `-proxy` suffix or a different product name.
//
// Every governed id with such a module must appear as a row's `plugin` in the
// manifest, or be listed in ACKNOWLEDGED_UNGATED_FAMILIES with a reason. Adding
// services/collector/routes/<new-governed-id>.js and gating nothing fails the
// guard, which is the point.
//
// Known blind spots, stated rather than hidden: the heuristic does not see a
// surface added to server.js directly, one mounted from a module whose name
// does not resemble its catalogue id, or one living in the auth service. It is
// a tripwire on the commonest path, not a proof of total coverage.
const ROUTE_MODULE_ID_ALIASES = {
  'quoxbox-proxy': 'quoxbox-macmini',
  'github-proxy': 'github',
};

// Governed ids that ship a collector route module and are NOT entitlement
// gated today. These are ACKNOWLEDGED, not blessed: each is a real gap with a
// named owner unit. The guard's job is to keep them visible and to stop the
// list growing silently.
//
// LL-6d emptied this list: the four families it held (discord-pro, github,
// quoxbox-macmini, quoxlens) are now driven rows in the plugin-native-proxy
// family above, gated at their server.js mounts by
// lib/requirePluginEntitlement.js. A future ungated collector route module for
// a governed id belongs here (with a why + followUp) OR as a driven row — the
// guard fails until it is one or the other.
const ACKNOWLEDGED_UNGATED_FAMILIES = [];

// ── The fail-open five (owner ruling PENDING) ───────────────────────────────
//
// Originally five plugin ids that the dashboard offers but lib/entitlements.js
// did not govern. hasPlugin() returns TRUE for an ungoverned id by design —
// that is how custom org uploads keep working — so these were entitlement-free
// on every gate in this manifest simultaneously.
//
// LICENSE-LAUNCH LL-5, owner ruling 2026-08-29 ("ALL PAID"): quox-security,
// chief-team-small, chief-team-medium and chief-team-enterprise are ruled paid
// and now governed (lib/entitlements.js GOVERNED_PLUGIN_IDS) — their rows are
// deleted here per the instruction at the top of
// tests/premium-fail-open-pending-ruling.test.js. `comms` is a separate,
// still-pending gap (free tier; not part of the LL-5 ruling) and stays.
const FAIL_OPEN_PENDING_RULING = [
  { plugin: 'comms', tier: 'free', price: 0, note: 'Free tier, so nothing is being given away, but it is offered ungoverned while core-comms IS governed. Worth a ruling if only for the confusing pair of ids.' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function rowsFor(filter = {}) {
  return PREMIUM_ROUTES.filter((r) =>
    Object.entries(filter).every(([k, v]) => r[k] === v));
}

function rowById(id) {
  const row = PREMIUM_ROUTES.find((r) => r.id === id);
  if (!row) throw new Error(`premiumRouteManifest: no row with id ${id}`);
  return row;
}

/**
 * Every row in `rows` must have a driver, and every driver must name a real
 * row. Both directions matter: the first stops a row being added here and
 * never exercised; the second stops a driver drifting onto a row that no
 * longer exists and passing vacuously.
 *
 * @param {Array<object>} rows      the manifest rows this suite owns
 * @param {Iterable<string>} driverIds  the ids the suite actually drives
 * @returns {{ missing: string[], unknown: string[] }}
 */
function diffDrivers(rows, driverIds) {
  const want = new Set(rows.map((r) => r.id));
  const have = new Set(driverIds);
  return {
    missing: [...want].filter((id) => !have.has(id)),
    unknown: [...have].filter((id) => !want.has(id)),
  };
}

/**
 * Guard A. Given a real route table (services/shared/routeIntrospection.cjs
 * listRoutes() output) for ONE covered router, return the routes that are
 * neither a manifest row nor an acknowledged non-governed route.
 *
 * @param {Array<{method: string, path: string}>} routeTable
 * @param {object[]} rows  manifest rows for that router
 */
function uncoveredRoutes(routeTable, rows) {
  const known = new Set([
    ...rows.map((r) => `${r.method} ${r.routerPath}`),
    ...ROUTES_NOT_LICENCE_GOVERNED.map((r) => r.key),
  ]);
  return routeTable
    .map((r) => `${r.method.toUpperCase()} ${r.path}`)
    .filter((key) => !known.has(key));
}

module.exports = {
  PREMIUM_ROUTES,
  COVERED_ROUTERS,
  QUOXCHAT_GOVERNED_PREFIXES,
  ROUTES_NOT_LICENCE_GOVERNED,
  ROUTE_MODULE_ID_ALIASES,
  ACKNOWLEDGED_UNGATED_FAMILIES,
  FAIL_OPEN_PENDING_RULING,
  rowsFor,
  rowById,
  diffDrivers,
  uncoveredRoutes,
};
