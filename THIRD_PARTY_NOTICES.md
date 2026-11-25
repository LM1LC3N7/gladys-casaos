# Third-party notices

This integration is distributed under the Apache License 2.0 (see `LICENSE`).

## CasaOS API (OpenAPI files and route handlers)

- Sources: the OpenAPI files and route handlers of https://github.com/IceWhaleTech/CasaOS
  (`api/casaos/openapi.yaml`, `route/v1.go`, commit e099dd6 of 2026-11-09; v0.4.15 is the latest
  release), https://github.com/IceWhaleTech/CasaOS-AppManagement (`api/app_management/openapi.yaml`,
  commit debfa31), https://github.com/IceWhaleTech/CasaOS-UserService (`route/v1/user.go`, commit
  800c630) and https://github.com/IceWhaleTech/CasaOS-LocalStorage (`route/v1/disk.go`), all
  Apache-2.0, read on 2026-11-25.
- What was used: the routes (`/v1/users/login`, `/v1/users/refresh`, `/v1/sys/utilization`,
  `/v1/disks`, `/v2/app_management/compose`, `/v2/app_management/compose/{id}` and its `/status`),
  the `Authorization` header, the answer envelopes, the `success` codes of a refused login (10006,
  10013), the login limit (5, then one a minute) and the asynchronous status change, to write the
  client and the simulated CasaOS of the tests. The answers of a real CasaOS 0.4.15 (the
  `dockurr/casa` image, MIT, in a container) were recorded the same day, tokens removed.
- No code is copied or ported from CasaOS, and none of it is shipped in this image: the
  integration only calls its documented HTTP API over the network.
- ZimaOS (no license published) is not used in any way.

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0), installed from npm.
