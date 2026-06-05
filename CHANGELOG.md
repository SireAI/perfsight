# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.
## [Unreleased]

### Added

### Changed

### Fixed

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
