// -----------------------------------------------------------------------------
// Start and stop: the option, the Gladys app, the fresh read, the
// confirmation by a read, the follow-ups, the pause, the budget of 3.5 s.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CasaosApp } from '../src/app.js';
import { httpRequest } from '../src/casaos.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { realClock } from './kit/clock.mjs';
import { PASSWORD, USER, fakeCasaos } from './helpers/fakeCasaos.js';
import { createdDevices, online, setup, stateOf, until, within } from './helpers/setup.js';

/** Presses a button and drives the virtual clock until Gladys gets its answer. */
async function press(ctx, id, key, value = 1) {
  let ack;
  const pending = ctx.press(id, key, value).then((a) => (ack = a));
  await until(ctx, () => ack !== undefined, `the ack of ${key} ${id}`, { step: 50 });
  await pending;
  return ack;
}

const ALLOW = { allow_app_stop: true };
const puts = (ctx) => ctx.cs.statusChanges.map(([id, action]) => `${action} ${id}`);

test('start: sent, then confirmed by a read; the state published', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  const ack = await press(ctx, 'nextcloud', 'start');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(puts(ctx), ['start nextcloud']);
  assert.equal(stateOf(ctx, `${ctx.appId('nextcloud')}:running`), 1);
  assert.ok(ctx.cs.count('GET /v2/app_management/compose/nextcloud') >= 2, 'read before and after');
});

test('stop is off by default: refused before any request', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  const before = ctx.cs.requests.length;
  const ack = await press(ctx, 'jellyfin', 'stop');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Stopping apps is off/);
  assert.equal(ctx.cs.requests.length, before);
});

test('stop allowed: sent and confirmed', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  await online(ctx);
  const ack = await press(ctx, 'jellyfin', 'stop');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(puts(ctx), ['stop jellyfin']);
  assert.equal(stateOf(ctx, `${ctx.appId('jellyfin')}:running`), 0);
});

test('the option is read again just before the first byte (turned off meanwhile)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  await online(ctx);
  ctx.cs.latencyMs = (r) => (r.path === '/v2/app_management/compose/jellyfin' ? 150 : 0);
  let ack;
  const pending = ctx.press('jellyfin', 'stop').then((a) => (ack = a));
  await new Promise((r) => setTimeout(r, 20));
  await ctx.app.configUpdated({ ...ctx.raw, allow_app_stop: false });
  await until(ctx, () => ack !== undefined, 'ack', { step: 20 });
  await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /Stopping apps is off/);
  assert.deepEqual(puts(ctx), []);
});

test('beforeSend: the option turned off once the connection is up: nothing written', async (t) => {
  let ctx;
  const request = (address, options) => {
    if (options.method === 'PUT') {
      const inner = options.beforeSend;
      options = {
        ...options,
        beforeSend: () => {
          ctx.app.latest = { ...ctx.app.latest, allowStop: false };
          inner();
        },
      };
    }
    return httpRequest(address, options);
  };
  ctx = await setup(t, { config: ALLOW, request });
  await online(ctx);
  const ack = await press(ctx, 'jellyfin', 'stop');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Stopping apps is off/);
  assert.equal(ctx.cs.count('PUT'), 0, 'not a byte of the command');
});

test('beforeSend: too late in the budget: nothing written', async (t) => {
  let ctx;
  const request = (address, options) => {
    if (options.method === 'PUT') {
      const inner = options.beforeSend;
      options = {
        ...options,
        beforeSend: () => {
          ctx.clock.advance(3_300);
          inner();
        },
      };
    }
    return httpRequest(address, options);
  };
  ctx = await setup(t, { request });
  await online(ctx);
  const ack = await press(ctx, 'nextcloud', 'start');
  assert.match(ack.error, /No time left/);
  assert.equal(ctx.cs.count('PUT'), 0);
});

test('the Gladys app is never started nor stopped (fresh read), even from a device', async (t) => {
  const ctx = await setup(t, { config: ALLOW, apps: ['gladys'] });
  await online(ctx);
  ctx.cs.apps.get('gladys').status = 'exited';
  for (const key of ['start', 'stop']) {
    const ack = await press(ctx, 'gladys', key);
    assert.equal(ack.success, false);
    assert.match(ack.error, /running Gladys/);
  }
  assert.deepEqual(puts(ctx), []);
});

test('an app renamed to look like Gladys on the fresh read is refused', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  await online(ctx);
  ctx.cs.apps.get('mosquitto').image = 'gladysassistant/gladys:v4';
  const ack = await press(ctx, 'mosquitto', 'stop');
  assert.equal(ack.success, false);
  assert.deepEqual(puts(ctx), []);
});

test('already in the state asked (fresh read): nothing sent, done', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  await online(ctx);
  assert.equal((await press(ctx, 'jellyfin', 'start')).success, true);
  assert.equal((await press(ctx, 'nextcloud', 'stop')).success, true);
  assert.deepEqual(puts(ctx), []);
});

test('between two states (paused, restarting) or gone: refused, nothing sent', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  await online(ctx);
  ctx.cs.apps.get('jellyfin').status = 'paused';
  let ack = await press(ctx, 'jellyfin', 'stop');
  assert.equal(ack.success, false);
  assert.match(ack.error, /neither running nor stopped \(paused\)/);
  ctx.cs.apps.delete('mosquitto');
  ack = await press(ctx, 'mosquitto', 'stop');
  assert.match(ack.error, /not installed/);
  assert.deepEqual(puts(ctx), []);
});

test('a press only (1); a reading feature or another device is refused', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  await online(ctx);
  assert.match((await press(ctx, 'jellyfin', 'stop', 0)).error, /Invalid value/);
  assert.match((await press(ctx, 'jellyfin', 'running', 1)).error, /Unknown device/);
  assert.deepEqual(puts(ctx), []);
});

test('never applied: "sent, without confirmation"; read again at 5 s and 20 s', async (t) => {
  const ctx = await setup(t, { config: ALLOW, server: { applyDelayMs: -1 } });
  await online(ctx);
  const ack = await press(ctx, 'jellyfin', 'stop');
  assert.equal(ack.success, false, 'a state equal to the one before is not a confirmation');
  assert.match(ack.error, /without confirmation/);
  assert.equal(stateOf(ctx, `${ctx.appId('jellyfin')}:running`), 1);
  // While it waits, another press for this app is refused (nothing sent).
  const again = await press(ctx, 'jellyfin', 'start');
  assert.match(again.error, /still being applied/);
  const reads = () => ctx.cs.count('GET /v2/app_management/compose/jellyfin');
  const n = reads();
  await until(ctx, () => reads() === n + 1, 'read at 5 s', { step: 1000 });
  await until(ctx, () => reads() === n + 2, 'read at 20 s', { step: 1000 });
  await until(ctx, () => !ctx.app.pending.has('jellyfin'), 'wait over');
  assert.ok(ctx.logs.some((l) => /not stopped 20 s after the command/.test(l)));
  assert.deepEqual(puts(ctx), ['stop jellyfin'], 'never sent again');
});

test('applied late: the follow-up read confirms it and publishes the state', async (t) => {
  const ctx = await setup(t, { config: ALLOW, server: { applyDelayMs: -1 } });
  await online(ctx);
  const ack = await press(ctx, 'jellyfin', 'stop');
  assert.match(ack.error, /without confirmation/);
  ctx.cs.apps.get('jellyfin').status = 'exited';
  await until(ctx, () => !ctx.app.pending.has('jellyfin'), 'confirmed', { step: 1000 });
  assert.equal(stateOf(ctx, `${ctx.appId('jellyfin')}:running`), 0);
  assert.ok(ctx.logs.some((l) => /jellyfin is now stopped \(confirmed\)/.test(l)));
});

test('written, no answer: "sent, without confirmation", never sent again', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  await online(ctx);
  ctx.cs.latencyMs = (r) => (r.method === 'PUT' ? Infinity : 0);
  let ack;
  const started = performance.now();
  const pending = ctx.press('jellyfin', 'stop').then((a) => (ack = a));
  await within(pending, 'ack');
  assert.ok(performance.now() - started < 4500);
  assert.equal(ack.success, false);
  assert.match(ack.error, /without confirmation/);
  assert.ok(ctx.app.pending.has('jellyfin'));
});

test('a 429 on the command: refused, every path pauses (kept in /data)', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  ctx.cs.replyFor = (r) => (r.method === 'PUT' ? { status: 429, body: {} } : undefined);
  const ack = await press(ctx, 'nextcloud', 'start');
  assert.equal(ack.success, false);
  assert.match(ack.error, /too many requests/);
  assert.ok(ctx.app.paused());
  assert.ok(ctx.store.data.pausedUntil > 0);
});

test('a 400/404 on the command: refused by CasaOS, nothing done, no follow-up', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  ctx.cs.replyFor = (r) => (r.method === 'PUT' ? { status: 400, body: {} } : undefined);
  const ack = await press(ctx, 'nextcloud', 'start');
  assert.match(ack.error, /CasaOS refused the command \(HTTP 400\)/);
  assert.ok(!ctx.app.pending.has('nextcloud'));
});

test('a 500 on the command: refused, and the app read again (follow-up)', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  ctx.cs.replyFor = (r) => (r.method === 'PUT' ? { status: 500, body: {} } : undefined);
  const ack = await press(ctx, 'nextcloud', 'start');
  assert.match(ack.error, /HTTP 500/);
  assert.ok(ctx.app.pending.has('nextcloud'));
});

test('a refused account: commands refused, nothing sent', async (t) => {
  const ctx = await setup(t, { config: { password: 'nope' } });
  await until(ctx, () => ctx.app.blocked, 'refused');
  const before = ctx.cs.requests.length;
  const ack = await press(ctx, 'nextcloud', 'start');
  assert.match(ack.error, /refused the user name/);
  assert.equal(ctx.cs.requests.length, before);
});

test('one command at a time per app; two apps never wait for each other', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  await online(ctx);
  ctx.cs.latencyMs = (r) => (r.path === '/v2/app_management/compose/nextcloud' ? 100 : 0);
  let a1;
  let a2;
  let b;
  ctx.press('nextcloud', 'start').then((a) => (a1 = a));
  await new Promise((r) => setTimeout(r, 10));
  ctx.press('nextcloud', 'start').then((a) => (a2 = a));
  ctx.press('jellyfin', 'stop').then((a) => (b = a));
  await until(ctx, () => a1 && a2 && b, 'acks', { step: 20 });
  assert.equal(a1.success, true, a1.error);
  assert.match(a2.error, /still running/);
  assert.equal(b.success, true, b.error);
  assert.deepEqual(puts(ctx).sort(), ['start nextcloud', 'stop jellyfin']);
});

test('real clock: a scene on 5 slow apps (500-900 ms) sets them all within 3.5 s each', async (t) => {
  const cs = await fakeCasaos();
  t.after(() => cs.close());
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
  cs.apps.clear();
  for (const id of ids) {
    cs.apps.set(id, { id, title: id, image: `img/${id}`, status: 'running', update: false });
  }
  const clock = realClock({ speed: 1 });
  t.after(() => clock.close());
  const raw = { url: cs.url, username: USER, password: PASSWORD, allow_app_stop: true };
  const gladys = createFakeGladys({ config: raw, devices: createdDevices(gladys0, cs.port, ids) });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new CasaosApp({
    gladys,
    logger,
    store: memoryStore(),
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.shutdown());
  await within(gladys.connect(), 'connect');
  await within(
    (async () => {
      while (!app.online) await new Promise((r) => setTimeout(r, 10));
    })(),
    'online',
  );
  let n = 0;
  cs.latencyMs = (r) =>
    r.path.startsWith('/v2/app_management/compose/') ? 500 + (n++ % 5) * 100 : 0;
  const started = performance.now();
  const acks = await within(
    Promise.all(
      ids.map((id) =>
        gladys.fake
          .setValue(
            { external_id: `ext:test-integration:app:${id}` },
            { external_id: `ext:test-integration:app:${id}:stop` },
            1,
          )
          .then((ack) => ({ ack, took: performance.now() - started })),
      ),
    ),
    'acks',
    8000,
  );
  for (const { ack, took } of acks) {
    assert.ok(took < 3600, `answered after ${Math.round(took)} ms`);
    assert.ok(ack.success || /without confirmation/.test(ack.error), ack.error);
  }
  assert.equal(cs.statusChanges.length, 5, 'all five sent');
  assert.ok([...cs.apps.values()].every((a) => a.status === 'exited'));
});

const gladys0 = createFakeGladys();

test('r1: the option unticked while the start queue is busy: stop refused at once', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  await online(ctx);
  let release;
  // A slow read or test holds the queue: the new configuration waits in it.
  const held = ctx.app.enqueue(() => new Promise((r) => (release = r)));
  const saved = ctx.app.configUpdated({ ...ctx.raw, allow_app_stop: false });
  const ack = await press(ctx, 'jellyfin', 'stop');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Stopping apps is off/);
  assert.deepEqual(puts(ctx), []);
  release();
  await within(Promise.all([held, saved]), 'queue');
});

test('r1: another account saved while the queue is busy: commands refused', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  let release;
  const held = ctx.app.enqueue(() => new Promise((r) => (release = r)));
  const saved = ctx.app.configUpdated({ ...ctx.raw, username: 'other' });
  const ack = await press(ctx, 'nextcloud', 'start');
  assert.match(ack.error, /configuration changed/);
  assert.deepEqual(puts(ctx), []);
  release();
  await within(Promise.all([held, saved]), 'queue');
});

test('r1: a mixed compose project (one service stopped) is stopped, confirmed on the project', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  await online(ctx);
  ctx.cs.apps.get('jellyfin').projectStatus = 'exited(1), running(1)';
  const ack = await press(ctx, 'jellyfin', 'stop');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(puts(ctx), ['stop jellyfin']);
  assert.equal(stateOf(ctx, `${ctx.appId('jellyfin')}:running`), 0);
});

test('r1: a mixed compose project is started too; a paused one is refused', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  await online(ctx);
  ctx.cs.apps.get('mosquitto').projectStatus = 'created(1), running(1)';
  const ack = await press(ctx, 'mosquitto', 'start');
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.cs.apps.get('mosquitto').projectStatus, 'running(2)');
  ctx.cs.apps.get('jellyfin').projectStatus = 'exited(1), paused(1)';
  const refused = await press(ctx, 'jellyfin', 'stop');
  assert.match(refused.error, /neither running nor stopped/);
  assert.deepEqual(puts(ctx), ['start mosquitto']);
});

test('r1: real clock, a publication to Gladys of 6 s never delays the ack (under 3.5 s)', async (t) => {
  const cs = await fakeCasaos();
  t.after(() => cs.close());
  const clock = realClock({ speed: 1 });
  t.after(() => clock.close());
  const raw = { url: cs.url, username: USER, password: PASSWORD };
  const gladys = createFakeGladys({ config: raw, devices: createdDevices(gladys0, cs.port) });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new CasaosApp({
    gladys,
    logger,
    store: memoryStore(),
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.shutdown());
  await within(gladys.connect(), 'connect');
  await within(
    (async () => {
      while (!app.online) await new Promise((r) => setTimeout(r, 10));
    })(),
    'online',
  );
  const publish = gladys.publishChangedStates.bind(gladys);
  const slow = [];
  gladys.publishChangedStates = (states) => {
    const p = new Promise((r) => {
      const h = setTimeout(r, 6000);
      slow.push(h);
    }).then(() => publish(states));
    return p;
  };
  t.after(() => slow.forEach((h) => clearTimeout(h)));
  for (const [id, key] of [
    ['nextcloud', 'start'],
    ['jellyfin', 'start'],
  ]) {
    const started = performance.now();
    const ack = await within(
      gladys.fake.setValue(
        { external_id: `ext:test-integration:app:${id}` },
        { external_id: `ext:test-integration:app:${id}:${key}` },
        1,
      ),
      'ack',
    );
    const took = performance.now() - started;
    assert.equal(ack.success, true, ack.error);
    assert.ok(took < 3500, `${id}: answered after ${Math.round(took)} ms`);
  }
});

test('r1: a 5xx on the command says the state is read again, not "nothing done"', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  ctx.cs.replyFor = (r) => (r.method === 'PUT' ? { status: 502, body: {} } : undefined);
  const ack = await press(ctx, 'nextcloud', 'start');
  assert.match(ack.error, /may have done part of it; the state of the app is read again/);
  assert.doesNotMatch(ack.error, /Nothing/);
});
