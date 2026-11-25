// -----------------------------------------------------------------------------
// Gladys devices (pure).
//
//   server  `ext:<selector>:server:<address id>` (`192-168-1-20-80`): CPU,
//           temperatures, memory, system disk, apps running / stopped
//   app     `ext:<selector>:app:<compose app id>`: running, update available
//           (read only), start and stop (buttons)
//
// The id of a compose app (its project name) is stable across updates and
// reinstalls of the same app; the server is keyed by its address. A disk
// temperature feature seen once is kept on the device (a feature dropped from
// a created device loses its history on "Update").
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  APP_ID,
  APP_TYPE,
  DISK_TEMPERATURE,
  FEATURES,
  SERVER_TYPE,
  diskTemperatureKey,
} from './constants.js';

const readOnly = (extra) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});
// No core category lists a percent for a processor, a memory or a disk load:
// `unknown`/`unknown` without a unit (TODO.md, "Decisions").
const percent = (name) =>
  readOnly({ name, category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min: 0, max: 100 });
const temperature = (name) =>
  readOnly({
    name,
    category: C.DEVICE_TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -40,
    max: 150,
  });
const counter = (name) =>
  readOnly({ name, category: C.COUNTER_SENSOR, type: T.SENSOR.INTEGER, min: 0, max: 10_000 });
// Read only, never a switch: the core hands every switch to the voice
// assistants, MCP and the switch scene actions ("turn everything off").
const binary = (name) =>
  readOnly({ name, category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
/** A push button (stop refused unless allowed in the configuration). */
const button = (name) => ({
  name,
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});

export const serverIds = (gladys, addressId) => gladys.externalIds(SERVER_TYPE, addressId);
export const appIds = (gladys, appId) => gladys.externalIds(APP_TYPE, appId);

/**
 * @param {object} gladys
 * @param {{ id: string, base: string }} address
 * @param {Array<{ name: string, label: string }>} disks the disks to show (current and kept)
 */
export function buildServerDevice(gladys, address, disks = []) {
  const ids = serverIds(gladys, address.id);
  const features = [
    [FEATURES.CPU_USAGE, percent('CPU (%)')],
    [FEATURES.CPU_TEMPERATURE, temperature('CPU temperature')],
    [FEATURES.MEMORY_USAGE, percent('Memory (%)')],
    [
      FEATURES.MEMORY_USED,
      readOnly({
        name: 'Memory used',
        category: C.DATA,
        type: T.DATA.SIZE,
        unit: U.MEGABYTE,
        min: 0,
        max: 100_000_000,
      }),
    ],
    [FEATURES.DISK_USAGE, percent('System disk (%)')],
    [
      FEATURES.DISK_FREE,
      readOnly({
        name: 'System disk free',
        category: C.DATA,
        type: T.DATA.SIZE,
        unit: U.GIGABYTE,
        min: 0,
        max: 1_000_000,
      }),
    ],
    [FEATURES.APPS_RUNNING, counter('Apps running')],
    [FEATURES.APPS_STOPPED, counter('Apps stopped')],
    ...disks.map((d) => [diskTemperatureKey(d.name), temperature(`Disk ${d.label}`.slice(0, 100))]),
  ];
  return {
    name: `CasaOS ${address.host}`,
    external_id: ids.device,
    model: 'CasaOS',
    should_poll: false,
    features: features.map(([key, f]) => ({ ...f, external_id: ids.feature(key) })),
  };
}

/** @param {{ id: string, title: string }} app */
export function buildAppDevice(gladys, app) {
  const ids = appIds(gladys, app.id);
  const features = [
    [FEATURES.RUNNING, binary('Running')],
    [FEATURES.UPDATE_AVAILABLE, binary('Update available')],
    [FEATURES.START, button('Start')],
    [FEATURES.STOP, button('Stop')],
  ];
  return {
    name: app.title || app.id,
    external_id: ids.device,
    model: 'CasaOS app',
    should_poll: false,
    features: features.map(([key, f]) => ({ ...f, external_id: ids.feature(key) })),
  };
}

/**
 * What an external id of this integration designates:
 * { kind: 'server', id, feature } | { kind: 'app', id, feature } | null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  for (const [kind, type] of [
    ['server', SERVER_TYPE],
    ['app', APP_TYPE],
  ]) {
    const prefix = gladys.externalId(`${type}:`);
    if (!externalId.startsWith(prefix)) continue;
    const [id, feature, ...rest] = externalId.slice(prefix.length).split(':');
    if (rest.length > 0 || !id) return null;
    if (kind === 'app' && !APP_ID.test(id)) return null;
    if (kind === 'server' && !/^[a-z0-9-]{1,120}$/.test(id)) return null;
    if (feature !== undefined && !/^[a-z0-9_]{1,64}$/.test(feature)) return null;
    return { kind, id, feature: feature ?? null };
  }
  return null;
}

/** The created devices of this integration: { servers: [...], apps: [...] } (device ids parsed). */
export function createdDevices(gladys, devices = gladys.devices) {
  const servers = [];
  const apps = [];
  for (const device of devices ?? []) {
    const parsed = parseExternalId(gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) continue;
    const entry = { ...parsed, externalId: device.external_id, device };
    if (parsed.kind === 'server') servers.push(entry);
    else apps.push(entry);
  }
  return { servers, apps };
}

/** The disk names of the temperature features a created device already has. */
export function keptDiskNames(gladys, device) {
  const names = [];
  for (const feature of device?.features ?? []) {
    const parsed = parseExternalId(gladys, feature?.external_id);
    const match = parsed?.feature ? DISK_TEMPERATURE.exec(parsed.feature) : null;
    if (match) names.push(match[1]);
  }
  return names;
}
