# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- CasaOS server device: CPU (%), CPU temperature, memory (% and MB), system disk (% and GB free),
  apps running and stopped, the temperature of each physical disk.
- One device per installed app: running, update available, Start and Stop buttons; the app
  running Gladys is never offered, started nor stopped.
- Stopping an app off by default (option checked at the press and just before the command);
  a command succeeds only once a read shows the state asked, read again 5 s and 20 s after.
- One login, then the session renewed with the refresh token; never two logins within a
  minute, across restarts; a refused password stops everything until the configuration is
  saved (6-bit mark in /data); HTTP 429 pauses every path (kept in /data).
- "Test the connection" button; documentation in English and French.

### Fixed

- Review r1: the stop option and the account are checked against the configuration as soon as
  Gladys sends it (even while a read holds the start queue); the status of a multi-service app
  is read segment by segment (a mixed project can be started and stopped); the acknowledgement
  never waits for the publication to Gladys; no login when /data cannot be written; no stale
  status after a configuration change; unknown values (update flag, memory without a total,
  counts) and stale disk temperatures never published; the Gladys app also recognized by
  service, container and host names; `timeout-minutes` on every workflow.
