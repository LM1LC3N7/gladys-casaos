// -----------------------------------------------------------------------------
// CasaosApp: the integration. One CasaOS server, its apps.
//
//   reads     every `poll_interval` s (60 by default), measured from the start
//             of the previous read: system values, the apps, and every 5 min
//             the disks (secondary: a failure there blocks nothing). Never
//             sooner: not on a reconnection to Gladys, not on a restart (the
//             time of the last read is in /data), not on the Discovery, not on
//             the test button within the interval.
//   session   one login, then the refresh token (CasaOS admits one login a
//             minute for all its clients); never two logins within a minute,
//             across restarts. A refused user name or password stops
//             everything until the user saves the configuration or presses
//             "Test the connection"; the refusal survives restarts (a 6-bit
//             mark in /data).
//   commands  start (always allowed) and stop (off by default, option checked
//             when the press arrives AND just before the first byte); both
//             refused for the app running Gladys; decided on a fresh read of
//             the app; a success only once a read shows the state asked.
//
// Two clocks: `mono` (monotonic) decides every delay, pause and budget;
// `now` (wall) only dates what /data keeps across restarts.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { CasaosError, httpRequest, parseAnswer, parseTokens } from './casaos.js';
import { normalizeConfig, sameAccount } from './config.js';
import {
  FEATURES,
  LIMITS,
  PATHS,
  REFUSED_LOGIN_CODES,
  TIMINGS,
  diskTemperatureKey,
} from './constants.js';
import {
  appIds,
  buildAppDevice,
  buildServerDevice,
  createdDevices,
  keptDiskNames,
  parseExternalId,
  serverIds,
} from './devices.js';
import { T, reasonOf } from './i18n.js';
import { parseApp, parseApps, parseDisks, parseUtilization } from './parse.js';
import { credentialsMark, emptyMemory, fileStore, newSalt, normalizeMemory } from './store.js';

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** Thrown when a login must wait (CasaOS admits one a minute). */
class LoginWait extends Error {
  constructor(delay) {
    super('login spacing');
    this.loginWait = delay;
  }
}

/** Thrown when CasaOS refused the user name or the password. */
class Refused extends Error {
  constructor() {
    super('credentials refused');
    this.refused = true;
  }
}

/** Thrown when the read belongs to an older configuration. */
class Stale extends Error {
  constructor() {
    super('stale');
    this.stale = true;
  }
}

export class CasaosApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {object} [options.store] /data (src/store.js)
   * @param {() => number} [options.now] wall clock (ms)
   * @param {() => number} [options.mono] monotonic clock (ms)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   * @param {Function} [options.request] the HTTP transport (src/casaos.js)
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'casaos' }),
    store = fileStore(),
    now = Date.now,
    mono = () => performance.now(),
    timers = globalThis,
    request = httpRequest,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.mono = mono;
    this.timers = timers;
    this.request = request;
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, now: mono });
    this.queue = Promise.resolve();
    this.closed = false;
    this.generation = 0;
    this.config = null;
    this.raw = {};
    this.memory = emptyMemory();
    /** 'unknown' | 'loading' | 'loaded' | 'failed': /data is written only once read. */
    this.memoryState = 'unknown';
    this.memoryLoad = null;
    this.dataTimer = undefined;
    this.configTimer = undefined;
    this.connectSeq = 0;
    this.configFailures = 0;
    this.lastStatus = undefined;
    /** Apps with a command running (one at a time per app; two apps never wait for each other). */
    this.commands = new Set();
    /** Apps with a command sent and not confirmed yet: id -> { target, handles }. */
    this.pending = new Map();
    this.resetSession();
    this.resetReadings();
  }

  resetSession() {
    /** { access, refresh, at } (tokens in memory only, never in /data). */
    this.session = null;
    this.sessionPromise = null;
    this.lastLoginMono = -Infinity;
    this.blocked = false;
    this.pausedUntilMono = 0;
    this.retryDelay = TIMINGS.retryMin;
  }

  resetReadings() {
    this.readTimer = undefined;
    this.readPromise = null;
    this.reading = false;
    this.lastReadMono = null;
    this.lastOkMono = null;
    this.online = false;
    /** The last values read (each null until read): system, apps (Map), disks. */
    this.system = null;
    this.apps = null;
    this.skipped = 0;
    this.disks = null;
    this.disksDueMono = -Infinity;
    this.disksDelay = TIMINGS.disksEvery;
    this.discoveredKey = undefined;
    for (const { handles } of this.pending.values()) {
      for (const h of handles) this.timers.clearTimeout(h);
    }
    this.pending.clear();
  }

  // --- Small tools -------------------------------------------------------------

  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /** `promise`, or a rejection after `ms` (the promise itself goes on). */
  within(promise, ms, message = 'too slow') {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), Math.max(0, ms));
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  sleep(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, Math.max(0, ms)));
  }

  paused() {
    return this.mono() < this.pausedUntilMono;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatusKey && this.lastStatus !== undefined) return;
    this.lastStatus = { connected, message };
    this.lastStatusKey = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = undefined;
      this.logger.warn(`CasaOS: status not sent to Gladys (${err?.message})`);
    });
  }

  // --- /data ----------------------------------------------------------------------

  /**
   * Reads /data once (bounded): true when loaded. A read that fails or hangs
   * leaves `failed`, and a timer reads it again in 10 s, one read at a time.
   */
  async ensureMemory() {
    if (this.memoryState === 'loaded') return true;
    if (!this.memoryLoad) {
      this.memoryState = 'loading';
      const load = Promise.resolve()
        .then(() => this.store.load())
        .then(
          (raw) => {
            this.memory = normalizeMemory(raw, this.now());
            this.memoryState = 'loaded';
          },
          (err) => {
            this.memoryState = 'failed';
            this.logger.warn(`CasaOS: /data unreadable (${err?.message ?? 'error'})`);
          },
        )
        .finally(() => {
          if (this.memoryLoad === load) this.memoryLoad = null;
        });
      this.memoryLoad = load;
    }
    try {
      await this.within(this.memoryLoad, TIMINGS.dataWait);
    } catch {
      // Still loading: the timer below tries again once that read is over.
    }
    if (this.memoryState === 'loaded') return true;
    if (this.memoryState === 'loading') this.memoryState = 'failed';
    return false;
  }

  /** Writes /data (never over a file that could not be read), bounded; resolves true when done. */
  async save() {
    if (this.memoryState !== 'loaded') return false;
    try {
      await this.within(Promise.resolve(this.store.save(this.memory)), TIMINGS.dataWait);
      return true;
    } catch (err) {
      this.logger.warn(`CasaOS: writing /data failed (${err?.message})`);
      return false;
    }
  }

  // --- Lifecycle --------------------------------------------------------------------

  /**
   * Connected to Gladys (the first time and after every reconnection): the
   * configuration is read; when that fails, it is tried again, spaced (5 s,
   * 15 s, 30 s, then every minute), without end, the status saying so.
   */
  async connectedWith(getConfig) {
    const seq = ++this.connectSeq;
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (seq !== this.connectSeq || this.closed) return;
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `CasaOS: reading the configuration failed (${err?.message ?? 'error'}); next try in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.status.configUnread(wait));
      if (seq !== this.connectSeq || this.closed) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connectedWith(getConfig).catch(() => this.logger.error('CasaOS: start failed'));
      }, wait);
      return;
    }
    if (seq !== this.connectSeq || this.closed) return;
    this.configFailures = 0;
    await this.configure(raw, { force: false, reconnected: true });
  }

  /** The configuration saved by the user: a refusal is lifted, the account tried again. */
  configUpdated(raw) {
    return this.configure(raw, { force: true, reconnected: false });
  }

  configure(raw, { force, reconnected }) {
    return this.enqueue(async () => {
      if (this.closed) return;
      const next = normalizeConfig(raw);
      const same = sameAccount(this.config, next);
      this.raw = { ...(raw ?? {}) };
      if (reconnected) {
        // Gladys may have restarted: what it keeps in memory only is sent
        // again (status, Discovery), never an old value as a new one (the
        // next read publishes the values: the dedup cache is emptied).
        this.lastStatus = undefined;
        this.discoveredKey = undefined;
        this.gladys.forgetPublishedStates?.();
      }
      if (same) {
        const pollChanged = next.pollMs !== this.config.pollMs;
        this.config = next;
        if (force && (this.blocked || this.memory.refused)) {
          await this.begin({ force: true });
          return;
        }
        await this.publishDiscovery();
        if (this.lastStatus === undefined && this.lastStatusKey) {
          const [connected, message] = JSON.parse(this.lastStatusKey);
          await this.setStatus(connected, message);
        }
        if (pollChanged && this.readTimer !== undefined) this.scheduleNextRead();
        return;
      }
      this.config = next;
      this.generation += 1;
      this.timers.clearTimeout(this.readTimer);
      this.timers.clearTimeout(this.dataTimer);
      this.resetSession();
      this.resetReadings();
      await this.begin({ force });
    });
  }

  /** Starts the reads of the current configuration (after /data is read). */
  async begin({ force }) {
    const gen = this.generation;
    const c = this.config;
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    if (c.addressError) {
      const key = { empty: 'addressEmpty', credentials: 'addressCredentials' }[c.addressError];
      await this.setStatus(false, T.status[key ?? 'addressInvalid']);
      return;
    }
    if (c.credentialsError) {
      await this.setStatus(false, T.status.credentials[c.credentialsError]);
      return;
    }
    if (!(await this.ensureMemory())) {
      if (gen !== this.generation || this.closed) return;
      await this.setStatus(false, T.status.dataUnreadable);
      this.timers.clearTimeout(this.dataTimer);
      this.dataTimer = this.timers.setTimeout(() => {
        this.dataTimer = undefined;
        if (gen === this.generation && !this.closed) {
          this.enqueue(() => this.begin({ force })).catch(() => {});
        }
      }, TIMINGS.dataRetry);
      return;
    }
    if (gen !== this.generation || this.closed) return;
    // The same refused account is not tried again alone (restart, reconnection).
    const r = this.memory.refused;
    if (r) {
      const same = credentialsMark(r.salt, c.address.base, c.username, c.password) === r.mark;
      if (same && !force) {
        this.blocked = true;
        await this.setStatus(false, T.status.refused);
        return;
      }
      this.memory.refused = null;
      await this.save();
    }
    this.blocked = false;
    // A pause asked by CasaOS outlives a restart.
    const left = (this.memory.pausedUntil ?? 0) - this.now();
    if (left > 0) {
      this.pausedUntilMono = this.mono() + left;
      await this.setStatus(false, T.status.paused(left));
      this.scheduleRead(left);
      return;
    }
    // Never sooner than the interval after the last read, across restarts;
    // the user's save reads at once.
    const last = this.memory.lastReadAt;
    const delay = force || !last ? 0 : clamp(last + c.pollMs - this.now(), 0, c.pollMs);
    if (delay > 0) {
      this.logger.info(`CasaOS: next read in ${Math.round(delay / 1000)} s (interval kept)`);
    }
    if (this.lastStatus === undefined || !this.online) {
      await this.setStatus(false, T.status.connecting);
    }
    this.scheduleRead(delay);
  }

  async shutdown() {
    this.closed = true;
    this.generation += 1;
    this.connectSeq += 1;
    for (const h of [this.readTimer, this.dataTimer, this.configTimer]) {
      this.timers.clearTimeout(h);
    }
    this.readTimer = undefined;
    this.dataTimer = undefined;
    this.configTimer = undefined;
    for (const { handles } of this.pending.values()) {
      for (const h of handles) this.timers.clearTimeout(h);
    }
    this.pending.clear();
  }

  // --- Reads -------------------------------------------------------------------------

  scheduleRead(delay) {
    if (this.closed) return;
    const gen = this.generation;
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = this.timers.setTimeout(
      () => {
        this.readTimer = undefined;
        this.read(gen).catch((err) => this.logger.error(`CasaOS: read failed (${err?.message})`));
      },
      Math.max(0, delay),
    );
  }

  /** The next read, one interval after the start of the last one (the real period). */
  scheduleNextRead() {
    const since = this.lastReadMono === null ? Infinity : this.mono() - this.lastReadMono;
    this.scheduleRead(clamp(this.config.pollMs - since, 0, this.config.pollMs));
  }

  /** One read (a read in progress is joined, never doubled). */
  read(gen) {
    if (this.readPromise) return this.readPromise;
    const run = this.readOnce(gen).finally(() => {
      if (this.readPromise === run) this.readPromise = null;
    });
    this.readPromise = run;
    return run;
  }

  async readOnce(gen) {
    if (gen !== this.generation || this.closed || this.blocked) return;
    if (this.paused()) {
      this.scheduleRead(this.pausedUntilMono - this.mono());
      return;
    }
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    this.reading = true;
    const started = this.mono();
    this.lastReadMono = started;
    // The time of the attempt is kept BEFORE the read: a restart never reads sooner.
    this.memory.lastReadAt = this.now();
    await this.save();
    let outcome;
    try {
      outcome = await this.fetchAll(gen);
    } catch (err) {
      this.reading = false;
      if (err?.stale || gen !== this.generation || this.closed) return;
      await this.failed(err, gen);
      return;
    }
    this.reading = false;
    if (gen !== this.generation || this.closed) return;
    await this.apply(outcome, started);
    if (gen !== this.generation || this.closed) return;
    this.scheduleNextRead();
  }

  /** The requests of one read. Throws when nothing primary could be read. */
  async fetchAll(gen) {
    // The session first: a login refused, delayed or failed stops the read.
    await this.ensureSession(gen);
    const util = await this.authed(gen, (token) =>
      this.get(gen, PATHS.UTILIZATION, token, { v1: true }),
    ).then(
      (data) => parseUtilization(data) ?? { err: new CasaosError('format', 'no value') },
      (err) => ({ err }),
    );
    if (this.mustStop(util.err)) throw util.err;
    // CasaOS out of reach: the list of the apps would fail the same way.
    if (['network', 'timeout', 'tls', 'redirect'].includes(util.err?.kind)) throw util.err;
    const apps = await this.authed(gen, (token) =>
      this.get(gen, PATHS.APPS, token, {
        timeout: TIMINGS.appsTimeout,
        maxBytes: LIMITS.APPS_BYTES,
      }),
    ).then(
      (data) => parseApps(data) ?? { err: new CasaosError('format', 'no app list') },
      (err) => ({ err }),
    );
    if (this.mustStop(apps.err)) throw apps.err;
    if (util.err && apps.err) throw apps.err;
    let disks = null;
    if (this.mono() >= this.disksDueMono) {
      // Secondary: any failure (a 401/403 included) only delays the next try.
      const read = await this.authed(gen, (token) =>
        this.get(gen, PATHS.DISKS, token, { v1: true }),
      ).then(
        (data) => parseDisks(data) ?? { err: new CasaosError('format', 'no disk list') },
        (err) => ({ err }),
      );
      if (read.err?.status === 429) throw read.err;
      if (read.err?.stale || read.err?.refused) throw read.err;
      if (read.err) {
        this.disksDelay = Math.min(this.disksDelay * 2, 3600_000);
        this.logger.debug?.(`CasaOS: disks not read (${read.err.message})`);
      } else {
        this.disksDelay = TIMINGS.disksEvery;
        disks = read;
      }
      this.disksDueMono = this.mono() + this.disksDelay;
    }
    return {
      system: util.err ? null : util,
      systemErr: util.err ?? null,
      apps: apps.err ? null : apps,
      appsErr: apps.err ?? null,
      disks,
    };
  }

  /** A failure that stops the whole read: a refusal, a wait, a pause, an old configuration. */
  mustStop(err) {
    return Boolean(err && (err.stale || err.refused || err.loginWait || err.status === 429));
  }

  async get(gen, path, token, { v1 = false, timeout, maxBytes } = {}) {
    const res = await this.request(this.config.address, {
      method: 'GET',
      path,
      token,
      timeout,
      maxBytes,
    });
    if (gen !== this.generation) throw new Stale();
    return parseAnswer(res, { v1 });
  }

  async apply({ system, systemErr, apps, appsErr, disks }, started) {
    this.online = true;
    this.retryDelay = TIMINGS.retryMin;
    this.lastOkMono = started;
    if (system) this.system = system;
    if (apps) {
      this.apps = apps.apps;
      this.skipped = apps.skipped;
    }
    if (disks) this.disks = disks;
    if (systemErr) this.logger.warn(`CasaOS: system values not read (${systemErr.message})`);
    if (appsErr) this.logger.warn(`CasaOS: apps not read (${appsErr.message})`);
    await this.publishDiscovery();
    await this.publishStates(this.statesOf({ system, apps: apps?.apps ?? null, disks }));
    let partial = null;
    if (appsErr) partial = 'apps';
    else if (systemErr) partial = 'system';
    await this.setStatus(true, T.status.ok({ ...this.counts(), partial }));
  }

  counts() {
    let running = 0;
    let stopped = 0;
    for (const app of this.apps?.values() ?? []) {
      if (app.state === 'running') running += 1;
      else if (app.state === 'stopped') stopped += 1;
    }
    return { running, stopped };
  }

  /** A read failed: a refusal (final), a login to wait for, a pause, or a growing retry. */
  async failed(err, gen) {
    if (gen !== this.generation || this.closed) return;
    this.online = false;
    if (err?.refused) {
      await this.setStatus(false, T.status.refused);
      return;
    }
    if (err?.loginWait) {
      await this.setStatus(false, T.status.loginWait(err.loginWait));
      this.scheduleRead(err.loginWait);
      return;
    }
    if (err?.status === 429 || (err?.status >= 500 && err.retryAfter !== undefined)) {
      const delay = await this.pauseFor(err);
      if (gen !== this.generation || this.closed) return;
      await this.setStatus(false, T.status.paused(delay));
      this.scheduleRead(delay);
      return;
    }
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, TIMINGS.retryMax);
    this.logger.warn(`CasaOS: read failed (${err?.message ?? 'error'})`);
    await this.setStatus(false, T.status.failed(err, delay));
    if (gen !== this.generation || this.closed) return;
    this.scheduleRead(delay);
  }

  /** A pause asked by CasaOS (429, or 5xx with Retry-After): every path waits, kept in /data. */
  async pauseFor(err) {
    const delay = clamp(err?.retryAfter ?? TIMINGS.pauseMin, TIMINGS.pauseMin, TIMINGS.pauseMax);
    this.pausedUntilMono = Math.max(this.pausedUntilMono, this.mono() + delay);
    this.memory.pausedUntil = this.now() + delay;
    this.logger.warn(
      `CasaOS: asked to wait (HTTP ${err?.status}), pause of ${Math.round(delay / 1000)} s`,
    );
    await this.save();
    return delay;
  }

  // --- Session -------------------------------------------------------------------------

  /** A valid session (shared by every caller: one login or renewal at a time). */
  ensureSession(gen) {
    if (gen !== this.generation) return Promise.reject(new Stale());
    if (this.blocked) return Promise.reject(new Refused());
    const s = this.session;
    if (s && this.mono() - s.at < TIMINGS.sessionRenew) return Promise.resolve(s);
    if (!this.sessionPromise) {
      const run = this.openSession(gen).finally(() => {
        if (this.sessionPromise === run) this.sessionPromise = null;
      });
      this.sessionPromise = run;
    }
    return this.sessionPromise;
  }

  async openSession(gen) {
    if (this.session) {
      // Renewed with the refresh token: no password, no login counted by CasaOS.
      try {
        const res = await this.request(this.config.address, {
          method: 'POST',
          path: PATHS.REFRESH,
          json: { refresh_token: this.session.refresh },
        });
        if (gen !== this.generation) throw new Stale();
        const tokens = parseTokens(parseAnswer(res, { v1: true }));
        this.session = { ...tokens, at: this.mono() };
        return this.session;
      } catch (err) {
        if (err?.stale) throw err;
        if (err?.status !== 401) throw err;
        // The refresh token expired (7 days) or the keys of CasaOS changed: log in.
        this.session = null;
      }
    }
    return this.login(gen);
  }

  async login(gen) {
    const c = this.config;
    const since = Math.min(
      this.mono() - this.lastLoginMono,
      this.memory.lastLoginAt === null ? Infinity : this.now() - this.memory.lastLoginAt,
    );
    if (since < TIMINGS.loginSpacing) throw new LoginWait(TIMINGS.loginSpacing - since);
    this.lastLoginMono = this.mono();
    this.memory.lastLoginAt = this.now();
    // Kept before the login is sent: a restart never logs in again within a minute.
    await this.save();
    if (gen !== this.generation) throw new Stale();
    const res = await this.request(c.address, {
      method: 'POST',
      path: PATHS.LOGIN,
      json: { username: c.username, password: c.password },
    });
    if (gen !== this.generation) throw new Stale();
    if (res.status === 400) {
      let code;
      try {
        code = JSON.parse(res.body)?.success;
      } catch {
        code = undefined;
      }
      if (REFUSED_LOGIN_CODES.includes(code)) {
        this.blocked = true;
        const salt = newSalt();
        this.memory.refused = {
          salt,
          mark: credentialsMark(salt, c.address.base, c.username, c.password),
        };
        this.logger.warn('CasaOS: user name or password refused; not tried again until changed');
        await this.save();
        throw new Refused();
      }
      const err = new CasaosError(
        'login',
        `HTTP 400${Number.isInteger(code) ? `, code ${code}` : ''}`,
        {
          status: 400,
        },
      );
      throw err;
    }
    const tokens = parseTokens(parseAnswer(res, { v1: true }));
    this.session = { ...tokens, at: this.mono() };
    if (this.memory.refused) {
      this.memory.refused = null;
      await this.save();
    }
    this.logger.info(`CasaOS: logged in to ${c.address.base}`);
    return this.session;
  }

  /**
   * `fn(token)` with a session; a 401 on a token that is not brand new renews
   * the session once (expired) and tries again. A 401 on a fresh token is an
   * error of that request, never a refusal of the account.
   */
  async authed(gen, fn) {
    const s = await this.ensureSession(gen);
    try {
      return await fn(s.access);
    } catch (err) {
      if (err?.status !== 401 || this.mono() - s.at < TIMINGS.freshToken) throw err;
      if (this.session === s) this.session = { ...s, at: -Infinity };
      const renewed = await this.ensureSession(gen);
      return fn(renewed.access);
    }
  }

  // --- Gladys: Discovery and states ------------------------------------------------------

  /** The disks to show on the server device: the current ones, and every one created before. */
  shownDisks() {
    const disks = new Map((this.disks ?? []).map((d) => [d.name, d]));
    const created = createdDevices(this.gladys).servers.find(
      (s) => s.id === this.config?.address?.id,
    );
    for (const name of keptDiskNames(this.gladys, created?.device)) {
      if (!disks.has(name)) disks.set(name, { name, label: name });
    }
    return [...disks.values()].slice(0, LIMITS.DISKS * 2);
  }

  discovered() {
    const address = this.config?.address;
    if (!address || this.config.credentialsError) return [];
    const devices = [buildServerDevice(this.gladys, address, this.shownDisks())];
    for (const app of this.apps?.values() ?? []) {
      // The app running Gladys is never offered.
      if (!app.gladys) devices.push(buildAppDevice(this.gladys, app));
    }
    return devices;
  }

  /** Publishes the Discovery when it changed (or was asked); never throws. */
  async publishDiscovery({ force = false } = {}) {
    const devices = this.discovered();
    const key = JSON.stringify(devices.map((d) => [d.external_id, d.name, d.features.length]));
    if (!force && key === this.discoveredKey) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discoveredKey = key;
    } catch (err) {
      this.logger.warn(`CasaOS: Discovery not published (${err?.message})`);
    }
  }

  /** The scan button: what is known, never a read sooner than the interval. */
  scan() {
    return this.publishDiscovery({ force: true });
  }

  /**
   * The states of what a read just gave (only that: a value not read this
   * time is not published again), for the created devices. Returns
   * { main, optional }: the update flags are optional (budget).
   */
  statesOf({ system, apps, disks }) {
    const main = [];
    const optional = [];
    const created = createdDevices(this.gladys);
    const address = this.config?.address;
    const push = (list, id, state) => {
      if (state !== null && state !== undefined && Number.isFinite(state)) {
        list.push({ device_feature_external_id: id, state });
      }
    };
    for (const server of created.servers) {
      if (server.id !== address?.id) continue;
      const ids = serverIds(this.gladys, server.id);
      if (system) {
        push(main, ids.feature(FEATURES.CPU_USAGE), system.cpuUsage);
        push(main, ids.feature(FEATURES.CPU_TEMPERATURE), system.cpuTemperature);
        push(main, ids.feature(FEATURES.MEMORY_USAGE), system.memoryUsage);
        push(main, ids.feature(FEATURES.MEMORY_USED), system.memoryUsedMb);
        push(main, ids.feature(FEATURES.DISK_USAGE), system.diskUsage);
        push(main, ids.feature(FEATURES.DISK_FREE), system.diskFreeGb);
      }
      if (apps) {
        const { running, stopped } = this.counts();
        push(main, ids.feature(FEATURES.APPS_RUNNING), running);
        push(main, ids.feature(FEATURES.APPS_STOPPED), stopped);
      }
      for (const disk of disks ?? []) {
        push(main, ids.feature(diskTemperatureKey(disk.name)), disk.temperature);
      }
    }
    if (apps) {
      for (const entry of created.apps) {
        const ids = appIds(this.gladys, entry.id);
        const app = apps.get(entry.id);
        // An app gone from the list (uninstalled) does not run.
        if (!app) push(main, ids.feature(FEATURES.RUNNING), 0);
        else if (app.state !== 'unknown') {
          push(main, ids.feature(FEATURES.RUNNING), app.state === 'running' ? 1 : 0);
        }
        if (app?.updateAvailable !== null && app?.updateAvailable !== undefined) {
          push(optional, ids.feature(FEATURES.UPDATE_AVAILABLE), app.updateAvailable ? 1 : 0);
        }
      }
    }
    return { main, optional };
  }

  /** Within the budget of states per minute: the main ones first. Never throws. */
  async publishStates({ main, optional }) {
    let list = [...main, ...optional];
    const left = this.budget.remaining();
    if (list.length > left) {
      this.logger.warn(`CasaOS: ${list.length - left} state(s) held back (states per minute)`);
      list = list.slice(0, left);
    }
    if (list.length === 0) return;
    try {
      const result = await this.gladys.publishChangedStates(list);
      this.budget.record(result?.count ?? list.length);
    } catch (err) {
      this.logger.warn(`CasaOS: states not published (${err?.message})`);
    }
  }

  /** A device created in Gladys: its values, only when the last read is recent. */
  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) return;
    await this.publishDiscovery();
    const fresh = this.lastOkMono !== null && this.mono() - this.lastOkMono < this.config.pollMs;
    if (!fresh || !this.online) return;
    await this.publishStates(
      this.statesOf({ system: this.system, apps: this.apps, disks: this.disks }),
    );
  }

  deviceDeleted() {
    // Nothing kept per device.
  }

  // --- Commands ----------------------------------------------------------------------------
  //
  // Start and stop are two buttons (never a switch). Stop is refused unless the
  // user allowed it (`allow_app_stop`, off by default), checked when the press
  // arrives AND just before the first byte of the request. Both are refused for
  // the app running Gladys. The decision is taken on a fresh read of the app:
  // unknown, gone or between two states -> refused; already in the state asked
  // -> nothing sent (done). CasaOS answers "being changed asynchronously": the
  // command is a success only once a read shows the state asked; until then
  // Gladys is answered "sent, without confirmation" and the app is read again
  // 5 s and 20 s after the command. One command at a time per app; Gladys
  // waits 5 s: nothing is written later than 3.1 s after the press.

  async setValue(device, feature, value) {
    const arrived = this.mono();
    const deadline = arrived + TIMINGS.commandBudget;
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    const key = parsed?.feature;
    if (parsed?.kind !== 'app' || (key !== FEATURES.START && key !== FEATURES.STOP)) {
      throw new Error(T.errors.unknownFeature);
    }
    if (value !== 1 && value !== '1') throw new Error(T.errors.invalidValue);
    const appId = parsed.id;
    const gen = this.generation;
    const check = () => {
      if (gen !== this.generation || this.closed) throw new Error(T.errors.configChanged);
      if (key === FEATURES.STOP && this.config?.allowStop !== true) {
        throw new Error(T.errors.stopDisabled);
      }
      if (this.blocked) throw new Error(T.errors.refused);
      if (this.paused()) throw new Error(T.errors.paused);
    };
    check();
    if (!this.config?.address || this.config.credentialsError) {
      throw new Error(T.errors.notConnected);
    }
    if (this.commands.has(appId)) throw new Error(T.errors.busy);
    if (this.pending.has(appId)) throw new Error(T.errors.stopping);
    this.commands.add(appId);
    try {
      return await this.command({ gen, appId, key, deadline, check });
    } finally {
      this.commands.delete(appId);
    }
  }

  /** The app read now (null when CasaOS does not know it). */
  async readApp(gen, appId, timeout) {
    try {
      const data = await this.authed(gen, (token) =>
        this.get(gen, PATHS.app(appId), token, { timeout, maxBytes: LIMITS.APP_BYTES }),
      );
      const app = parseApp(appId, data);
      if (!app) throw new CasaosError('format', 'not an app');
      return app;
    } catch (err) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  /** A failure on the way of a command: a pause is kept, the message says nothing was sent. */
  async commandFailure(err) {
    if (err?.status === 429) {
      await this.pauseFor(err);
      return new Error(T.errors.paused);
    }
    if (err?.refused) return new Error(T.errors.refused);
    if (err?.loginWait || err?.stale) return new Error(T.errors.notConnected);
    if (err instanceof CasaosError) return new Error(T.errors.notRead(reasonOf(err).en));
    return err instanceof Error ? err : new Error(T.errors.notConnected);
  }

  async command({ gen, appId, key, deadline, check }) {
    const left = () => deadline - this.mono();
    const target = key === FEATURES.START ? 'running' : 'stopped';
    let before;
    try {
      await this.within(
        this.ensureSession(gen),
        left() - TIMINGS.commandSendRoom,
        'session too slow',
      );
      before = await this.readApp(gen, appId, Math.max(1, left() - TIMINGS.commandSendRoom));
    } catch (err) {
      if (err?.message === 'session too slow') throw new Error(T.errors.tooLate, { cause: err });
      throw await this.commandFailure(err);
    }
    if (!before) throw new Error(T.errors.unknownApp);
    if (before.gladys) throw new Error(T.errors.gladys);
    if (before.state === 'unknown') throw new Error(T.errors.unknownState(before.status));
    this.noteApp(before);
    if (before.state === target) {
      // Already so, on a fresh read: nothing to send.
      await this.publishRunning(appId);
      return;
    }
    check();
    if (left() < TIMINGS.commandLastByte + 200) throw new Error(T.errors.tooLate);
    const session = this.session;
    if (!session) throw new Error(T.errors.notConnected);
    let res;
    try {
      res = await this.request(this.config.address, {
        method: 'PUT',
        path: PATHS.appStatus(appId),
        token: session.access,
        json: key === FEATURES.START ? 'start' : 'stop',
        timeout: Math.max(1, left() - 100),
        // The last check, just before the first byte: the option, the
        // configuration, the pause, the time left.
        beforeSend: () => {
          check();
          if (this.pending.has(appId)) throw new Error(T.errors.stopping);
          if (this.mono() > deadline - TIMINGS.commandLastByte) {
            throw new Error(T.errors.tooLate);
          }
        },
      });
    } catch (err) {
      if (!(err instanceof CasaosError)) throw err;
      if (!err.sent) throw new Error(T.errors.notSent(reasonOf(err).en), { cause: err });
      // Written, no answer: maybe done. Read again soon, never sent again.
      this.followUp(gen, appId, target);
      throw new Error(T.errors.unconfirmed, { cause: err });
    }
    // Sent: from here on, never "nothing sent".
    if (gen !== this.generation) throw new Error(T.errors.unconfirmed);
    if (res.status === 429) {
      try {
        parseAnswer(res);
      } catch (err) {
        await this.pauseFor(err);
      }
      throw new Error(T.errors.rejected('too many requests'));
    }
    if (res.status >= 500) {
      // CasaOS answered an error: what it did is read again.
      this.followUp(gen, appId, target);
      throw new Error(T.errors.rejected(`HTTP ${res.status}`));
    }
    if (res.status !== 200) {
      if (res.status === 401 && this.session === session)
        this.session = { ...session, at: -Infinity };
      throw new Error(T.errors.rejected(`HTTP ${res.status}`));
    }
    this.logger.info(`CasaOS: ${key} of ${appId} sent`);
    // CasaOS applies it in the background: read until the state asked shows.
    while (left() > TIMINGS.confirmEvery + 300) {
      await this.sleep(TIMINGS.confirmEvery);
      if (gen !== this.generation || this.closed) break;
      let now;
      try {
        now = await this.readApp(gen, appId, Math.max(1, left() - 150));
      } catch {
        break;
      }
      if (now?.state === target) {
        this.noteApp(now);
        await this.publishRunning(appId);
        this.logger.info(`CasaOS: ${key} of ${appId} confirmed`);
        return;
      }
    }
    this.followUp(gen, appId, target);
    throw new Error(T.errors.unconfirmed);
  }

  /** What a command read, until the next read. */
  noteApp(app) {
    if (!this.apps) return;
    const known = this.apps.get(app.id);
    if (known) this.apps.set(app.id, { ...known, state: app.state });
  }

  async publishRunning(appId) {
    const app = this.apps?.get(appId);
    if (!app || app.state === 'unknown') return;
    const created = createdDevices(this.gladys).apps.some((a) => a.id === appId);
    if (!created) return;
    await this.publishStates({
      main: [
        {
          device_feature_external_id: appIds(this.gladys, appId).feature(FEATURES.RUNNING),
          state: app.state === 'running' ? 1 : 0,
        },
      ],
      optional: [],
    });
  }

  /**
   * A command sent and not confirmed: the app is read again 5 s and 20 s
   * after; the state asked confirms it (a state equal to the one before
   * does not); after 20 s, the state read is published and the wait ends.
   */
  followUp(gen, appId, target) {
    const sentMono = this.mono();
    const entry = { target, handles: [] };
    const old = this.pending.get(appId);
    for (const h of old?.handles ?? []) this.timers.clearTimeout(h);
    this.pending.set(appId, entry);
    const last = TIMINGS.followUps.length - 1;
    TIMINGS.followUps.forEach((delay, i) => {
      const handle = this.timers.setTimeout(
        async () => {
          if (gen !== this.generation || this.closed || this.pending.get(appId) !== entry) return;
          let app;
          try {
            app = await this.readApp(gen, appId, TIMINGS.readTimeout);
          } catch (err) {
            app = undefined;
            this.logger.debug?.(`CasaOS: follow-up read of ${appId} failed (${err?.message})`);
          }
          if (gen !== this.generation || this.closed || this.pending.get(appId) !== entry) return;
          if (app) this.noteApp(app);
          if (app?.state === target) {
            this.pending.delete(appId);
            this.logger.info(`CasaOS: ${appId} is now ${target} (confirmed)`);
            await this.publishRunning(appId);
            return;
          }
          if (i === last) {
            this.pending.delete(appId);
            this.logger.warn(
              `CasaOS: ${appId} is not ${target} 20 s after the command (${app?.state ?? 'not read'})`,
            );
            await this.publishRunning(appId);
          }
        },
        Math.max(0, sentMono + delay - this.mono()),
      );
      entry.handles.push(handle);
    });
  }

  // --- Configuration button -------------------------------------------------------------

  /**
   * "Test the connection": a refusal is lifted (the user asked), then a read
   * now, unless the last one is younger than the interval (its result is
   * told). Answers within 25 s.
   */
  async testConnection() {
    const run = this.enqueue(async () => {
      const c = this.config;
      if (!c) throw new Error(T.errors.notConnected);
      const gen = this.generation;
      let forced = false;
      if (this.blocked || this.memory.refused || this.memoryState !== 'loaded') {
        await this.begin({ force: true });
        forced = true;
      }
      if (gen !== this.generation) throw new Error(T.errors.configChanged);
      const recent =
        this.online && this.lastOkMono !== null && this.mono() - this.lastOkMono < c.pollMs;
      if (recent) return T.test.recent(this.offered());
      // A read started less than 30 s ago is not doubled by the button.
      const justRead =
        !forced && this.lastReadMono !== null && this.mono() - this.lastReadMono < TIMINGS.retryMin;
      if (!justRead && !this.blocked && !this.paused() && c.address && !c.credentialsError) {
        await this.read(gen);
      }
      if (this.online) return T.test.ok(this.offered());
      throw new Error(this.lastStatus?.message?.en ?? T.errors.notConnected);
    });
    return this.within(run, TIMINGS.testBudget, T.errors.testTooLong);
  }

  offered() {
    return [...(this.apps?.values() ?? [])].filter((a) => !a.gladys).length;
  }
}
