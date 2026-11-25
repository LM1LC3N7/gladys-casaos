// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the simulated CasaOS
// (test/helpers/fakeCasaos.js), with the exact wiring of the container
// (src/handlers.js). The app's timers are virtual (the kit's testClock: they
// fire only on `advance`), the network is real (127.0.0.1): every wait on the
// network is bounded in real time, so a test fails, it never hangs.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CasaosApp } from '../../src/app.js';
import { addressId } from '../../src/config.js';
import { buildAppDevice, buildServerDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { testClock } from '../kit/clock.mjs';
import { PASSWORD, USER, fakeCasaos } from './fakeCasaos.js';

/** Real-time wait for a condition, bounded: throws (never hangs) after `timeout` ms. */
export async function waitFor(fn, what = 'the condition', timeout = 4000) {
  const end = performance.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A promise bounded in real time: rejects (never hangs) after `timeout` ms. */
export function within(promise, what = 'the promise', timeout = 6000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} never settled`)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Bounded in real time: runs the due virtual timers (advancing `step` ms each
 * turn) until `fn()` is true; throws (never hangs) after `timeout` real ms.
 */
export async function until(ctx, fn, what = 'the condition', { step = 0, timeout = 4000 } = {}) {
  const end = performance.now() + timeout;
  for (;;) {
    await ctx.clock.advance(step);
    const value = await fn();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The created devices (as a user would create them from the Discovery). */
export function createdDevices(gladys, port, appList = ['jellyfin', 'nextcloud', 'mosquitto']) {
  const address = { id: addressId('127.0.0.1', port), host: '127.0.0.1' };
  return [
    buildServerDevice(gladys, address, [
      { name: 'sda', label: 'sda' },
      { name: 'sdb', label: 'sdb' },
    ]),
    ...appList.map((id) => buildAppDevice(gladys, { id, title: id })),
  ];
}

export async function setup(
  t,
  {
    server = {},
    config = {},
    memory = null,
    store,
    connect = true,
    create = true,
    apps,
    getConfig,
    request,
    clock = testClock(),
    reuse,
  } = {},
) {
  const cs = reuse ?? (await fakeCasaos(server));
  if (!reuse) t.after(() => cs.close());
  const kept = store ?? memoryStore(memory);
  const raw = {
    url: cs.url,
    username: USER,
    password: PASSWORD,
    poll_interval: 60,
    ...config,
  };
  const ids = createFakeGladys();
  const devices = create ? createdDevices(ids, cs.port, apps) : [];
  const gladys = createFakeGladys({ config: raw, devices });
  if (getConfig) gladys.getConfig = getConfig;
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  const app = new CasaosApp({
    gladys,
    logger,
    store: kept,
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
    request,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.shutdown());
  const serverId = `ext:test-integration:server:${addressId('127.0.0.1', cs.port)}`;
  const appId = (id) => `ext:test-integration:app:${id}`;
  const press = (id, key, value = 1) =>
    gladys.fake.setValue({ external_id: appId(id) }, { external_id: `${appId(id)}:${key}` }, value);
  const ctx = { cs, gladys, app, clock, store: kept, logs, raw, serverId, appId, press };
  if (connect) await within(gladys.connect(), 'connect');
  return ctx;
}

/** The first read done (online), advancing the virtual clock as needed. */
export const online = (ctx) => until(ctx, () => ctx.app.online, 'online');

export const stateOf = (ctx, id) => ctx.gladys.fake.lastState(id);

/** The text of the last connection status, in English. */
export const statusText = (ctx) => {
  const s = ctx.gladys.fake.connectionStatus;
  const m = s?.message;
  return typeof m === 'string' ? m : (m?.en ?? '');
};
