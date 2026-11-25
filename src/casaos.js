// -----------------------------------------------------------------------------
// The HTTP API of CasaOS, as documented in the OpenAPI files of its
// repositories (IceWhaleTech/CasaOS, CasaOS-AppManagement, CasaOS-UserService,
// Apache-2.0): only called, nothing of CasaOS is copied.
//
// Access: POST /v1/users/login gives an access token (3 h) and a refresh token
// (7 days); every other request carries the access token as is in the
// `Authorization` header; POST /v1/users/refresh renews both without the
// password. Tokens and the password are never logged nor put in an error
// message. Redirections are never followed.
//
// One request per connection (`Connection: close`), never a pipeline. The
// connection is opened first; `beforeSend()` runs once it is up, just before
// the first byte of the request, and may throw to cancel it (nothing sent).
// https: the certificate must be valid for the host (a reverse proxy); there
// is no pin and no exception.
// -----------------------------------------------------------------------------

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { LIMITS, TIMINGS } from './constants.js';

export class CasaosError extends Error {
  /**
   * @param {'network'|'timeout'|'tls'|'size'|'format'|'redirect'|'cancelled'|'http'} kind
   * @param {string} message never a token nor a password
   * @param {{ status?: number, sent?: boolean, retryAfter?: number, code?: number }} details
   *   sent: the request was written (it may have been done); status: CasaOS answered;
   *   code: the `success` field of a v1 answer
   */
  constructor(kind, message, { status, sent = false, retryAfter, code } = {}) {
    super(message);
    this.name = 'CasaosError';
    this.kind = kind;
    this.status = status;
    this.sent = sent || status !== undefined;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

const NETWORK = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO|ALTNAME|ERR_SSL|EPROTO/;

const networkError = (err, sent) => {
  if (err instanceof CasaosError) return err;
  const code = String(err?.code ?? '');
  if (TLS_CODES.test(code)) return new CasaosError('tls', 'certificate refused', { sent });
  if (code.startsWith('HPE_')) return new CasaosError('format', 'not HTTP', { sent });
  return new CasaosError('network', NETWORK[code] ?? 'network error', { sent });
};

/** Retry-After (seconds, or an HTTP date compared with the server's Date) -> ms, or undefined. */
export function retryAfterOf(value, serverDate) {
  if (value === undefined || value === null || value === '') return undefined;
  const trimmed = String(value).trim();
  if (/^\d{1,9}(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  const now = Date.parse(String(serverDate ?? ''));
  return Number.isFinite(date) && Number.isFinite(now) ? Math.max(0, date - now) : undefined;
}

/** A connected socket (TLS checked by the system authorities for https). */
function connect({ protocol, host, port, timeout }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const isTls = protocol === 'https:';
    const socket = isTls
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
      : net.connect({ host, port });
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(socket);
      }
    };
    const timer = setTimeout(
      () => finish(new CasaosError('timeout', 'no connection within the delay')),
      timeout,
    );
    socket.once(isTls ? 'secureConnect' : 'connect', () => finish());
    socket.on('error', (err) => finish(networkError(err, false)));
  });
}

/**
 * One request; resolves { status, headers, body } for any status, rejects a
 * CasaosError for a transport failure.
 * @param {{ base: string, protocol: string, host: string, port: number }} address
 * @param {{ method?: string, path: string, token?: string, json?: unknown,
 *   timeout?: number, maxBytes?: number, beforeSend?: () => void }} options
 */
export async function httpRequest(
  address,
  {
    method = 'GET',
    path,
    token,
    json,
    timeout = TIMINGS.readTimeout,
    idleTimeout = TIMINGS.idleTimeout,
    maxBytes = LIMITS.SMALL_BYTES,
    beforeSend,
  },
) {
  const started = performance.now();
  const socket = await connect({
    protocol: address.protocol,
    host: address.host,
    port: address.port,
    timeout: Math.min(timeout, TIMINGS.connectTimeout),
  });
  try {
    beforeSend?.();
  } catch (err) {
    socket.destroy();
    throw err;
  }
  const left = Math.max(1, timeout - (performance.now() - started));
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let idle;
    let req;
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      req?.destroy();
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => settle(new CasaosError('timeout', 'CasaOS stopped answering', { sent })),
        idleTimeout,
      );
    };
    const headers = {
      Accept: 'application/json',
      Connection: 'close',
      Host: address.host.includes(':')
        ? `[${address.host}]:${address.port}`
        : `${address.host}:${address.port}`,
    };
    if (token) headers.Authorization = token;
    let body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const timer = setTimeout(
      () => settle(new CasaosError('timeout', 'no answer within the delay', { sent })),
      left,
    );
    try {
      // No agent: the connection opened above is the one used (never `agent: false`).
      req = http.request({ method, path, headers, createConnection: () => socket });
    } catch {
      // An invalid header value, refused by Node before any byte is written.
      settle(new CasaosError('format', 'request not built'));
      return;
    }
    req.on('response', (res) => {
      armIdle();
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        settle(new CasaosError('size', 'answer too large', { status: res.statusCode }));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(new CasaosError('size', 'answer too large', { status: res.statusCode }));
          return;
        }
        chunks.push(chunk);
        armIdle();
      });
      res.on('end', () =>
        settle(undefined, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(networkError(err, true)));
    });
    req.on('error', (err) => settle(networkError(err, sent)));
    sent = true;
    armIdle();
    req.end(body);
  });
}

const parseJson = (body) => {
  try {
    return body ? JSON.parse(body) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The data of an answer, or the CasaosError it is. The envelope is read
 * before anything else, so another web server is never taken for CasaOS:
 * v1 answers `{ "success": 200, "message", "data" }`, v2 `{ "data": ... }`.
 */
export function parseAnswer({ status, headers = {}, body }, { v1 = false } = {}) {
  const json = parseJson(body);
  const code = Number.isInteger(json?.success) ? json.success : undefined;
  if (status >= 300 && status < 400) {
    throw new CasaosError('redirect', `redirection (HTTP ${status})`, { status });
  }
  if (status === 429 || status >= 500) {
    throw new CasaosError('http', `HTTP ${status}`, {
      status,
      code,
      retryAfter: retryAfterOf(headers['retry-after'], headers.date),
    });
  }
  if (status !== 200) throw new CasaosError('http', `HTTP ${status}`, { status, code });
  const envelope = json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  if (!envelope || !('data' in envelope) || (v1 && code !== 200)) {
    throw new CasaosError('format', 'not an answer of CasaOS', { status, code });
  }
  return envelope.data;
}

/** The tokens of a login or refresh answer (`data.token` for a login, `data` for a refresh). */
export function parseTokens(data) {
  const t = data && typeof data === 'object' ? (data.token ?? data) : null;
  const ok = (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{16,4096}$/.test(v);
  if (!t || !ok(t.access_token) || !ok(t.refresh_token)) {
    throw new CasaosError('format', 'no token in the answer', { status: 200 });
  }
  return { access: t.access_token, refresh: t.refresh_token };
}
