# Checklist

Run this after any meaningful code, design, validation, or doc change.

## Architecture

- module boundaries still match `cli / app / adb / parsers / sampling / leak / capture / storage / web / report`
- new behavior lives in the right module
- no adb call leaked into parser, leak, report, or storage modules
- no file write leaked into parser or leak modules
- CLI options, README examples, and help output still agree
- package files still exclude generated `data/`, captures, and Python cache files

## Leak Rules

- deprecated Java Heap trend-window rule did not come back
- no deprecated trend CLI option exists in help output
- `leak_watermark_state` remains the active non-structure leak signal
- structure-only dump still requires Total PSS threshold
- watermark high confidence still requests dump without trend history
- `docs/leak_capture_design.md` matches code behavior

## Product

- PerfSight still behaves like a local Android app performance watcher
- npm CLI remains the primary delivery shape
- first-run path remains obvious: install -> run `perfsight <package>` -> inspect output
- Web mode remains optional, not required for text sampling
- failures explain whether the blocker is adb/device/package/capture capability

## Validation

- `npm run check`
- `npm test`
- `npm run smoke`
- `npm pack --dry-run --cache /private/tmp/perfsight-npm-cache`
- if adb-facing behavior changed, run or document a device validation path

## Docs

- architecture changes updated `docs/npm_architecture.md`
- product changes updated `docs/product.md`
- leak decision changes updated `docs/leak_capture_design.md`
- harness-boundary changes updated `harness/FRAMEWORK.md`
- stage/current-state changes updated `GOAL.md`, `TASK_PLAN.md`, or `HANDOFF.md`

## Before Publish

- package name, version, bin, files, license, and engines are intentional
- `npm pack --dry-run` tarball contents are clean
- README install and usage examples match the real CLI
- no generated output or local test data is included
- release notes mention any CLI or rule behavior changes

