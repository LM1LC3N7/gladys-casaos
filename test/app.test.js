// -----------------------------------------------------------------------------
// Reads, Discovery, states, session and failures, against the simulated
// CasaOS and the SDK's fake Gladys (virtual timers, real loopback network).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { online, setup, stateOf, statusText, until, waitFor, within } from './helpers/setup.js';

const feature = (id, key) => `${id}:${key}`;

test('first read: Discovery (server + apps, never Gladys), states, status', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  const ids = ctx.gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.deepEqual(ids, [
    ctx.serverId,
    ctx.appId('jellyfin'),
    ctx.appId('mosquitto'),
    ctx.appId('nextcloud'),
  ]);
  assert.ok(!ids.some((id) => /gladys/.test(id)), 'the Gladys app is never offered');
  const s = ctx.serverId;
  assert.equal(stateOf(ctx, feature(s, 'cpu_usage')), 12.5);
  assert.equal(stateOf(ctx, feature(s, 'cpu_temperature')), 48);
  assert.equal(stateOf(ctx, feature(s, 'memory_usage')), 31.2);
  assert.equal(stateOf(ctx, feature(s, 'memory_used')), 2500);
  assert.equal(stateOf(ctx, feature(s, 'disk_usage')), 60);
  assert.equal(stateOf(ctx, feature(s, 'disk_free')), 200);
  assert.equal(stateOf(ctx, feature(s, 'apps_running')), 3, 'Gladys counted: it runs');
  assert.equal(stateOf(ctx, feature(s, 'apps_stopped')), 1);
  assert.equal(stateOf(ctx, feature(s, 'disk_sda_temperature')), 35);
  assert.equal(stateOf(ctx, feature(s, 'disk_sdb_temperature')), undefined, '0 = no sensor');
  assert.equal(stateOf(ctx, feature(ctx.appId('jellyfin'), 'running')), 1);
  assert.equal(stateOf(ctx, feature(ctx.appId('nextcloud'), 'running')), 0);
  assert.equal(stateOf(ctx, feature(ctx.appId('nextcloud'), 'update_available')), 1);
  assert.match(statusText(ctx), /Connected to CasaOS: 3 app\(s\) running, 1 stopped/);
  assert.equal(ctx.cs.count('POST /v1/users/login'), 1);
  // Neither the password nor a token in the logs, the status or /data.
  const seen = JSON.stringify([ctx.logs, ctx.gladys.fake.connectionStatus, ctx.store.data]);
  assert.doesNotMatch(seen, /test-password-not-real|access\.x|refresh\.x/);
});

test('the period: one read per interval, measured from the start of the last', async (t) => {
  const ctx = await setup(t, { config: { poll_interval: 30 } });
  await online(ctx);
  const reads = () => ctx.cs.count('GET /v1/sys/utilization');
  assert.equal(reads(), 1);
  await ctx.clock.advance(29_000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reads(), 1, 'not before 30 s');
  await until(ctx, () => reads() === 2, 'second read', { step: 1000 });
  assert.ok(ctx.clock.elapsed <= 31_500, `second read at ${ctx.clock.elapsed}`);
  assert.equal(ctx.cs.count('POST /v1/users/login'), 1, 'the session is kept');
});

test('a value CasaOS cannot give is unknown, never 0', async (t) => {
  const ctx = await setup(t, {
    server: {
      utilization: {
        cpu: { percent: 'x', temperature: 0 },
        mem: { usedPercent: null, used: -1, total: 8e9 },
        sys_disk: { size: 0, used: 1, avail: null },
      },
    },
  });
  await online(ctx);
  for (const key of ['cpu_usage', 'cpu_temperature', 'memory_usage', 'disk_usage', 'disk_free']) {
    assert.equal(stateOf(ctx, feature(ctx.serverId, key)), undefined, key);
  }
});

test('the session is renewed with the refresh token, never a second login', async (t) => {
  const ctx = await setup(t, { config: { poll_interval: 3600 } });
  await online(ctx);
  await until(ctx, () => ctx.cs.count('POST /v1/users/refresh') === 1, 'refresh', {
    step: 600_000,
  });
  assert.equal(ctx.cs.count('POST /v1/users/login'), 1);
});

test('an expired token (401) renews the session once and reads again', async (t) => {
  const ctx = await setup(t, { config: { poll_interval: 60 } });
  await online(ctx);
  ctx.cs.tokens.clear();
  await until(ctx, () => ctx.cs.count('GET /v1/sys/utilization') >= 3, 'reads', { step: 1000 });
  assert.equal(ctx.cs.count('POST /v1/users/refresh'), 1);
  assert.equal(ctx.cs.count('POST /v1/users/login'), 1);
  assert.ok(ctx.app.online);
});

test('a 401 on a brand new token: an error of the read, never a renewal loop nor a refusal', async (t) => {
  const ctx = await setup(t, { server: { revoked: true } });
  await until(ctx, () => /does not answer: HTTP 401/.test(statusText(ctx)), 'failed');
  assert.equal(ctx.cs.count('POST /v1/users/refresh'), 0);
  assert.equal(ctx.cs.count('POST /v1/users/login'), 1);
  assert.ok(!ctx.app.blocked);
});

test('a pause kept in /data holds at start: nothing sent before its end', async (t) => {
  const store = memoryStore({ pausedUntil: Date.UTC(2026, 0, 1) + 600_000 });
  const ctx = await setup(t, { store });
  await waitFor(() => /asked to wait/.test(statusText(ctx)), 'paused');
  await ctx.clock.advance(590_000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctx.cs.requests.length, 0);
  await until(ctx, () => ctx.app.online, 'online after', { step: 5_000 });
});

test('a refused password: final, kept in /data (mark only), lifted by a new save', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, config: { password: 'wrong-one' } });
  await until(ctx, () => /refused/.test(statusText(ctx)), 'refused');
  assert.equal(ctx.cs.count('POST /v1/users/login'), 1);
  const text = JSON.stringify(store.data);
  assert.doesNotMatch(text, /wrong-one|test-password/);
  assert.ok(Number.isInteger(store.data.refused.mark) && store.data.refused.mark < 64);
  // Nothing tried again alone: neither by time nor by a reconnection to Gladys.
  await ctx.clock.advance(3600_000);
  await ctx.app.connectedWith(async () => ctx.raw);
  await ctx.clock.advance(120_000);
  assert.equal(ctx.cs.count('POST /v1/users/login'), 1);
  // The user saves the right password: tried, accepted, the mark erased.
  await within(ctx.app.configUpdated({ ...ctx.raw, password: 'test-password-not-real' }));
  await until(ctx, () => ctx.app.online, 'online', { step: 1000 });
  assert.equal(store.data.refused, null);
});

test('a restart with the refused account does not try it (mark in /data)', async (t) => {
  const first = memoryStore();
  const a = await setup(t, { store: first, config: { password: 'wrong-one' } });
  await until(a, () => /refused/.test(statusText(a)), 'refused');
  await a.app.shutdown();
  const b = await setup(t, { reuse: a.cs, memory: first.data, config: { password: 'wrong-one' } });
  await until(b, () => /refused/.test(statusText(b)), 'refused at start');
  assert.equal(b.cs.count('POST /v1/users/login'), 1, 'only the first one');
});

test('a 400 that is not a refusal (protocol) is retried, never final', async (t) => {
  const ctx = await setup(t, {
    server: {
      replyFor: (r) =>
        r.path === '/v1/users/login' ? { status: 400, body: { success: 4000 } } : undefined,
    },
  });
  await until(ctx, () => /does not answer/.test(statusText(ctx)), 'failed');
  assert.ok(!ctx.app.blocked);
  assert.equal(ctx.store.data.refused, null);
});

test('never two logins within a minute, across restarts (lastLoginAt in /data)', async (t) => {
  const store = memoryStore();
  const a = await setup(t, { store, config: { poll_interval: 30 } });
  await online(a);
  await a.app.shutdown();
  const b = await setup(t, {
    memory: store.data,
    clock: a.clock,
    config: { poll_interval: 30 },
  });
  await until(b, () => /one login a minute/.test(statusText(b)), 'login wait', { step: 5000 });
  assert.equal(b.cs.count('POST /v1/users/login'), 0);
  await until(b, () => b.app.online, 'online after the minute', { step: 5000 });
  assert.equal(b.cs.count('POST /v1/users/login'), 1);
  assert.ok(b.clock.elapsed >= 60_000);
});

test('a restart never reads sooner than the interval (lastReadAt in /data)', async (t) => {
  const store = memoryStore();
  const a = await setup(t, { store, config: { poll_interval: 300 } });
  await online(a);
  await a.app.shutdown();
  await a.clock.advance(90_000);
  const b = await setup(t, { memory: store.data, clock: a.clock, config: { poll_interval: 300 } });
  await b.clock.advance(100_000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(b.cs.count('GET /v1/sys/utilization'), 0);
  await until(b, () => b.cs.count('GET /v1/sys/utilization') === 1, 'read', { step: 10_000 });
});

test('429: a pause of every path (kept in /data), Retry-After honoured within bounds', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  ctx.cs.replyFor = (r) =>
    r.path === '/v1/sys/utilization'
      ? { status: 429, body: {}, headers: { 'Retry-After': '120' } }
      : undefined;
  await until(ctx, () => /asked to wait/.test(statusText(ctx)), 'paused', { step: 10_000 });
  assert.ok(ctx.store.data.pausedUntil > 0);
  const before = ctx.cs.requests.length;
  await ctx.clock.advance(100_000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctx.cs.requests.length, before, 'nothing during the pause');
  const ack = await within(ctx.press('jellyfin', 'start'), 'ack');
  assert.equal(ack.success, false);
  assert.equal(ctx.cs.requests.length, before, 'a command waits too');
});

test('CasaOS unreachable: retried with a growing delay; status says so', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  await ctx.cs.close();
  await until(ctx, () => /does not answer/.test(statusText(ctx)), 'failed', { step: 5_000 });
  assert.equal(ctx.app.online, false);
  assert.ok(ctx.app.retryDelay > TIMINGS.retryMin);
});

test('a failing disk list (secondary, 403) blocks nothing; the system is read', async (t) => {
  const ctx = await setup(t, {
    server: {
      replyFor: (r) => (r.path === '/v1/disks' ? { status: 403, body: {} } : undefined),
    },
  });
  await online(ctx);
  assert.equal(stateOf(ctx, feature(ctx.serverId, 'cpu_usage')), 12.5);
  assert.ok(!ctx.app.blocked);
  assert.ok(ctx.app.disksDelay > TIMINGS.disksEvery);
});

test('the apps fail, the system is read: connected, the status says what is missing', async (t) => {
  const ctx = await setup(t, {
    server: {
      replyFor: (r) =>
        r.path === '/v2/app_management/compose' ? { status: 500, body: {} } : undefined,
    },
  });
  await online(ctx);
  assert.match(statusText(ctx), /apps could not be read/);
  assert.equal(stateOf(ctx, feature(ctx.appId('jellyfin'), 'running')), undefined);
});

test('another web server is never taken for CasaOS', async (t) => {
  const ctx = await setup(t, {
    server: {
      replyFor: (r) =>
        r.path === '/v1/users/login'
          ? { status: 200, body: '<html>router</html>', headers: { 'Content-Type': 'text/html' } }
          : undefined,
    },
  });
  await until(ctx, () => /not an answer of CasaOS/.test(statusText(ctx)), 'failed');
  assert.equal(ctx.app.online, false);
});

test('a reconnection to Gladys: no read, no login; status and Discovery sent again', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  const reads = ctx.cs.requests.length;
  const sent = [];
  const original = ctx.gladys.setConnectionStatus.bind(ctx.gladys);
  ctx.gladys.setConnectionStatus = (...a) => (sent.push(a), original(...a));
  const published = [];
  const publish = ctx.gladys.publishDiscoveredDevices.bind(ctx.gladys);
  ctx.gladys.publishDiscoveredDevices = (d) => (published.push(d.length), publish(d));
  await ctx.app.connectedWith(async () => ctx.raw);
  assert.equal(ctx.cs.requests.length, reads);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], true);
  assert.deepEqual(published, [4]);
});

test('getConfig() failing in `connected`: retried, spaced, then the start goes on', async (t) => {
  const ctx = await setup(t, { config: { password: 'another' } });
  await until(ctx, () => /refused/.test(statusText(ctx)), 'refused');
  let fails = 1;
  const getConfig = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('core busy');
    }
    return { ...ctx.raw, password: 'test-password-not-real', url: 'http://127.0.0.1:1' };
  };
  await ctx.app.connectedWith(getConfig);
  assert.match(statusText(ctx), /could not be read from Gladys: next try in 5 s/);
  await until(ctx, () => /does not answer/.test(statusText(ctx)), 'started with it', {
    step: 1000,
  });
});

test('/data unreadable: nothing learnt over it, read again every 10 s', async (t) => {
  const store = memoryStore({ lastReadAt: 1 });
  store.failLoad = true;
  const ctx = await setup(t, { store });
  await waitFor(() => /cannot be read/.test(statusText(ctx)), 'data status');
  assert.equal(ctx.cs.requests.length, 0);
  store.failLoad = false;
  await until(ctx, () => ctx.app.online, 'online', { step: 2_000 });
  assert.ok(store.loads >= 2);
});

test('/data that hangs: bounded, never a wait without end', async (t) => {
  const store = memoryStore();
  store.hangLoad = true;
  const ctx = await setup(t, { store, connect: false });
  const connected = ctx.gladys.connect();
  await until(ctx, () => /cannot be read/.test(statusText(ctx)), 'data status', { step: 500 });
  await within(connected, 'connect');
});

test('the test button: a recent read is told, never doubled', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  const reads = ctx.cs.count('GET /v1/sys/utilization');
  const answer = await within(ctx.app.testConnection(), 'test');
  assert.match(answer.en, /last read: 3 app/);
  assert.equal(ctx.cs.count('GET /v1/sys/utilization'), reads);
});

test('the scan publishes what is known, without a read', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  const reads = ctx.cs.requests.length;
  await ctx.app.scan();
  assert.equal(ctx.cs.requests.length, reads);
});

test('a created device gets values only when the last read is fresh', async (t) => {
  const ctx = await setup(t, { create: false });
  await online(ctx);
  const [server] = ctx.gladys.fake.discoveredDevices;
  await ctx.app.deviceCreated({ ...server, features: server.features });
  ctx.gladys.devices = [server];
  await ctx.app.deviceCreated(server);
  assert.equal(stateOf(ctx, `${ctx.serverId}:cpu_usage`), 12.5);
});

test('nothing runs after shutdown (no timer, no request)', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  await ctx.app.shutdown();
  const before = ctx.cs.requests.length;
  await ctx.clock.advance(7200_000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctx.cs.requests.length, before);
  assert.equal(ctx.clock.pending, 0, 'no timer left');
});

test('r1: /data not writable: no login (CasaOS counts them), the status says so', async (t) => {
  const store = memoryStore();
  store.failSave = true;
  const ctx = await setup(t, { store });
  await until(ctx, () => /cannot be written/.test(statusText(ctx)), 'status', { step: 1000 });
  assert.equal(ctx.cs.count('POST /v1/users/login'), 0);
  store.failSave = false;
  await until(ctx, () => ctx.app.online, 'online once writable', { step: 2000 });
  assert.equal(ctx.cs.count('POST /v1/users/login'), 1);
});

test('r1: unknown values are never published as 0 (update flag, memory, counts)', async (t) => {
  const ctx = await setup(t, {
    server: {
      utilization: {
        cpu: { percent: 5, temperature: 0 },
        mem: { total: 0, used: 0, usedPercent: 0 },
        sys_disk: {},
      },
    },
  });
  for (const a of ctx.cs.apps.values()) {
    a.status = 'unknown';
    a.update = false;
  }
  await online(ctx);
  assert.equal(stateOf(ctx, `${ctx.serverId}:cpu_usage`), 5);
  for (const key of ['memory_usage', 'memory_used', 'apps_running', 'apps_stopped']) {
    assert.equal(stateOf(ctx, `${ctx.serverId}:${key}`), undefined, key);
  }
  for (const key of ['running', 'update_available']) {
    assert.equal(stateOf(ctx, `${ctx.appId('nextcloud')}:${key}`), undefined, key);
  }
});

test('r1: a status published after the configuration changed is never an old one', async (t) => {
  const ctx = await setup(t);
  await online(ctx);
  const sent = [];
  const original = ctx.gladys.setConnectionStatus.bind(ctx.gladys);
  ctx.gladys.setConnectionStatus = (c, m) => (sent.push(m?.en), original(c, m));
  const publish = ctx.gladys.publishChangedStates.bind(ctx.gladys);
  let changed = false;
  ctx.gladys.publishChangedStates = async (states) => {
    if (!changed) {
      changed = true;
      // The user saves another address while the states go to Gladys.
      await ctx.app.configUpdated({ ...ctx.raw, url: 'http://127.0.0.1:1' });
    }
    return publish(states);
  };
  ctx.gladys.forgetPublishedStates();
  ctx.app.lastReadMono = -Infinity;
  await ctx.app.read(ctx.app.generation);
  await until(ctx, () => /does not answer/.test(statusText(ctx)), 'new address status', {
    step: 1000,
  });
  const after = sent.slice(sent.findIndex((m) => /Connecting/.test(m ?? '')));
  assert.ok(!after.some((m) => /^Connected/.test(m ?? '')), after.join(' | '));
});

test('r1: a created device never gets a disk temperature older than the interval', async (t) => {
  const ctx = await setup(t, { create: false, config: { poll_interval: 60 } });
  await online(ctx);
  const [server] = ctx.gladys.fake.discoveredDevices;
  // 2 min later: the system was read again, the disks (every 5 min) were not.
  await until(ctx, () => ctx.app.systemMono >= 119_000, 'third read applied', { step: 5_000 });
  ctx.gladys.devices = [server];
  await ctx.app.deviceCreated(server);
  assert.equal(stateOf(ctx, `${ctx.serverId}:cpu_usage`), 12.5);
  assert.equal(stateOf(ctx, `${ctx.serverId}:disk_sda_temperature`), undefined);
});
