# gladys-casaos

A [Gladys Assistant](https://gladysassistant.com) external integration for
[CasaOS](https://github.com/IceWhaleTech/CasaOS): the CPU, memory, system disk and
temperatures of the server, and its installed apps, each one with Start and Stop buttons
(Stop off by default; the app running Gladys is never offered).

Unofficial, not affiliated with IceWhale. Tested against CasaOS 0.4.15 in a container
(`dockurr/casa`); never tested with a real device; ZimaOS not verified.

- User documentation: [English](docs/en.md), [français](docs/fr.md).
- Changes: [CHANGELOG.md](CHANGELOG.md). Decisions and next steps: [TODO.md](TODO.md).

## Development

```bash
npm install
npm test              # node --test, against the SDK's fake Gladys and a simulated CasaOS
npm run lint
npm run format:check
node scripts/cover.mjs cover.png
memcap node scripts/mutants.mjs "$(mktemp -d)"   # mutation checks of the guards
```

The image runs as a non-root user on a read-only root filesystem; its only writable place is
`/data` (`casaos-state.json`: refusal mark, pause, times of the last login and read; never a
password nor a token).

## License

Apache-2.0 (see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
