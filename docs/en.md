# CasaOS

Gladys reads your [CasaOS](https://casaos.zimaspace.com/) home server through its local API: the
load of the processor, the memory, the system disk, the temperatures, and the apps installed from
the CasaOS app store. Each app becomes a Gladys device with **Start** and **Stop** buttons.

Unofficial integration, not affiliated with IceWhale (the makers of CasaOS and ZimaOS).

> Tested against CasaOS 0.4.15 running in a container (the `dockurr/casa` image), with a test
> app installed, started and stopped. Never tested with a real device (a real CasaOS box, its
> sensors and disks). ZimaOS is not verified: its API may differ.

## What you get

- **The server** (one device): CPU (%), CPU temperature, memory (% and MB used), system disk (%
  used and GB free), apps running and stopped, and the temperature of each physical disk CasaOS
  lists. A temperature CasaOS gives as 0 (no sensor, a virtual machine) is left unknown, never
  shown as 0 °C.
- **Each app** (one device per app): running (yes / no), update available (yes / no), and the
  **Start** and **Stop** buttons. The app that runs Gladys itself (recognized by "gladys" in its
  id, title, service names, image, container or host name) is never offered.

The values are read every minute by default (30 s to 1 h), the disks every 5 minutes.

## Configuration

1. **CasaOS address**: the one you open CasaOS with, `http://192.168.1.20` (add `:port` when it
   is not 80). `https://` only behind a reverse proxy whose certificate comes from a known
   authority; a self-signed certificate is refused. No path.
2. **User name** and **password** of your CasaOS account. The password is kept by Gladys in its
   database, never shown again, and sent only to CasaOS, at login. With `http://` it crosses your
   local network in clear, as it does when you log in to the CasaOS page.
3. **Refresh**: how often Gladys reads CasaOS.
4. **Allow stopping apps**: off by default (see below).
5. Save, then add the devices from the **Discovery** tab.

### One login, then the session

CasaOS accepts five logins, then **one login a minute, for all its clients** (your browser
included). The integration logs in once, then renews its session with the refresh token CasaOS
gives (no password). It does not log in twice within a minute, even across a restart of the
integration (the time of the last login is written to `/data` before the login is sent; when
`/data` cannot be written, there is no login and the status says so).

If CasaOS refuses the user name or the password, the integration stops and says so: nothing is
tried again until you save the configuration or press **Test the connection**. The refusal is
remembered across restarts as a 6-bit mark (it can never tell the password).

## Start and stop an app

- **Start** needs no option.
- **Stop** can cut a service of the house (a database, an MQTT broker, a camera recorder Gladys
  uses): it is **off by default**. Tick **Allow stopping apps** to use it. The option is checked
  when the press arrives and again just before the command is sent.
- Both are buttons, never a switch: a voice assistant or a "turn everything off" never reaches
  them.

Each press reads the app first. The command is refused, and nothing is sent, when:

- stopping is not allowed (Stop only);
- the app is the one running Gladys (its id, title, a service name, image, container or host name
  holds "gladys");
- the app is not installed any more, or CasaOS shows one of its services paused, restarting or
  in another state than running, exited, created or dead;
- the user name or password was refused, CasaOS asked to wait (HTTP 429), the integration is not
  connected, or the configuration changed meanwhile;
- another command of the same app is still running, or the previous one is still being applied;
- the time left within the 5 s Gladys waits is too short.

When the app is already in the state asked, nothing is sent and the press succeeds. An app of
several services with some running and some stopped is shown running; Start then aims at every
service running, Stop at none running.

The acknowledgement never waits for the states sent to Gladys.

CasaOS applies a command in the background. The press succeeds only once a read shows the app
in the state asked; otherwise Gladys is told "sent, without confirmation", and the app is read
again 5 s and 20 s after the command (the state published then is the one read). A command is
never sent twice.

## Troubleshooting

- **"Login to CasaOS in N s"**: CasaOS accepts one login a minute; the integration waits.
- **"CasaOS refused the user name or the password"**: correct them and save.
- **"not an answer of CasaOS"**: the address points to another web server.
- **"CasaOS asked to wait"**: too many requests; every read and command pauses (1 min to 6 h,
  kept across restarts).
- The integration logs what it does (`LOG_LEVEL=debug` for more), never a password nor a token.

## Limits

- One CasaOS server per integration. Up to 100 apps and 16 disks.
- The disk health CasaOS reports is not used: it is `true` whenever SMART gives nothing.
- Apps installed outside the CasaOS app store (a plain `docker run`) are not listed by CasaOS as
  apps, so not here either.
