// -----------------------------------------------------------------------------
// A simulated CasaOS on 127.0.0.1, after the answers of a real CasaOS 0.4.15
// (dockurr/casa, recorded 2026-11-25, tokens removed): login and refresh
// (5 logins then one a minute, like CasaOS-UserService), utilization, disks,
// the compose apps and their status, applied in the background like
// CasaOS-AppManagement ("being changed asynchronously").
// -----------------------------------------------------------------------------

import http from 'node:http';

export const USER = 'admin';
export const PASSWORD = 'test-password-not-real';

const app = (id, title, image, status, update = false) => ({
  id,
  title,
  image,
  status,
  update,
});

export const defaultApps = () => [
  app('jellyfin', 'Jellyfin', 'linuxserver/jellyfin:10.9', 'running'),
  app('nextcloud', 'Nextcloud', 'nextcloud:29', 'exited', true),
  app('mosquitto', 'Mosquitto', 'eclipse-mosquitto:2', 'running'),
  app('gladys', 'Gladys Assistant', 'gladysassistant/gladys:v4', 'running'),
];

const composeOf = (a) => ({
  compose: {
    name: a.id,
    services: { [a.id]: { image: a.image, container_name: a.id } },
    'x-casaos': { main: a.id, title: { en_us: a.title } },
  },
  is_uncontrolled: false,
  status: a.status,
  store_info: {
    apps: { [a.id]: { image: a.image } },
    main: a.id,
    title: { en_us: a.title },
  },
  update_available: a.update,
});

export async function fakeCasaos(options = {}) {
  let seq = 0;
  const srv = {
    apps: new Map(defaultApps().map((a) => [a.id, a])),
    utilization: {
      cpu: {
        model: 'intel',
        num: 4,
        percent: 12.5,
        power: { timestamp: '1795604781', value: '0' },
        temperature: 48,
      },
      mem: { available: 6e9, free: 2e9, total: 8e9, used: 2.5e9, usedPercent: 31.2 },
      net: [],
      sys_disk: { avail: 200e9, health: true, size: 500e9, used: 300e9 },
      sys_usb: [],
    },
    disks: [
      { name: 'sda', model: 'Samsung SSD 870', temperature: 35, health: 'true' },
      { name: 'sdb', model: 'WDC WD40', temperature: 0, health: 'true' },
    ],
    username: USER,
    password: PASSWORD,
    /** Delay before a status change shows (ms of real time). */
    applyDelayMs: 0,
    /** Latency of every answer (ms), or a function of the request. */
    latencyMs: 0,
    /** A function (req) -> { status, body, headers } | undefined to replace an answer. */
    replyFor: undefined,
    requests: [],
    loginBudget: 5,
    tokens: new Set(),
    refreshTokens: new Set(),
    revoked: false,
    statusChanges: [],
    count(prefix) {
      return this.requests.filter((r) => `${r.method} ${r.path}`.startsWith(prefix)).length;
    },
    ...options,
  };
  const sockets = new Set();
  const token = (kind) => `${kind}.${'x'.repeat(20)}.${(seq += 1)}`;
  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(text);
  };

  const handle = (req, res, body) => {
    const r = { method: req.method, path: req.url, auth: req.headers.authorization, body };
    srv.requests.push(r);
    const custom = srv.replyFor?.(r);
    if (custom) {
      send(res, custom.status, custom.body ?? '', custom.headers);
      return;
    }
    let json;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    if (req.method === 'POST' && req.url === '/v1/users/login') {
      if (srv.loginBudget <= 0) {
        send(res, 429, { success: 10014, message: 'Too many login requests' });
        return;
      }
      srv.loginBudget -= 1;
      if (json?.username !== srv.username) {
        send(res, 400, { success: 10006, message: 'User does not exist', data: null });
        return;
      }
      if (json?.password !== srv.password) {
        send(res, 400, {
          success: 10013,
          message: 'User does not exist or password is invalid',
          data: null,
        });
        return;
      }
      const access = token('access');
      const refresh = token('refresh');
      srv.tokens.add(access);
      srv.refreshTokens.add(refresh);
      send(res, 200, {
        success: 200,
        message: 'ok',
        data: {
          token: { access_token: access, refresh_token: refresh, expires_at: 1795615576 },
          user: { id: 1, username: srv.username, role: 'admin' },
        },
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/users/refresh') {
      if (!srv.refreshTokens.has(json?.refresh_token)) {
        send(res, 401, { success: 20006, message: 'Verification failure' });
        return;
      }
      const access = token('access');
      const refresh = token('refresh');
      srv.tokens.add(access);
      srv.refreshTokens.add(refresh);
      send(res, 200, {
        success: 200,
        message: 'ok',
        data: { access_token: access, refresh_token: refresh, expires_at: 1795615704 },
      });
      return;
    }
    if (srv.revoked || !srv.tokens.has(req.headers.authorization)) {
      send(res, 401, { message: 'Unauthorized' });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/sys/utilization') {
      send(res, 200, { success: 200, message: 'ok', data: srv.utilization });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/disks') {
      send(res, 200, { success: 200, message: 'ok', data: { avail: [], disks: srv.disks } });
      return;
    }
    if (req.method === 'GET' && req.url === '/v2/app_management/compose') {
      const data = {};
      for (const a of srv.apps.values()) data[a.id] = composeOf(a);
      send(res, 200, { data });
      return;
    }
    const one = /^\/v2\/app_management\/compose\/([^/]+)$/.exec(req.url);
    if (req.method === 'GET' && one) {
      const a = srv.apps.get(decodeURIComponent(one[1]));
      if (!a) {
        send(res, 404, { message: `compose app \`${one[1]}\` not found` });
        return;
      }
      if (!/application\/json/.test(req.headers.accept ?? '')) {
        // CasaOS answers the compose YAML for any other Accept.
        res.writeHead(200, { 'Content-Type': 'application/yaml' });
        res.end(`name: ${a.id}\n`);
        return;
      }
      const { update_available: _drop, ...rest } = composeOf(a);
      // The route of one app gives the status of the whole compose project.
      rest.status = a.projectStatus ?? a.status;
      send(res, 200, { message: '!! JSON format is for debugging purpose only', data: rest });
      return;
    }
    const status = /^\/v2\/app_management\/compose\/([^/]+)\/status$/.exec(req.url);
    if (req.method === 'PUT' && status) {
      const a = srv.apps.get(decodeURIComponent(status[1]));
      if (!a) {
        send(res, 404, { message: 'not found' });
        return;
      }
      if (!['start', 'stop', 'restart'].includes(json)) {
        send(res, 400, { message: 'request body has an error' });
        return;
      }
      srv.statusChanges.push([a.id, json]);
      const apply = () => {
        a.status = json === 'stop' ? 'exited' : 'running';
        if (a.projectStatus) a.projectStatus = json === 'stop' ? 'exited(2)' : 'running(2)';
      };
      if (srv.applyDelayMs > 0) setTimeout(apply, srv.applyDelayMs);
      else if (srv.applyDelayMs === 0) apply();
      // applyDelayMs < 0: never applied.
      send(res, 200, { message: 'compose app status is being changed asynchronously' });
      return;
    }
    send(res, 404, { message: 'Not Found' });
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const r = { method: req.method, path: req.url };
      const latency = typeof srv.latencyMs === 'function' ? srv.latencyMs(r) : srv.latencyMs;
      if (latency === Infinity) {
        srv.requests.push({ ...r, body, silent: true });
        return;
      }
      if (latency > 0) setTimeout(() => handle(req, res, body), latency);
      else handle(req, res, body);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  srv.port = server.address().port;
  srv.url = `http://127.0.0.1:${srv.port}`;
  srv.close = () =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return srv;
}
