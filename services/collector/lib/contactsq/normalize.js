'use strict';

/**
 * ContactsQ identifier normalisation. Normalise BEFORE hashing so the same
 * human identifier always yields the same blind index.
 *
 * normalizeIdentifier(channel, value, {region}) ->
 *   { channel, normalised, canonical, network, country }
 * Throws NormalizeError (code 'invalid_value' | 'invalid_channel').
 */

const { parsePhoneNumberFromString, getCountries } = require('libphonenumber-js');

const CHANNELS = ['phone', 'email', 'social', 'url', 'address'];
const COUNTRIES = new Set(getCountries());

class NormalizeError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidRegion(r) { return typeof r === 'string' && COUNTRIES.has(r.toUpperCase()); }

function normalizeEmail(value) {
  const v = String(value).trim().toLowerCase();
  if (!EMAIL_RE.test(v) || v.length > 254) throw new NormalizeError('invalid_value', 'invalid email');
  const at = v.lastIndexOf('@');
  let local = v.slice(0, at);
  let domain = v.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return { normalised: v, canonical: `${local}@${domain}`, network: null, country: null };
}

function normalizePhone(value, region) {
  const p = parsePhoneNumberFromString(String(value).trim(), isValidRegion(region) ? region.toUpperCase() : 'GB');
  if (!p || !p.isValid()) throw new NormalizeError('invalid_value', 'invalid phone number');
  return { normalised: p.number, canonical: p.number, network: null, country: p.country || null };
}

function normalizeSocial(value) {
  const v = String(value).trim().toLowerCase();
  const i = v.indexOf(':');
  if (i < 1) throw new NormalizeError('invalid_value', 'social value must be network:handle');
  const network = v.slice(0, i).trim();
  const handle = v.slice(i + 1).trim().replace(/^@+/, '');
  if (!/^[a-z0-9_.-]{1,32}$/.test(network) || !handle || /\s/.test(handle) || handle.length > 100) {
    throw new NormalizeError('invalid_value', 'invalid social handle');
  }
  const n = `${network}:${handle}`;
  return { normalised: n, canonical: n, network, country: null };
}

function normalizeUrl(value) {
  let u;
  try { u = new URL(String(value).trim()); } catch { throw new NormalizeError('invalid_value', 'invalid url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NormalizeError('invalid_value', 'invalid url');
  u.hash = '';
  const n = u.toString().replace(/\/$/, '').toLowerCase();
  return { normalised: n, canonical: n, network: null, country: null };
}

function normalizeAddress(value) {
  const n = String(value).trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (n.length < 3 || n.length > 500) throw new NormalizeError('invalid_value', 'invalid address');
  return { normalised: n, canonical: n, network: null, country: null };
}

function normalizeIdentifier(channel, value, { region = 'GB' } = {}) {
  if (!CHANNELS.includes(channel)) throw new NormalizeError('invalid_channel');
  if (typeof value !== 'string' || !value.trim()) throw new NormalizeError('invalid_value');
  switch (channel) {
    case 'phone': return { channel, ...normalizePhone(value, region) };
    case 'email': return { channel, ...normalizeEmail(value) };
    case 'social': return { channel, ...normalizeSocial(value) };
    case 'url': return { channel, ...normalizeUrl(value) };
    default: return { channel, ...normalizeAddress(value) };
  }
}

module.exports = { CHANNELS, NormalizeError, normalizeIdentifier, isValidRegion };
