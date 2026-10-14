/**
 * Signed-out handling for the TUI (QUOXON-Z2H): one clear card instead of scattered errors, and an in-TUI
 * /login that uses the same login path as `quox login` (createAuth().login + verifyMfa). The password lives
 * only in a secret box (closure): never dispatched, logged, put in history or saved. Only the email is kept
 * (profile.last_email) so the next sign-in can prefill it.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { createSecretBox } from './connect.js';
import { c, clip } from './theme.js';
import { Rule } from './render.js';

const h = React.createElement;

/** The one-line answer to anything that needs a session while signed out. */
export const SIGNED_OUT_LINE = 'Signed out. /login to sign in again';

/** A definitive "this session is over" failure (not a transient hiccup, not a 401 from some other route). */
export function isSessionDead(e) {
  if (!e || e.transient) return false;
  if (e.code === 'session_expired') return true;
  return /session expired|No refresh token|please login again|no authentication token|valid jwt or service key|not signed in/i.test(e.message || '');
}

const WHY = {
  idle_timeout: 'you were idle for longer than the idle limit',
  max_session: 'it reached its maximum length'
};

/** The card text. reason = idle_timeout | max_session from the server's refresh response, else neutral. */
export function signedOutCard(profile, reason) {
  const why = WHY[reason];
  return [
    `You're signed out of ${profile} (CLI sign-ins last 30 days, set by your Quox server's session policy, unless your admin set a shorter limit).`,
    ...(why ? [`This session ended because ${why}.`] : []),
    'Sign in again: /login'
  ].join(' ');
}

/** Controller for the /login card. onSignedIn() runs after a successful sign-in so the app can refresh. */
export function createLoginController({ api, note, refresh, onSignedIn }) {
  const pw = createSecretBox();
  let card = null; let busy = false; let tokenForMfa = null;
  const close = () => { pw.clear(); tokenForMfa = null; card = null; refresh(); };
  async function submitCreds() {
    busy = true; card.phase = 'working'; card.error = null; refresh();
    let r;
    try { r = await api.signIn(card.email.trim(), pw.take()); }
    catch (e) { busy = false; if (!card) return; card.phase = 'password'; card.error = (e?.message || 'Sign in failed').replace(/\s+/g, ' '); refresh(); return; }
    busy = false;
    if (!card) return;
    if (r?.mfa_required) { tokenForMfa = r.access_token; card.phase = 'mfa'; card.mfa = ''; refresh(); return; }
    done(r);
  }
  async function submitMfa() {
    busy = true; const code = card.mfa.trim(); card.phase = 'working'; refresh();
    try { await api.verifyMfa(tokenForMfa, code); }
    catch (e) { busy = false; if (!card) return; card.phase = 'mfa'; card.mfa = ''; card.error = (e?.message || 'MFA failed').replace(/\s+/g, ' '); refresh(); return; }
    busy = false;
    done({});
  }
  function done(r) {
    const who = r?.user?.email || card.email.trim();
    close();
    note(`Signed in as ${who}.`, 'ok');
    onSignedIn?.();
  }
  return {
    isOpen: () => Boolean(card),
    view: () => (card ? { card: { ...card }, mask: pw.mask() } : null),
    open() {
      if (!api.signIn) { note('Signing in is not available in this mode. Run: quox login', 'warn'); return false; }
      pw.clear(); tokenForMfa = null;
      const email = (api.lastEmail?.() || '').trim();
      card = { phase: email ? 'password' : 'email', email, mfa: '', error: null };
      refresh();
      return true;
    },
    onEvent(e) {
      if (!card) return false;
      if (card.phase === 'working' || busy) return true;
      const ph = card.phase;
      if (e.type === 'paste' || e.type === 'text') {
        const t = String(e.text || '').replace(/[\x00-\x1f\x7f]+/g, '');
        if (ph === 'password') e.type === 'paste' ? pw.paste(t) : pw.type(t);
        else if (ph === 'email') card.email += t.replace(/\s+/g, '');
        else if (ph === 'mfa') card.mfa += t.replace(/\s+/g, '');
        card.error = null; refresh(); return true;
      }
      if (e.type !== 'key') return true;
      if (e.name === 'escape' || e.name === 'ctrl-c') { close(); note('Cancelled. Nothing was saved.'); return true; }
      if (e.name === 'enter') {
        if (ph === 'email') { if (!card.email.includes('@')) { card.error = 'Enter your email address.'; } else { card.phase = 'password'; card.error = null; } refresh(); }
        else if (ph === 'password') { if (!pw.length()) { card.error = 'Enter your password, or Esc to cancel.'; refresh(); } else submitCreds(); }
        else if (ph === 'mfa') { if (!card.mfa.trim()) { card.error = 'Enter the code from your authenticator app.'; refresh(); } else submitMfa(); }
        return true;
      }
      if (e.name === 'backspace') {
        if (ph === 'password') pw.backspace(); else if (ph === 'email') card.email = card.email.slice(0, -1); else card.mfa = card.mfa.slice(0, -1);
        refresh(); return true;
      }
      if (e.name === 'kill-line' || e.name === 'delete-word') {
        if (ph === 'password') pw.clear(); else if (ph === 'email') card.email = ''; else card.mfa = '';
        refresh(); return true;
      }
      if (e.name === 'tab' && ph === 'password') { card.phase = 'email'; refresh(); return true; }
      return true;
    }
  };
}

/** card: { phase: 'email'|'password'|'mfa'|'working', email, mfa, error }, mask */
export function LoginCard({ card, mask, cols, profile }) {
  const cur = (p) => (card.phase === p ? '▏' : '');
  return h(Box, { flexDirection: 'column', width: cols, marginTop: 1 },
    h(Rule, { cols, color: 'sky' }),
    h(Text, { color: c('sky'), bold: true }, clip(`Ⓠ Sign in to ${profile} · your password goes to the server and is never stored`, cols)),
    h(Text, { color: c('text') }, clip(`  email     ${card.email}${cur('email')}`, cols)),
    card.phase !== 'email' ? h(Text, { color: c('text') }, clip(`  password  ${mask || ''}${cur('password')}`, cols)) : null,
    card.phase === 'mfa' || (card.phase === 'working' && card.mfa) ? h(Text, { color: c('text') }, clip(`  code      ${card.mfa}${cur('mfa')}`, cols)) : null,
    card.error ? h(Text, { color: c('warn') }, clip(`  ${card.error}`, cols)) : null,
    h(Text, { color: c('dim') }, card.phase === 'working'
      ? clip('  ◐ signing in…', cols)
      : clip(`  ${card.phase === 'mfa' ? 'enter your authenticator code' : card.phase === 'email' ? 'type your email' : 'type your password'} · Enter continue · Esc cancel`, cols)),
    h(Rule, { cols, color: 'sky' }));
}
