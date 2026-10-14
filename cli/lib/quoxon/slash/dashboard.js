/**
 * /dashboard [page] and `quox dashboard [page]`: a one-time sign-in link to the web dashboard.
 *
 * The link comes from POST /api/auth/login-link (10 minutes, single use, bound to this user and org) and is
 * joined to the active profile's dashboard URL. It is a credential: callers print it on the visible line only,
 * never into the dev transcript or any history. Opened in the default browser when running locally; never over
 * SSH (the browser would open on the wrong machine), where it is only printed.
 *
 * `next` asks the consume route to land on the page after sign-in. A server that does not know `next` lands
 * on the dashboard home instead; nothing breaks.
 */
import { spawn as nodeSpawn } from 'node:child_process';

/** Page name -> real route in src/config/routeRegistry.js (approvals = the HITL /inbox, inbox = InboxQ mail). */
export const PAGES = {
  sessions: '/sessions',
  approvals: '/inbox',
  agents: '/agents',
  lucid: '/lucid',
  inbox: '/inboxq',
  seo: '/quoxseo',
  settings: '/settings'
};

export function resolvePage(arg) {
  const name = String(arg ?? '').trim().toLowerCase();
  if (!name) return { ok: true, page: null, path: '/' };
  if (Object.hasOwn(PAGES, name)) return { ok: true, page: name, path: PAGES[name] };
  return { ok: false, error: `Unknown page "${name}". Pages: ${Object.keys(PAGES).join(', ')}.` };
}

export const isRemoteSession = (env = process.env) => Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);

export function openerFor(platform = process.platform) {
  if (platform === 'linux') return { cmd: 'xdg-open', args: [] };
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler'] }; // no shell, so & in the URL is safe
  return null;
}

/** -> { opened: true } | { opened: false, reason: 'ssh' | 'no-opener' | 'failed' }. Never throws, never uses a shell. */
export function openInBrowser(url, { env = process.env, platform = process.platform, spawn = nodeSpawn } = {}) {
  if (isRemoteSession(env)) return Promise.resolve({ opened: false, reason: 'ssh' });
  const op = openerFor(platform);
  if (!op) return Promise.resolve({ opened: false, reason: 'no-opener' });
  return new Promise((resolve) => {
    let done = false;
    const fin = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const child = spawn(op.cmd, [...op.args, url], { stdio: 'ignore', detached: true });
      child.on('error', () => fin({ opened: false, reason: 'failed' }));
      child.unref?.();
      setTimeout(() => fin({ opened: true }), 150); // an error (opener missing) arrives well inside this
    } catch { fin({ opened: false, reason: 'failed' }); }
  });
}

const missing = (e) => e?.status === 404 || e?.status === 405 || e?.status === 501;
const join = (base, path) => new URL(path, base).href;
const isLoopbackUrl = (u) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(new URL(u).hostname);

/**
 * mint: async () -> { path, expires_at, ttl_seconds } (POST /api/auth/login-link).
 * -> { kind: 'link' | 'plain' | 'error', url, plainUrl, page, remote, opened, openFailed, ttlSeconds, expiresAt, error }
 */
export async function runDashboard({ page, mint, baseUrl, env = process.env, open = (u) => openInBrowser(u, { env }) } = {}) {
  const p = resolvePage(page);
  if (!p.ok) return { kind: 'error', error: p.error };
  const remote = isRemoteSession(env);
  let plainUrl = null;
  try { plainUrl = join(baseUrl, p.path); } catch { /* no profile URL: the server may still give one */ }
  const base = { page: p.page, plainUrl, remote };
  const noUrl = 'This profile has no dashboard URL. Set one with: quox config set url <https://host:3000>';
  let r;
  try { r = await mint(); } catch (e) {
    if (missing(e)) return plainUrl ? { ...base, kind: 'plain', url: plainUrl } : { kind: 'error', error: noUrl };
    const why = e?.status ? `${e.message || 'refused'} (HTTP ${e.status})` : (e?.message || 'failed');
    return { ...base, kind: 'error', url: plainUrl, error: `Could not create a sign-in link: ${why}` };
  }
  if (!r?.path || !/^\/api\/auth\/login-link\/consume\?t=[\w-]+$/.test(r.path)) {
    return { ...base, kind: 'error', url: plainUrl, error: 'Could not create a sign-in link: unexpected answer from the auth service.' };
  }
  // The server knows the public address of the instance; the profile URL may be localhost on this box.
  let origin = null;
  if (typeof r.url === 'string') {
    try {
      const u = new URL(r.url);
      if (/^https?:$/.test(u.protocol) && r.url === u.origin + r.path) origin = u.origin;
    } catch { /* ignore a malformed server url */ }
  }
  let linkBase = origin || baseUrl;
  let local = false;
  if (!origin) {
    try { local = isLoopbackUrl(join(baseUrl, '/')); } catch { /* handled below */ }
  }
  let link;
  try { link = join(linkBase, r.path); } catch { return { kind: 'error', error: noUrl }; }
  const url = link + (p.page ? `&next=${encodeURIComponent(p.path)}` : '');
  if (origin) base.plainUrl = join(origin, p.path);
  const out = { ...base, kind: 'link', url, localOnly: local, ttlSeconds: r.ttl_seconds ?? 600, expiresAt: r.expires_at, opened: false };
  if (!remote) {
    const o = await open(url).catch(() => ({ opened: false, reason: 'failed' }));
    out.opened = Boolean(o?.opened);
    out.openFailed = !o?.opened;
  }
  return out;
}

const osc8 = (url, text) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

/** Result -> [{ text, tone }] for the visible lines. The link line is the only place the credential is printed. */
export function dashboardLines(r, { hyperlinks = false } = {}) {
  const where = r.page ? `the ${r.page} page` : 'the dashboard';
  if (r.kind === 'error') {
    return [
      { text: r.error, tone: 'warn' },
      ...(r.url ? [{ text: `The dashboard is at ${r.url} (you will need to sign in).`, tone: 'dim' }] : [])
    ];
  }
  if (r.kind === 'plain') {
    return [
      { text: `This server does not offer one-time sign-in links (an older server). Open ${where} here and sign in:`, tone: 'warn' },
      { text: r.url }
    ];
  }
  const mins = Math.round((r.ttlSeconds || 600) / 60);
  return [
    { text: r.opened ? `Opened ${where} in your browser, already signed in.` : `Sign-in link for ${where}:` },
    ...(hyperlinks ? [{ text: osc8(r.url, `Open ${where} (signed in)`) }] : []),
    { text: r.url },
    { text: `Valid for ${mins} minutes, works once, tied to your account. Anyone holding it can sign in as you until then.`, tone: 'dim' },
    ...(r.localOnly ? [{ text: 'This address only works on this machine; set the app URL with `quox server config app-url <url>` or in Settings > General > App URL.', tone: 'dim' }] : []),
    ...(r.remote ? [{ text: 'Over SSH, so it was not opened here: open it in a browser on your own machine.', tone: 'dim' }] : []),
    ...(r.openFailed ? [{ text: 'Could not open a browser from here: use the link above.', tone: 'warn' }] : [])
  ];
}
