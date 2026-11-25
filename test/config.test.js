// -----------------------------------------------------------------------------
// Configuration, parsing of the answers, the HTTP transport, /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CasaosError, httpRequest, parseAnswer, parseTokens, retryAfterOf } from '../src/casaos.js';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { appState, parseApps, parseDisks, parseUtilization } from '../src/parse.js';
import { credentialsMark, fileStore, normalizeMemory } from '../src/store.js';

test('address: http by default, port 80; https 443; no path, credentials nor special host', () => {
  assert.deepEqual(parseAddress('192.168.1.20'), {
    base: 'http://192.168.1.20:80',
    protocol: 'http:',
    host: '192.168.1.20',
    port: 80,
    id: '192-168-1-20-80',
  });
  assert.equal(parseAddress('https://casa.example.org').base, 'https://casa.example.org:443');
  assert.equal(parseAddress('http://[fd00::2]:8080').base, 'http://[fd00::2]:8080');
  assert.equal(parseAddress('http://casa:8080/').port, 8080);
  for (const bad of [
    '',
    ' ',
    'ftp://x',
    'http://x/casaos',
    'http://x?a=1',
    'http://0.0.0.0',
    'http://239.1.1.1',
    'http://a\nb',
  ]) {
    assert.ok(parseAddress(bad).error, bad);
  }
  assert.equal(parseAddress('http://u:p@x').error, 'credentials');
});

test('credentials: a password without a user name refused; control characters refused', () => {
  assert.equal(normalizeConfig({ url: 'x', password: 'p' }).credentialsError, 'username');
  assert.equal(normalizeConfig({ url: 'x', username: 'u' }).credentialsError, 'password');
  assert.equal(normalizeConfig({ url: 'x' }).credentialsError, 'missing');
  assert.equal(
    normalizeConfig({ url: 'x', username: 'u', password: 'a\r\nb' }).credentialsError,
    'invalid',
  );
  const ok = normalizeConfig({ url: 'x', username: ' u ', password: ' p ' });
  assert.equal(ok.credentialsError, null);
  assert.equal(ok.username, 'u');
  assert.equal(ok.password, ' p ', 'a password is never trimmed');
});

test('options: stop only on a real true; the interval bounded', () => {
  for (const v of [true, 'true'])
    assert.equal(normalizeConfig({ allow_app_stop: v }).allowStop, true);
  for (const v of [false, 'false', 1, '1', 'yes', undefined, null]) {
    assert.equal(normalizeConfig({ allow_app_stop: v }).allowStop, false, String(v));
  }
  assert.equal(normalizeConfig({ poll_interval: 29 }).pollMs, 60_000);
  assert.equal(normalizeConfig({ poll_interval: 30 }).pollMs, 30_000);
  assert.equal(normalizeConfig({ poll_interval: 3601 }).pollMs, 60_000);
  assert.equal(normalizeConfig({ poll_interval: 45.5 }).pollMs, 60_000);
});

test('utilization: strict numbers, 0 °C is no sensor, ranges checked', () => {
  // The real answer of CasaOS 0.4.15 in a container (2026-11-25).
  const real = {
    cpu: {
      model: 'intel',
      num: 6,
      percent: 24.6,
      power: { timestamp: '1', value: '0' },
      temperature: 0,
    },
    mem: {
      available: 763625472,
      free: 205762560,
      total: 3890974720,
      used: 2666397696,
      usedPercent: 68.5,
    },
    net: [],
    sys_disk: { avail: 20665147392, health: true, size: 67422650368, used: 43966566400 },
    sys_usb: [],
  };
  assert.deepEqual(parseUtilization(real), {
    cpuUsage: 24.6,
    cpuTemperature: null,
    memoryUsage: 68.5,
    memoryUsedMb: 2666,
    diskUsage: 65.2,
    diskFreeGb: 20.7,
  });
  const bad = parseUtilization({
    cpu: { percent: '50', temperature: 300 },
    mem: { usedPercent: 101 },
  });
  assert.equal(bad, null, 'nothing readable');
  assert.equal(parseUtilization([]), null);
  assert.equal(parseUtilization({ cpu: { percent: 0 } }).cpuUsage, 0, 'a real 0 % stays 0');
});

test('disks: names checked, 0 °C unknown, bounded', () => {
  const disks = parseDisks({
    disks: [
      { name: 'sda', model: 'QEMU HARDDISK   ', temperature: 0 },
      { name: 'nvme0n1', model: 'X', temperature: 41 },
      { name: '../etc', temperature: 30 },
      { name: 'sda', temperature: 30 },
      ...Array.from({ length: 30 }, (_, i) => ({ name: `sd${i}x`, temperature: 30 })),
    ],
  });
  assert.deepEqual(disks.slice(0, 2), [
    { name: 'sda', label: 'sda (QEMU HARDDISK)', temperature: null },
    { name: 'nvme0n1', label: 'nvme0n1 (X)', temperature: 41 },
  ]);
  assert.equal(disks.length, 16);
  assert.equal(parseDisks({}), null);
});

test('app states: running, stopped, or unknown (never guessed)', () => {
  assert.equal(appState('running'), 'running');
  assert.equal(appState('running(2)'), 'running');
  assert.equal(appState('exited'), 'stopped');
  assert.equal(appState('created'), 'stopped');
  for (const s of ['paused', 'restarting', 'removing', 'unknown', '', null, 1]) {
    assert.equal(appState(s), 'unknown', String(s));
  }
});

test('apps: ids checked, Gladys flagged by id, title or image, 100 at most', () => {
  const data = {
    jellyfin: {
      status: 'running',
      store_info: { title: { en_us: 'Jellyfin' } },
      update_available: true,
    },
    'bad id': { status: 'running' },
    ha: { status: 'exited', compose: { services: { x: { image: 'gladysassistant/gladys:v4' } } } },
    g: { status: 'running', store_info: { title: { fr_fr: 'Mon Gladys' } } },
    __proto__x: { status: 'running' },
  };
  const { apps, skipped } = parseApps(data);
  assert.deepEqual([...apps.keys()], ['g', 'ha', 'jellyfin']);
  assert.equal(skipped, 2);
  assert.equal(apps.get('jellyfin').updateAvailable, true);
  assert.equal(apps.get('jellyfin').gladys, false);
  assert.equal(apps.get('ha').gladys, true);
  assert.equal(apps.get('g').gladys, true);
  assert.equal(apps.get('g').title, 'Mon Gladys');
  const many = Object.fromEntries(
    Array.from({ length: 150 }, (_, i) => [`a${i}`, { status: 'running' }]),
  );
  assert.equal(parseApps(many).apps.size, 100);
});

test('the envelope: v1 needs success 200; v2 needs data; redirect, 429 and 5xx typed', () => {
  assert.deepEqual(
    parseAnswer({ status: 200, body: '{"success":200,"data":{"a":1}}' }, { v1: true }),
    { a: 1 },
  );
  assert.throws(
    () => parseAnswer({ status: 200, body: '{"success":4000,"data":{}}' }, { v1: true }),
    /not an answer/,
  );
  assert.throws(() => parseAnswer({ status: 200, body: '<html>' }), /not an answer/);
  assert.throws(
    () => parseAnswer({ status: 302, body: '' }),
    (e) => e.kind === 'redirect',
  );
  assert.throws(
    () => parseAnswer({ status: 429, headers: { 'retry-after': '90' }, body: '' }),
    (e) => e.status === 429 && e.retryAfter === 90_000,
  );
  assert.equal(
    retryAfterOf('Wed, 25 Nov 2026 11:10:00 GMT', 'Wed, 25 Nov 2026 11:09:00 GMT'),
    60_000,
  );
  assert.equal(
    retryAfterOf('Wed, 25 Nov 2026 11:10:00 GMT', undefined),
    undefined,
    'no server date: default',
  );
  assert.throws(() => parseTokens({ token: { access_token: 'short' } }), /no token/);
});

async function server(t, handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  srv.closeAllConnections && t.after(() => srv.closeAllConnections());
  const port = srv.address().port;
  return { protocol: 'http:', host: '127.0.0.1', port, base: `http://127.0.0.1:${port}` };
}

test('transport: an answer above the cap is cut before it is all read', async (t) => {
  let written = 0;
  const address = await server(t, (req, res) => {
    res.writeHead(200);
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    const pump = () => {
      while (written < 10 * 1024 * 1024 && res.write(chunk)) written += chunk.length;
      if (written < 10 * 1024 * 1024) res.once('drain', pump);
    };
    pump();
  });
  await assert.rejects(
    httpRequest(address, { path: '/', maxBytes: 64 * 1024 }),
    (e) => e.kind === 'size',
  );
  assert.ok(written < 10 * 1024 * 1024);
});

test('transport: a silent server times out; nothing sent when beforeSend throws', async (t) => {
  let got = 0;
  const address = await server(t, (req) => {
    got += 1;
    req.resume();
  });
  await assert.rejects(
    httpRequest(address, { path: '/', timeout: 300 }),
    (e) => e.kind === 'timeout' && e.sent,
  );
  await assert.rejects(
    httpRequest(address, {
      path: '/',
      beforeSend: () => {
        throw new Error('option off');
      },
    }),
    /option off/,
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(got, 1);
});

test('transport: connection refused is "not sent"; the token goes in Authorization as is', async (t) => {
  let seen;
  const address = await server(t, (req, res) => {
    seen = req.headers.authorization;
    res.end('{}');
  });
  await httpRequest(address, { path: '/', token: 'abc.def' });
  assert.equal(seen, 'abc.def');
  await assert.rejects(
    httpRequest({ ...address, port: 1 }, { path: '/' }),
    (e) => e instanceof CasaosError && e.kind === 'network' && !e.sent,
  );
  await assert.rejects(
    httpRequest(address, { path: '/', token: 'a\nb' }),
    (e) => e.kind === 'format' && !e.sent,
  );
});

test('/data: missing = empty, unreadable = an error (never empty), dates in the future not trusted', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'casaos-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  assert.equal(await fileStore(path).load(), null);
  await writeFile(path, '{oops');
  await assert.rejects(fileStore(path).load(), /not JSON/);
  await fileStore(path).save({ lastReadAt: 5 });
  assert.deepEqual(await fileStore(path).load(), { lastReadAt: 5 });
  await assert.rejects(fileStore(dir).load(), /not a regular file/);
  const now = 1_000_000;
  const m = normalizeMemory(
    {
      lastLoginAt: now + 999,
      lastReadAt: now + 5,
      pausedUntil: now + 99 * 3600_000,
      refused: { salt: 'zz', mark: 1 },
    },
    now,
  );
  assert.equal(m.lastLoginAt, now);
  assert.equal(m.lastReadAt, now);
  assert.equal(m.pausedUntil, now + 6 * 3600_000);
  assert.equal(m.refused, null);
});

test('the refusal mark: 6 bits, a brute force finds many passwords for one mark', () => {
  const salt = '0123456789abcdef';
  const mark = credentialsMark(salt, 'http://x:80', 'admin', 'secret');
  assert.ok(mark >= 0 && mark < 64);
  let matches = 0;
  for (let i = 0; i < 6400; i += 1) {
    if (credentialsMark(salt, 'http://x:80', 'admin', `guess${i}`) === mark) matches += 1;
  }
  assert.ok(matches > 50, `${matches} candidates share the mark: it never tells the password`);
});

// --- The answers of a real CasaOS 0.4.15 (dockurr/casa, 2026-11-25) -------------------------

const fixture = async (name) =>
  JSON.parse(
    await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
    ),
  );

test('real answers: utilization, disks and the apps read as expected', async () => {
  const util = parseUtilization(
    parseAnswer({ status: 200, body: JSON.stringify(await fixture('utilization')) }, { v1: true }),
  );
  assert.equal(util.cpuTemperature, null, 'a container has no sensor: 0 -> unknown');
  assert.equal(util.memoryUsage, 71.9);
  const disks = parseDisks(
    parseAnswer({ status: 200, body: JSON.stringify(await fixture('disks')) }, { v1: true }),
  );
  assert.deepEqual(disks, [{ name: 'sda', label: 'sda (QEMU HARDDISK)', temperature: null }]);
  const { apps } = parseApps(
    parseAnswer({ status: 200, body: JSON.stringify(await fixture('compose')) }),
  );
  assert.deepEqual(
    [...apps.values()].map((a) => [a.id, a.title, a.state, a.updateAvailable, a.gladys]),
    [
      ['duo', 'Duo test', 'running', false, false],
      ['whoami', 'Whoami test', 'running', false, false],
    ],
  );
  const stopped = parseApps(
    parseAnswer({ status: 200, body: JSON.stringify(await fixture('compose-stopped')) }),
  );
  assert.equal(stopped.apps.get('whoami').state, 'stopped');
});
