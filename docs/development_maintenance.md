# Development and Maintenance

This document is for contributors and maintainers. End users should start from the repository [README](/Users/sire/develop/project/perfsight/README.md).

## Local Development

Run from source:

```bash
npm run text -- com.mi.car.mobile
npm run web -- com.mi.car.mobile
```

With leak capture:

```bash
npm run text -- com.mi.car.mobile --enable-leak-capture
npm run web -- com.mi.car.mobile --enable-leak-capture
```

Forward extra CLI options through npm with a second `--`:

```bash
npm run text -- com.mi.car.mobile --enable-leak-capture -- --output-dir /tmp/perfsight-output --quiet-samples
```

Helpful command topics:

```bash
npm run help
npm run help:text
npm run help:web
npm run help:leak
npm run help:version
npm run help:upgrade
```

## Common CLI Notes

Useful options:

- `--interval`
- `--pss-interval`
- `--serial`
- `--output-dir`
- `--reset-output-dir`
- `--quiet-samples`
- `--enable-leak-capture`
- `--dump-hook`

Web-only options:

- `--host`
- `--port`
- `--history-size`

Leak-capture options:

- `--leak-java-max-heap-mb`
- `--leak-java-watch-ratio`
- `--leak-java-dump-ratio`
- `--leak-dump-threshold-mb`
- `--leak-cooldown-sec`
- `--leak-max-dumps-per-pid`
- `--leak-max-dumps-per-session`
- `--leak-dump-dir`

## Runtime Output

PerfSight writes managed artifacts under `output-dir/`:

- `sessions/<package>/<timestamp>/samples.csv`
- `sessions/<package>/<timestamp>/session.json`
- `sessions/<package>/<timestamp>/report.html`
- `captures/<package>/`
- `simpleperf/<package>/`
- `logs/<package>/`

`--reset-output-dir` removes the current package's managed artifacts before the next run. It does not delete unrelated files under `output-dir`.

`--quiet-samples` only affects text mode. It suppresses the periodic sample lines while keeping startup, error, and automatic dump event output visible.

Runtime logs are retained for seven days.

## Dump Hook

Dump completion automation can be attached with:

```bash
perfsight text com.mi.car.mobile --enable-leak-capture --dump-hook "/path/to/on_dump.sh"
perfsight web com.mi.car.mobile --enable-leak-capture --dump-hook "python3 /path/to/on_dump.py"
```

Hook arguments include:

- `--event dump_completed|dump_failed`
- `--package <package>`
- `--pid <pid>`
- `--dump-type manual|leak`
- `--manifest <path>`
- `--hprof <path>`
- `--reason <reason>` (repeatable)
- `--error <message>` on failure
- `--runtime-log <path>`

## Verification

Before shipping a change:

```bash
npm run check
npm test
npm run verify
npm run pack:dry
```

## Release Flow

Release helpers:

```bash
npm run release:status
npm run release:prepare -- patch
npm run release:prepare -- minor
npm run release:preflight
npm run release:check
npm run release:pack
npm run release:publish
npm run release:tag
```

Typical latest release flow:

```bash
npm run release:prepare -- minor
npm run release:preflight
npm run release:check
npm run release:pack
npm run release:publish
npm run release:tag
```

Snapshot release flow:

```bash
npm run release:prepare -- snapshot
npm run release:check:snapshot
npm run release:publish:snapshot
```

## Maintenance Notes

- Web reconnect recovery is handled in the main runtime loop in [src/app/run.js](/Users/sire/develop/project/perfsight/src/app/run.js).
- CPU recording uses device-side simpleperf and the capture implementation in [src/capture/simpleperf-capture.js](/Users/sire/develop/project/perfsight/src/capture/simpleperf-capture.js).
- The Web UI runtime state lives in [src/web/web-state.js](/Users/sire/develop/project/perfsight/src/web/web-state.js).
- The live page is rendered from [src/web/templates.js](/Users/sire/develop/project/perfsight/src/web/templates.js).
- Bundled simpleperf conversion assets live under [src/vendor/simpleperf](/Users/sire/develop/project/perfsight/src/vendor/simpleperf).

## Related Design Docs

- [product.md](/Users/sire/develop/project/perfsight/docs/product.md)
- [npm_architecture.md](/Users/sire/develop/project/perfsight/docs/npm_architecture.md)
- [leak_capture_design.md](/Users/sire/develop/project/perfsight/docs/leak_capture_design.md)
