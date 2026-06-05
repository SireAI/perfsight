# Handoff

## Current State

- npm package skeleton exists with `@perfsight/cli` metadata
- CLI entrypoint is `bin/perfsight.js`
- source is split into Node.js ESM modules under `src/`
- leak detection is structure + Java Heap watermark based
- deprecated Java Heap trend-window CLI options have been removed
- legacy Python implementation remains under `tools/adb_perf_watch.py`
- generated sample data exists under `data/` and is excluded from package publishing

## Recently Landed

- npm package architecture was introduced
- local Web server and lightweight Web UI were added
- CSV writer, session meta, offline report, and HPROF capture modules were added
- Node tests cover leak watermark/structure decisions and meminfo parsing
- `docs/npm_architecture.md`, `docs/leak_capture_design.md`, and README were aligned with npm direction
- this harness was added to guide future AI-driven work

## Open Work

- run end-to-end validation on a connected Android device
- validate Web mode with real samples and manual dump
- validate HPROF capture for debuggable and/or rooted targets
- improve adb/package-not-found diagnostics after observing real failures
- decide when or whether to retire the Python reference implementation

## Current Risks

- Node implementation has passed syntax/unit/package checks but has not yet been device-validated in this harness
- Android `dumpsys meminfo` formatting can vary across OS/device versions
- HPROF capture availability depends on debuggable/root capability
- Web UI is intentionally lightweight and may need UX hardening after real use
- npm package name `@perfsight/cli` may need registry ownership/namespace confirmation before publishing

## Validation Baseline

- `npm run check`
- `npm test`
- `npm run smoke`
- `npm pack --dry-run --cache /private/tmp/perfsight-npm-cache`

## Last Known Validation

- syntax check passed
- unit tests passed
- CLI help smoke passed
- package dry-run passed with a clean tarball

## Next Entry Point

1. read `harness/AGENTS.md`
2. run the validation baseline
3. if a device is connected, run `node ./bin/perfsight.js text <package>`
4. continue from `harness/TASK_PLAN.md`
