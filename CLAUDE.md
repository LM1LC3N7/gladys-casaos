# CLAUDE.md

Project rules for coding assistants and contributors.

## What this is

A Gladys Assistant **external integration** for a CasaOS home server: Node.js 22+, ESM, no build
step, its own sandboxed container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js) (its
only runtime dependency) and to CasaOS through its documented HTTP API.

## Commands

```bash
npm install
npm test                       # node --test (fake Gladys + simulated CasaOS on 127.0.0.1)
npm run lint && npm run format:check
node scripts/cover.mjs cover.png
memcap node scripts/mutants.mjs "$(mktemp -d)"   # mutants of the guards, one at a time
```

## Architecture

```
index.js            SDK wiring only
src/handlers.js     the SDK handlers (shared with the tests)
src/app.js          CasaosApp: reads, session, Discovery, states, commands, test button
src/casaos.js       HTTP transport (one request per connection, beforeSend, size caps), envelopes
src/parse.js        answers -> values (strict numbers, app states, the Gladys app)
src/devices.js      server and app devices, external ids
src/config.js       configuration (DEFAULT_CONFIG mirrors the manifest)
src/store.js        /data: refusal mark, pause, last login and read
src/i18n.js         statuses (en/fr) and command errors
test/helpers/       simulated CasaOS (after real answers of CasaOS 0.4.15) and setup
test/kit/           virtual and real clocks (from gladys-testkit)
```

## Rules

- External ids, feature keys and manifest keys are forever.
- Stop stays off by default and checked again in `beforeSend`; the app running Gladys is never
  offered, started nor stopped; never a switch.
- A command is a success only once a read shows the state asked; never sent twice.
- Never two logins within a minute (CasaOS limits logins for all its clients); tokens and the
  password never in logs, statuses, errors or /data.
- `mono` decides delays and budgets; `now` only dates /data.
- Every wait in a test is bounded in real time (`until`, `within`, `waitFor`).
