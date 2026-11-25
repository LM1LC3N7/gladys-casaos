// Mutation checks of the guards: each mutant breaks one guard in a copy of the
// repository and must make a test fail (never hang: the whole process group is
// killed at the deadline). One at a time. Usage, from the repository:
//   memcap node scripts/mutants.mjs "$(mktemp -d)" [name filter]
// The directory given is the agent's own; it is emptied of each copy after use.
// node_modules is copied (never linked) into each copy; `.git` is left out by
// its exact name (`.github` is kept).

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const C = 'test/commands.test.js';
const A = 'test/app.test.js';
const G = 'test/config.test.js';
const ALL = [
  C,
  A,
  G,
  'test/realclock.test.js',
  'test/manifest.test.js',
  'test/encoding.test.js',
  'test/release.test.js',
];
const APP = 'src/app.js';

/** [name, file, from (found exactly once), to, test files]. */
export const MUTANTS = [
  [
    'stop option',
    APP,
    'if (key === FEATURES.STOP && this.config?.allowStop !== true) {',
    'if (false) {',
    [C],
  ],
  [
    'option again before the first byte',
    APP,
    'beforeSend: () => {\n          check();',
    'beforeSend: () => {',
    [C],
  ],
  [
    'too late before the first byte',
    APP,
    'if (this.mono() > deadline - TIMINGS.commandLastByte) {',
    'if (false) {',
    [C],
  ],
  ['Gladys app refused', APP, 'if (before.gladys) throw', 'if (false) throw', [C]],
  ['Gladys app never offered', APP, 'if (!app.gladys) devices.push', 'if (true) devices.push', [A]],
  [
    'Gladys app matched widely',
    'src/parse.js',
    '.some((v) => /gladys/i.test(String(v)))',
    '.some((v) => /^gladys$/i.test(String(v)))',
    [G, C],
  ],
  [
    'state between two refused',
    APP,
    "if (before.state === 'unknown') throw",
    'if (false) throw',
    [C],
  ],
  ['already so: nothing sent', APP, 'if (before.state === target) {', 'if (false) {', [C]],
  ['confirmed only by the state asked', APP, 'if (now?.state === target) {', 'if (now) {', [C]],
  [
    'follow-up confirms only the state asked',
    APP,
    'if (app?.state === target) {\n            this.pending.delete(appId);',
    'if (app) {\n            this.pending.delete(appId);',
    [C],
  ],
  ['one command per app', APP, 'if (this.commands.has(appId)) throw', 'if (false) throw', [C]],
  [
    'refused while a command waits',
    APP,
    'if (this.pending.has(appId)) throw new Error(T.errors.stopping);\n    this.commands.add',
    'this.commands.add',
    [C],
  ],
  ['pause holds commands', APP, 'if (this.paused()) throw new Error(T.errors.paused);', '', [A, C]],
  ['login spacing', APP, 'if (since < TIMINGS.loginSpacing) throw', 'if (false) throw', [A]],
  ['last login in /data', APP, 'this.memory.lastLoginAt = this.now();', '', [A]],
  ['refusal kept at start', APP, 'if (same && !force) {', 'if (false) {', [A]],
  [
    'only the refusal codes refuse',
    APP,
    'if (REFUSED_LOGIN_CODES.includes(code)) {',
    'if (true) {',
    [A],
  ],
  [
    'no renewal on a fresh token',
    APP,
    'if (err?.status !== 401 || this.mono() - s.at < TIMINGS.freshToken) throw err;',
    'if (err?.status !== 401) throw err;',
    [A],
  ],
  ['last read in /data before the read', APP, 'this.memory.lastReadAt = this.now();', '', [A]],
  ['restart keeps the interval', APP, 'force || !last ? 0 : clamp(', 'true ? 0 : clamp(', [A]],
  ['reconnection reads nothing', APP, '      if (same) {', '      if (false) {', [A]],
  ['pause kept in /data', APP, 'this.memory.pausedUntil = this.now() + delay;', '', [A, C]],
  ['pause honoured at start', APP, '    if (left > 0) {', '    if (false) {', [A]],
  [
    'disks are secondary',
    APP,
    '      if (read.err) {\n        this.disksDelay',
    '      if (read.err) {\n        throw read.err;\n        this.disksDelay',
    [A],
  ],
  [
    'test button does not double a read',
    APP,
    'if (recent) return T.test.recent',
    'if (false) return T.test.recent',
    [A],
  ],
  [
    'answer size streamed',
    'src/casaos.js',
    '        if (size > maxBytes) {',
    '        if (false) {',
    [G],
  ],
  [
    'v1 envelope read',
    'src/casaos.js',
    "if (!envelope || !('data' in envelope) || (v1 && code !== 200)) {",
    'if (!envelope) {',
    [G],
  ],
  [
    'strict numbers',
    'src/parse.js',
    "const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);",
    'const num = (v) => (v === null || v === undefined ? null : Number(v));',
    [G, A],
  ],
  [
    '0 degrees is no sensor',
    'src/parse.js',
    'return t === null || t === 0 ? null',
    'return t === null ? null',
    [G, A],
  ],
  [
    'option strictly true',
    'src/config.js',
    "const on = (raw) => raw === true || raw === 'true';",
    'const on = (raw) => Boolean(raw);',
    [G],
  ],
  [
    'password without user refused',
    'src/config.js',
    "else if (!username) credentialsError = 'username';",
    '',
    [G],
  ],
];

/** Mutants that cannot be killed, and why (none expected). */
const EQUIVALENT = [];

function run(dir, tests, ms) {
  return new Promise((done) => {
    const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-timeout=60000', ...tests], {
      cwd: dir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
      done({ code: 'TIMEOUT', out });
    }, ms);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

async function main() {
  const base = process.argv[2];
  const filter = process.argv[3];
  if (!base) throw new Error('give your own temporary directory (mktemp -d)');
  const modules = join(base, 'node_modules');
  cpSync(join(REPO, 'node_modules'), modules, { recursive: true });
  // The unmodified suite first: a red baseline makes every mutant look killed.
  {
    const dir = mkdtempSync(join(base, 'baseline-'));
    try {
      cpSync(REPO, dir, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
      });
      cpSync(modules, join(dir, 'node_modules'), { recursive: true });
      const { code } = await run(dir, ALL, 300_000);
      if (code !== 0) {
        console.log('baseline FAILED');
        rmSync(modules, { recursive: true, force: true });
        process.exitCode = 1;
        return;
      }
      console.log('baseline ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  let survived = 0;
  for (const [name, file, from, to, tests] of MUTANTS) {
    if (filter && !name.includes(filter)) continue;
    const dir = mkdtempSync(join(base, 'm-'));
    try {
      cpSync(REPO, dir, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
      });
      cpSync(modules, join(dir, 'node_modules'), { recursive: true });
      const path = join(dir, file);
      const text = readFileSync(path, 'utf8');
      const n = text.split(from).length - 1;
      if (n !== 1) {
        console.log(`??       ${name}: ${n} matches`);
        survived += 1;
        continue;
      }
      writeFileSync(path, text.replace(from, to));
      const { code } = await run(dir, tests, 150_000);
      const killed = code !== 0 && code !== 'TIMEOUT';
      if (!killed) survived += 1;
      console.log(`${killed ? 'killed  ' : code === 'TIMEOUT' ? 'HANGS   ' : 'SURVIVED'} ${name}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  rmSync(modules, { recursive: true, force: true });
  for (const [name, , , why] of EQUIVALENT) console.log(`equiv.   ${name}: ${why}`);
  process.exitCode = survived > 0 ? 1 : 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
