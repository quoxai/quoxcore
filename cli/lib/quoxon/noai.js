/**
 * Z2H-R2B: what Quox does when NO AI provider is connected. A turn is answered locally (no server call),
 * with a full friendly card; nothing here names one vendor as the default. "add a host" has a deterministic
 * path that needs no AI.
 */
import { CHOICES } from './model.js';
import { providerState } from './providers.js';

export const NO_AI_STATUS = 'no AI connected';
export const NO_AI_CARD = [
  'No AI is connected yet. Pick one:',
  '/connect openai (recommended), /connect anthropic, /connect ollama <host>, or /connect for the list.'
];
export const HOSTS_USAGE = '/hosts add';

/** -> true when at least one provider is connected, false when readable and none is, null when nothing could be read. */
export function anyProviderConnected(vault, caps) {
  let known = false;
  for (const c of CHOICES) {
    const st = providerState({ cap: c.cap || c.id, vault: c.vault }, caps, vault).state;
    if (st === 'connected') return true;
    if (st !== 'unknown') known = true;
  }
  return known ? false : null;
}

export const asksAddHost = (text) => /^\s*(?:please\s+)?(?:(?:i\s+(?:want|need)\s+to|can\s+you|help\s+me|let'?s)\s+)?(?:add|connect|enrol+|enroll|register|onboard)\s+(?:a|my|another|the)?\s*(?:new\s+)?(?:host|server|machine|node|box)s?\b/i.test(String(text || '').replace(/[.?!]+\s*$/, ''));

/** Z2H-R4: "watch my servers" and friends; watching starts with adding a host, which needs no AI. */
export const asksWatchHosts = (text) => /^\s*(?:please\s+)?(?:(?:i\s+(?:want|need)\s+(?:you\s+)?to|can\s+you|help\s+me)\s+)?(?:watch|monitor|keep\s+an\s+eye\s+on|look\s+after|keep\s+watch\s+(?:on|over))\s+(?:my|our|the)\s+(?:\w+\s+)?(?:servers?|hosts?|machines?|nodes?|boxes|fleet|homelab|infrastructure|infra)\b/i.test(String(text || '').replace(/[.?!]+\s*$/, ''));

/**
 * The deterministic add-a-host lines. `base` = the server URL when known. `check` = the result of probing
 * `${base}/install` ({ ok, status }) or null when it could not be read. Z2H-3c: a public install answered 503
 * there (no QuoxAgent bundled), so the curl line we printed failed on the user's host; a failed probe now says
 * so plainly instead of handing out a command that cannot work. Unreadable (null) keeps the old lines.
 */
export function addHostLines(base, check = null) {
  const b = String(base || '').replace(/\/+$/, '') || '<your-quox-url>';
  if (check && check.ok === false && Number(check.status) >= 400) {
    return [
      `This Quox cannot enrol hosts yet: its host installer is not available (${b}/install answered HTTP ${check.status}).`,
      'The QuoxAgent installer is not bundled in this install, so the add-a-host command would fail on your machine.',
      'Nothing was changed on either machine.'
    ];
  }
  return [
    'To add a host, no AI needed. On the machine you want to add, run:',
    // REL-423: never `curl | sudo bash`: that pipe exits 0 when the download fails (TLS error, HTTP error) and runs
    // whatever partial body arrived. Download to a temp file with curl -f, then run it, so a failure stops loudly.
    // Two lines (shell continuation) so the TUI, which clips long lines, never cuts the command short.
    `( f=$(mktemp) && trap 'rm -f "$f"' EXIT && curl -fsSL ${b}/install -o "$f" && \\`,
    `  sudo bash "$f" --host-id <name> )`,
    'Then check it arrived with: quox fleet hosts'
  ];
}
