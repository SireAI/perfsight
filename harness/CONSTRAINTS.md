# Constraints and Invariants

This is the single constraint file for AI-guided work on PerfSight.

## Must Hold

- PerfSight ships as an npm CLI package.
- Runtime source is pure Node.js ESM using the standard library unless a dependency has clear product value.
- `bin/perfsight.js` stays thin: it only starts the CLI.
- `src/cli` owns argument parsing and help text.
- `src/app` is the only orchestration layer.
- `src/adb` owns adb process execution and transport concerns.
- `src/parsers` stays pure and testable.
- `src/sampling` owns snapshots and sample construction.
- `src/leak` owns leak decisions only; it must not call adb, write files, or know about Web/UI.
- `src/capture` owns HPROF dump, pull, and capture manifest creation.
- `src/storage` owns CSV and session metadata.
- `src/web` owns local HTTP API, Web state, and live UI.
- `src/report` owns offline HTML report generation.
- Public CLI help, README examples, and implementation options must stay aligned.
- Package publishing must be checked with `npm pack --dry-run`.
- Historical Python code under `tools/` is reference/legacy code, not the forward implementation path.

## Leak Detection Invariants

- Java Heap trend-window detection is deprecated and must not re-enter the product.
- Do not add or preserve these deprecated CLI options:
  - `--leak-window-sec`
  - `--leak-floor-growth-mb`
  - `--leak-growth-mb`
  - `--leak-fallback-ratio`
  - `--leak-pss-growth-mb`
- Leak detection is composed of:
  - structure rule: `Activities - ViewRootImpl`
  - watermark rule: `java_heap_mb / java_heap_max_mb`
- `--leak-dump-threshold-mb` is only the Total PSS threshold for structure-only dump decisions.
- Watermark high confidence may request dump without trend history.
- If maximum Java Heap cannot be resolved, watermark detection is inactive but structure detection still works.

## Must Not Happen

- Business logic in `bin/`.
- adb calls inside parser, leak, report, or storage modules.
- file writes inside parser or leak modules.
- Web UI state becoming the source of truth for sampling or leak decisions.
- introducing TypeScript, bundlers, transpilers, or third-party dependencies without updating architecture docs and validation.
- publishing packages that include runtime `data/`, generated captures, or Python cache files.
- adding new CLI options without updating README, help text, and tests where relevant.
- changing leak semantics without updating `docs/leak_capture_design.md`.

## Design and Validation

- Prefer small modules with explicit boundaries over broad utility layers.
- Define key failure signals before adding more automation.
- Error output should answer: what failed, why, next action.
- Any adb-facing feature should have parser/unit coverage where a device is not required.
- Device-dependent behavior should be manually validated and recorded in `HANDOFF.md`.

## Code Readability

- Critical state transitions should have concise comments when they are not obvious.
- Comments should explain responsibility, boundary, or state reason.
- Avoid comments that restate syntax.
- Keep naming aligned with runtime concepts: `sample`, `snapshot`, `watermark`, `struct`, `capture`, `report`.

## Review

- No release without review.
- Review shared modules touched by the change, not only the final diff.
- Findings should prioritize regressions, broken CLI contracts, package publish risks, missing validation, and doc drift.

## Doc Sync

- Architecture changes -> `docs/npm_architecture.md`
- Product positioning changes -> `docs/product.md`
- Leak rule changes -> `docs/leak_capture_design.md`
- Harness boundary changes -> `harness/FRAMEWORK.md`
- Current goal/plan changes -> `harness/GOAL.md` or `harness/TASK_PLAN.md`
- Current state/risk/validation changes -> `harness/HANDOFF.md`

