# TODO — CasaOS v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-11-25): CasaOS client (login, refresh, utilization, disks,
      compose apps, app status), server device and one device per app, start (allowed) and stop
      (off by default) with a fresh read, confirmation by a read and follow-ups at 5 s and 20 s,
      session kept and renewed, login spacing across restarts, refusal mark, 429 pause, test
      button, docs en/fr. Tested against the SDK's fake Gladys and a simulated CasaOS, and by hand
      against a real CasaOS 0.4.15 in a container (`dockurr/casa`, inside a `docker:dind`).
      **Never tested with a real device.**
- [ ] **Milestone 2 — real boxes**: a tester with a real CasaOS (x86 and ARM, real disks and
      sensors) and one with ZimaOS. To check first:
  - the CPU temperature and the disk temperatures on real hardware (0 in a container);
  - `status` of a compose app with several services, one stopped (seen "running" in the
    container), and the values during an update or an install;
  - the time a stop takes for an app that ignores SIGTERM (compose waits 10 s): the command then
    ends "sent, without confirmation" and the follow-ups confirm it;
  - ZimaOS: the same routes (`/v1/users/login`, `/v1/sys/utilization`, `/v2/app_management`)?
    If they differ, a separate integration or a v2 (ZimaOS has no published license: API only).
- [ ] **Milestone 3 — more**: restart button, app update button (sensitive), network rates
      (`net` of the utilization), storage per mount point (`/v1/storage`), an event when an app
      stops on its own.

## Decisions

- **Version 0.1.0** set by hand (package.json, lock, manifest, `docker_image`).
- **No `keywords`** in the manifest; category `servers` only; no `countries` (the whole world).
- **Start always allowed, stop behind `allow_app_stop`** (off): stopping can cut a service of the
  house; starting cannot. Neither is a switch. The app running Gladys (id, title or any image
  name containing "gladys", without case) is never offered, started nor stopped; a false match
  only hides an app.
- **States of a compose app** (review r1): the list gives the main container (`running`), the
  route of one app the whole project, one segment per state (`exited(1), running(1)`). All
  running = running, all exited/created/dead = stopped, a mix of the two = mixed (shown
  running, commandable both ways), anything else (paused, restarting) = unknown (refused).
- **The stop option and the account** are read from `latest`, set when the configuration
  arrives, outside the start queue (a slow read may hold it for 25 s).
- **The ack never waits for the publication** to Gladys (`void publishRunning`).
- **Success = a read shows the state asked.** CasaOS answers "being changed asynchronously": the
  app is read every 400 ms within the 3.5 s budget, then 5 s and 20 s after. A state equal to the
  one before is never a confirmation. Nothing is written later than 3.1 s after the press. One
  command at a time per app; a second press while a command waits is refused (nothing sent).
- **Login spacing 60 s, across restarts.** CasaOS-UserService limits logins to 5 then one a minute
  for every client (the user's browser included): the integration logs in once, renews with the
  refresh token (no limit, no password), and keeps `lastLoginAt` in /data, written before the
  login is sent; not written, no login (status says so). Tokens are never written to /data: a
  restart logs in again (once).
- **Refusal** = HTTP 400 with `success` 10006 or 10013 on the login only. Any other 400, a 401 on
  a data route (even on a fresh token), a 403, an unreadable answer: errors, never a refusal.
  The refusal is kept as a 6-bit salted mark of address, user and password; a saved
  configuration or the test button lifts it.
- **A 401 on a token older than 10 s** renews the session once (refresh token, else login) and
  tries again; on a younger token it is an error of that request.
- **No percent category in the core** for CPU, memory or disk load: `unknown`/`unknown` without a
  unit (as gladys-system-bridge). Temperatures `device-temperature-sensor` in °C; memory used in
  MB and disk free in GB (`data`/`size`); counts `counter-sensor`.
- **Disk health not used**: CasaOS-LocalStorage reports `true` whenever smartctl gives nothing.
- **Temperature 0 = unknown** (CasaOS gives 0 without a sensor).
- **http by default** (CasaOS serves http on port 80); https only with a certificate of a known
  authority (reverse proxy), no pin, no self-signed exception. The password crosses the LAN in
  clear over http, as with the CasaOS page itself (said in the docs and the manifest).
- **IDs**: server `server:<host>-<port>` (address id), app `app:<compose project name>`.
  A disk temperature feature seen once stays on the server device.
- **Reads never sooner than the interval**: not on a reconnection to Gladys, a restart
  (`lastReadAt` in /data, written before the read), the Discovery, or the test button within the
  interval (and never within 30 s of the last read).
- **CI**: `timeout-minutes` on every workflow (ci 15/20, release and github-release 30, build 60
  for the multi-arch QEMU build).
