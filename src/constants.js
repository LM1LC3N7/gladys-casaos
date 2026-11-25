// -----------------------------------------------------------------------------
// Keys, paths, limits and timings. The manifest keys, the feature keys and the
// external id shapes are stored in user scenes and devices: never rename them
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({ TEST: 'test_connection' });

/** `ext:<selector>:server:<address id>` and `ext:<selector>:app:<compose app id>`. */
export const SERVER_TYPE = 'server';
export const APP_TYPE = 'app';

export const FEATURES = Object.freeze({
  // Server
  CPU_USAGE: 'cpu_usage',
  CPU_TEMPERATURE: 'cpu_temperature',
  MEMORY_USAGE: 'memory_usage',
  MEMORY_USED: 'memory_used',
  DISK_USAGE: 'disk_usage',
  DISK_FREE: 'disk_free',
  APPS_RUNNING: 'apps_running',
  APPS_STOPPED: 'apps_stopped',
  // App
  RUNNING: 'running',
  UPDATE_AVAILABLE: 'update_available',
  START: 'start',
  STOP: 'stop',
});

/** `disk_<name>_temperature`, one per physical disk CasaOS lists (sda, nvme0n1...). */
export const diskTemperatureKey = (name) => `disk_${name}_temperature`;
export const DISK_TEMPERATURE = /^disk_([a-z0-9]{1,32})_temperature$/;

/** The documented API of CasaOS (v1 user, system and storage; v2 app management). */
export const PATHS = Object.freeze({
  LOGIN: '/v1/users/login',
  REFRESH: '/v1/users/refresh',
  UTILIZATION: '/v1/sys/utilization',
  DISKS: '/v1/disks',
  APPS: '/v2/app_management/compose',
  app: (id) => `/v2/app_management/compose/${encodeURIComponent(id)}`,
  appStatus: (id) => `/v2/app_management/compose/${encodeURIComponent(id)}/status`,
});

/**
 * The `success` codes CasaOS-UserService answers (HTTP 400) for a refused
 * login: 10006 "User does not exist", 10013 "User does not exist or password
 * is invalid". Any other 400 is a protocol error, never a refusal.
 */
export const REFUSED_LOGIN_CODES = Object.freeze([10006, 10013]);

/** A compose project name (Docker Compose rules), the app id of CasaOS. */
export const APP_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const POLL_INTERVAL = Object.freeze({ min: 30, max: 3600, default: 60 });

export const LIMITS = Object.freeze({
  APPS: 100,
  DISKS: 16,
  /** Answer size caps (bytes): a CasaOS answer is far below. */
  SMALL_BYTES: 64 * 1024,
  APPS_BYTES: 4 * 1024 * 1024,
  APP_BYTES: 512 * 1024,
  /** POST /state admits 300 states per minute: kept under 250. */
  STATES_PER_MINUTE: 250,
});

export const TIMINGS = Object.freeze({
  connectTimeout: 4_000,
  readTimeout: 10_000,
  /** The list of the apps checks the app store for updates: it may be slow. */
  appsTimeout: 20_000,
  /** No byte for this long during an answer: given up. */
  idleTimeout: 5_000,
  /**
   * CasaOS admits 5 logins, then one a minute, for ALL its clients (the web
   * page of the user included): the integration logs in once, renews its
   * session with the refresh token, and never logs in twice within a minute,
   * across restarts (`lastLoginAt` in /data).
   */
  loginSpacing: 60_000,
  /** The access token of CasaOS lasts 3 h: renewed after 2 h. */
  sessionRenew: 2 * 3600_000,
  /** A 401 on a token this young is not "expired": no renewal. */
  freshToken: 10_000,
  /** The disks (secondary) are read at most this often. */
  disksEvery: 5 * 60_000,
  retryMin: 30_000,
  retryMax: 10 * 60_000,
  pauseMin: 60_000,
  pauseMax: 6 * 3600_000,
  configRetry: [5_000, 15_000, 30_000, 60_000],
  /** /data unreadable: read again on its own timer. */
  dataRetry: 10_000,
  /** Bounded wait for a /data write that must be done before going on. */
  dataWait: 2_000,
  /** Gladys waits 5 s for the ack of a command: answered within this budget. */
  commandBudget: 3_500,
  /** The fresh read before a command must leave this much for the command itself. */
  commandSendRoom: 1_200,
  /** A command is never written later than this before the end of its budget. */
  commandLastByte: 400,
  /** Between two reads that look for the state asked. */
  confirmEvery: 400,
  /** Reads after an unconfirmed command (from the moment it was sent). */
  followUps: [5_000, 20_000],
  testBudget: 25_000,
});

export const STATE_FILE = '/data/casaos-state.json';
