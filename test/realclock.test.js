// -----------------------------------------------------------------------------
// The real clock, sped up, against the simulated CasaOS: the period of the
// reads and of the follow-ups of a command, measured (wide margins: a timer is
// late under load, never early). The app is stopped in t.after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CasaosApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { PASSWORD, USER, fakeCasaos } from './helpers/fakeCasaos.js';
import { createdDevices, waitFor, within } from './helpers/setup.js';

async function start(t, { speed = 30, config = {}, server = {} } = {}) {
  const cs = await fakeCasaos(server);
  t.after(() => cs.close());
  const clock = realClock({ speed });
  t.after(() => clock.close());
  const raw = { url: cs.url, username: USER, password: PASSWORD, poll_interval: 30, ...config };
  const gladys = createFakeGladys({
    config: raw,
    devices: createdDevices(createFakeGladys(), cs.port),
  });
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
  return { cs, clock, gladys, app };
}

test('real clock x30: the reads come at the interval (30 s), measured', async (t) => {
  const { cs, clock, gladys, app } = await start(t);
  const spy = spyOn(app, 'readOnce', clock);
  t.after(() => spy.restore());
  await within(gladys.connect(), 'connect');
  const gaps = await measurePeriod(spy, { count: 4, period: 30_000 });
  assert.equal(gaps.length, 3);
  assert.equal(cs.count('POST /v1/users/login'), 1);
});

test('real clock x10: an unconfirmed stop is read again 5 s and 20 s after it', async (t) => {
  const { cs, gladys, app } = await start(t, {
    speed: 10,
    config: { allow_app_stop: true },
    server: { applyDelayMs: -1 },
  });
  await within(gladys.connect(), 'connect');
  await waitFor(() => app.online, 'online', 6000);
  const id = 'ext:test-integration:app:jellyfin';
  const reads = () => cs.requests.filter((r) => r.path === '/v2/app_management/compose/jellyfin');
  const pressedAt = performance.now();
  const ack = await within(
    gladys.fake.setValue({ external_id: id }, { external_id: `${id}:stop` }, 1),
    'ack',
  );
  assert.match(ack.error, /without confirmation/);
  const before = reads().length;
  await waitFor(() => reads().length >= before + 2, 'two follow-ups', 6000);
  const took = (performance.now() - pressedAt) * 10;
  assert.ok(took >= 19_000 && took < 30_000, `second follow-up after ${Math.round(took)} ms`);
  await waitFor(() => !app.pending.has('jellyfin'), 'wait over', 2000);
  assert.equal(cs.statusChanges.length, 1, 'never sent again');
});
