# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.
## [Unreleased]

### Added

### Changed

### Fixed

## [0.3.0] - 2026-06-08

### Added

- package-scoped session output layout with `--reset-output-dir` cleanup support
- CPU recording export history and direct artifact download entries in the Web UI
- concise CLI recovery guidance for adb disconnects and occupied Web UI ports
- prepack cleanup for Python cache artifacts before npm packaging
- separate user-facing README and contributor maintenance docs

### Changed

- side-panel dump and CPU recording presentation now truncates long filenames and uses bounded scroll areas
- runtime logs are now grouped by package under `logs/<package>/`
- startup output now shows session and CPU recording artifact locations

### Fixed

- Web UI startup now handles occupied ports without crashing into a raw Node stack trace
- npm dry-run packaging no longer picks up local Python bytecode caches from the workspace

## [0.2.0] - 2026-06-05

### Added

- npm publish metadata for GitHub and npm registry delivery
- release workflow commands for status, prepare, preflight, pack, publish, and tag
- Web UI manual CPU recording with device-side simpleperf and Firefox Profiler export
- dump hook support for running shell automation after automatic or manual heap dumps
- bundled simpleperf Gecko conversion runtime for macOS npm installs
- device CPU core count and frequency summary in the Web UI

### Changed

- aligned repository packaging docs with a formal npm release flow
- refactored command structure into text and web modes with focused help topics
- simplified leak-capture options and removed deprecated Java heap trend parameters
- improved Web UI layout, reconnect handling, dump states, notifications, and runtime logging

### Fixed

- automatic/manual dump state sync after device reconnects
- npm package contents no longer include vendored Python cache directories
