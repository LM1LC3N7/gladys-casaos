// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in one small JSON file readable by the container user only:
//   - a user name and password CasaOS refused, as a 6-bit salted mark only (it
//     can never tell them, it only says "the same ones were refused");
//   - the end of a 429 / 5xx pause;
//   - the time of the last login (CasaOS admits one a minute for all its
//     clients) and of the last read.
// No token, no password, no personal data.
//
// `load()` tells "no file" (null) from "a file that cannot be read" (throws):
// an unreadable /data is never taken for an empty one. A special file (FIFO,
// device, directory) is refused without opening it. Writes go one at a time
// (temporary file, then rename).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { STATE_FILE, TIMINGS } from './constants.js';

const MAX_SIZE = 16 * 1024;

export function fileStore(path = STATE_FILE) {
  let chain = Promise.resolve();
  return {
    async load() {
      let info;
      try {
        info = await lstat(path);
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw new Error(`state file unreadable (${err?.code ?? 'error'})`, { cause: err });
      }
      if (!info.isFile()) throw new Error('state file unreadable (not a regular file)');
      if (info.size > MAX_SIZE) throw new Error('state file too large');
      let content;
      try {
        content = await readFile(path, 'utf8');
      } catch (err) {
        throw new Error(`state file unreadable (${err?.code ?? 'error'})`, { cause: err });
      }
      if (content.length > MAX_SIZE) throw new Error('state file too large');
      try {
        return JSON.parse(content);
      } catch {
        throw new Error('state file not JSON');
      }
    },
    save(data) {
      const content = JSON.stringify(data);
      const write = chain.then(async () => {
        if (content.length > MAX_SIZE) throw new Error('state too large');
        const temporary = `${path}.tmp`;
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip; `failLoad`, `failSave`, `hang`, `hangLoad` break it. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    loads: 0,
    failLoad: false,
    failSave: false,
    hang: false,
    hangLoad: false,
    async load() {
      this.loads += 1;
      if (this.hangLoad) return new Promise(() => {});
      if (this.failLoad) throw new Error('state file unreadable (EIO)');
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.failSave) throw new Error('EROFS');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** The 6-bit mark of an account with a salt (0 to 63): never enough to find the password. */
export const credentialsMark = (salt, address, username, password) =>
  createHash('sha256').update(`${salt}\n${address}\n${username}\n${password}`, 'utf8').digest()[0] &
  0x3f;

export const newSalt = () => randomBytes(8).toString('hex');

/** An empty memory. */
export const emptyMemory = () => ({
  refused: null,
  pausedUntil: null,
  lastLoginAt: null,
  lastReadAt: null,
});

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * The persisted state, repaired and bounded. A date in the future is not
 * trusted: the last login and the last read count as now, a pause is at most
 * 6 h from now.
 */
export function normalizeMemory(raw, now) {
  const data = isObject(raw) ? raw : {};
  const out = emptyMemory();
  const r = data.refused;
  if (
    isObject(r) &&
    typeof r.salt === 'string' &&
    /^[0-9a-f]{16}$/.test(r.salt) &&
    Number.isInteger(r.mark) &&
    r.mark >= 0 &&
    r.mark < 64
  ) {
    out.refused = { salt: r.salt, mark: r.mark };
  }
  if (Number.isFinite(data.pausedUntil) && data.pausedUntil > now) {
    out.pausedUntil = Math.min(data.pausedUntil, now + TIMINGS.pauseMax);
  }
  if (Number.isFinite(data.lastLoginAt)) out.lastLoginAt = Math.min(data.lastLoginAt, now);
  if (Number.isFinite(data.lastReadAt)) out.lastReadAt = Math.min(data.lastReadAt, now);
  return out;
}
