// -----------------------------------------------------------------------------
// The answers of CasaOS turned into values (pure). Strict: a value that is
// not a finite number of the expected range is unknown (null), never 0; a
// temperature of 0 is "not available" (what CasaOS answers without a sensor).
// -----------------------------------------------------------------------------

import { APP_ID, LIMITS } from './constants.js';

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const within = (v, min, max) => (v !== null && v >= min && v <= max ? v : null);
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

/** A label CasaOS gives (app title, disk model): printable, bounded. */
export function cleanLabel(value, max = 80) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^\x20-\x7e\u00a0-\u024f\u0370-\u1fff\u3000-\u9fff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** A temperature in °C, or null (0 = not available, outside -40..150 = not a reading). */
const temperature = (v) => {
  const t = num(v);
  return t === null || t === 0 ? null : round1(within(t, -40, 150));
};

/**
 * GET /v1/sys/utilization -> { cpuUsage, cpuTemperature, memoryUsage,
 * memoryUsedMb, diskUsage, diskFreeGb } (each a number or null).
 */
export function parseUtilization(data) {
  if (!isObject(data)) return null;
  const cpu = isObject(data.cpu) ? data.cpu : {};
  const mem = isObject(data.mem) ? data.mem : {};
  const disk = isObject(data.sys_disk) ? data.sys_disk : {};
  const total = num(mem.total);
  const used = num(mem.used);
  const size = num(disk.size);
  const diskUsed = num(disk.used);
  const avail = num(disk.avail);
  const out = {
    cpuUsage: round1(within(num(cpu.percent), 0, 100)),
    cpuTemperature: temperature(cpu.temperature),
    memoryUsage: round1(within(num(mem.usedPercent), 0, 100)),
    memoryUsedMb:
      used !== null && used >= 0 && (total === null || used <= total)
        ? Math.round(used / 1e6)
        : null,
    diskUsage:
      size !== null && size > 0 && diskUsed !== null && diskUsed >= 0 && diskUsed <= size
        ? round1((diskUsed / size) * 100)
        : null,
    diskFreeGb: avail !== null && avail >= 0 ? round1(avail / 1e9) : null,
  };
  // An answer with nothing readable is not a reading.
  return Object.values(out).some((v) => v !== null) ? out : null;
}

/** GET /v1/disks -> [{ name, label, temperature }] (physical disks, 16 at most). */
export function parseDisks(data) {
  if (!isObject(data) || !Array.isArray(data.disks)) return null;
  const out = [];
  const seen = new Set();
  for (const disk of data.disks) {
    if (out.length >= LIMITS.DISKS) break;
    if (!isObject(disk) || typeof disk.name !== 'string') continue;
    const name = disk.name.toLowerCase();
    if (!/^[a-z0-9]{1,32}$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const model = cleanLabel(disk.model, 40);
    out.push({
      name,
      label: model ? `${name} (${model})` : name,
      temperature: temperature(disk.temperature),
    });
  }
  return out;
}

/**
 * The state of a compose app from the `status` CasaOS gives (the one of
 * Docker Compose): running, stopped (exited, created, dead) or unknown
 * (paused, restarting, removing, "unknown", missing).
 */
export function appState(status) {
  if (typeof status !== 'string') return 'unknown';
  const s = status.trim().toLowerCase();
  if (/^running\b/.test(s)) return 'running';
  if (/^(exited|created|dead)\b/.test(s)) return 'stopped';
  return 'unknown';
}

/** Every image name of an app: its services and its store information. */
function imagesOf(app) {
  const images = [];
  const services = isObject(app?.compose?.services) ? app.compose.services : {};
  for (const service of Object.values(services).slice(0, 50)) {
    if (typeof service?.image === 'string') images.push(service.image);
  }
  const apps = isObject(app?.store_info?.apps) ? app.store_info.apps : {};
  for (const entry of Object.values(apps).slice(0, 50)) {
    if (typeof entry?.image === 'string') images.push(entry.image);
  }
  return images;
}

/** The title CasaOS shows: `en_us` first, then any language, then the id. */
function titleOf(app, id) {
  const titles = [app?.store_info?.title, app?.compose?.['x-casaos']?.title];
  for (const t of titles) {
    if (!isObject(t)) continue;
    const pick = cleanLabel(t.en_us) || cleanLabel(Object.values(t).find((v) => cleanLabel(v)));
    if (pick) return pick;
  }
  return id;
}

/**
 * The app running Gladys Assistant (this integration lives in it): never
 * offered, never started nor stopped. Matched on the id, the title and every
 * image name, without case: a false match only hides an app.
 */
export const isGladysApp = (id, title, images) =>
  [id, title, ...images].some((v) => /gladys/i.test(String(v)));

/** One app of a compose answer, or null when its id is not a compose project name. */
export function parseApp(id, app) {
  if (typeof id !== 'string' || !APP_ID.test(id) || !isObject(app)) return null;
  const title = titleOf(app, id);
  const images = imagesOf(app);
  return {
    id,
    title,
    state: appState(app.status),
    status: cleanLabel(app.status, 30) || 'none',
    updateAvailable: typeof app.update_available === 'boolean' ? app.update_available : null,
    gladys: isGladysApp(id, title, images),
  };
}

/** GET /v2/app_management/compose -> { apps: Map(id -> app), skipped } (100 apps at most). */
export function parseApps(data) {
  if (!isObject(data)) return null;
  const apps = new Map();
  let skipped = 0;
  for (const id of Object.keys(data).sort()) {
    const app = parseApp(id, data[id]);
    if (!app) {
      skipped += 1;
      continue;
    }
    if (apps.size >= LIMITS.APPS) {
      skipped += 1;
      continue;
    }
    apps.set(id, app);
  }
  return { apps, skipped };
}
