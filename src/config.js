// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { POLL_INTERVAL } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULT_CONFIG = Object.freeze({
  url: '',
  username: '',
  poll_interval: POLL_INTERVAL.default,
  allow_app_stop: false,
});

/** Control characters (CR, LF...) are refused in every value sent to CasaOS. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const text = (value) => (typeof value === 'string' ? value.trim() : '');
/** Only a real "on" turns an option on (a string "false" stays off). */
const on = (raw) => raw === true || raw === 'true';

/**
 * The address of CasaOS: `http://host[:port]` (port 80 without one), a bare
 * `host[:port]` read as http, or `https://host[:port]` behind a reverse proxy
 * with a certificate of a known authority. No path, no credentials, no query.
 *   -> { base, protocol, host, port, id } | { error: 'empty' | 'invalid' | 'credentials' }
 */
export function parseAddress(value) {
  const raw = text(value);
  if (!raw) return { error: 'empty' };
  if (CONTROL.test(raw)) return { error: 'invalid' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    return { error: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'invalid' };
  if (url.username || url.password) return { error: 'credentials' };
  if (url.search || url.hash || !url.hostname) return { error: 'invalid' };
  if (url.pathname !== '/' && url.pathname !== '') return { error: 'invalid' };
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (
    host === '0.0.0.0' ||
    host === '::' ||
    host === '255.255.255.255' ||
    /^(22[4-9]|23\d)\./.test(host) ||
    /^ff[0-9a-f]{2}:/i.test(host)
  ) {
    return { error: 'invalid' };
  }
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  if (!(port > 0 && port < 65536)) return { error: 'invalid' };
  const shown = host.includes(':') ? `[${host}]` : host;
  return {
    base: `${url.protocol}//${shown}:${port}`,
    protocol: url.protocol,
    host,
    port,
    id: addressId(host, port),
  };
}

/** The platform id of the server device: its host and port (`192-168-1-20-80`). */
export const addressId = (host, port) =>
  `${String(host)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)}-${port}`;

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const address = parseAddress(raw.url);
  const username = text(raw.username);
  // A password is sent as typed (spaces included), never trimmed.
  const password = typeof raw.password === 'string' ? raw.password : '';
  let credentialsError = null;
  if (!username && !password) credentialsError = 'missing';
  else if (!username) credentialsError = 'username';
  else if (!password) credentialsError = 'password';
  else if (
    CONTROL.test(username) ||
    CONTROL.test(password) ||
    username.length > 64 ||
    Buffer.byteLength(password) > 256
  ) {
    credentialsError = 'invalid';
  }
  const poll = Number(raw.poll_interval);
  const pollSeconds =
    Number.isInteger(poll) && poll >= POLL_INTERVAL.min && poll <= POLL_INTERVAL.max
      ? poll
      : POLL_INTERVAL.default;
  return {
    address: address.error ? null : address,
    addressError: address.error ?? null,
    username,
    password,
    credentialsError,
    pollMs: pollSeconds * 1000,
    allowStop: on(raw.allow_app_stop),
  };
}

/** The values a session is about: another one logs in again. */
export const sameAccount = (a, b) =>
  Boolean(a?.address && b?.address) &&
  a.address.base === b.address.base &&
  a.username === b.username &&
  a.password === b.password;
