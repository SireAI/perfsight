# Task Plan

## Theme

Converge PerfSight into a reliable, publishable npm CLI while keeping AI-driven changes bounded by architecture and leak-rule constraints.

## Stage Goals

- stable npm package metadata and clean package tarball
- modular runtime that can be reviewed and tested by layer
- device-independent tests for parsers and leak decisions
- adb/device validation path for end-to-end sampling and HPROF capture
- documentation that matches the actual CLI
- no deprecated trend-window rule or CLI option in the forward implementation

## Principles

- stabilize the install/run loop before expanding advanced analysis
- keep parser and leak logic testable without devices
- keep Web UI lightweight until runtime behavior is proven
- prefer explicit status and actionable errors over hidden fallback behavior
- every new CLI option must have an owner module and documentation

## Priority Plan

### P0 Publishable Package Baseline

- keep `package.json` publish fields intentional
- keep `bin/perfsight.js` executable and thin
- keep `npm run check`, `npm test`, and `npm run smoke` passing
- keep `npm pack --dry-run` tarball clean

### P1 Device End-to-End Validation

- run text mode against a connected Android device
- run Web mode against a connected Android device
- validate CSV and session JSON output
- validate Total PSS and Java Heap parsing across target devices
- record validation findings in `HANDOFF.md`

### P2 HPROF Capture Hardening

- validate debuggable package capture
- validate rooted-device capture if available
- improve dump failure messages
- verify manifest fields and download links
- add tests around trigger rule labels where possible

### P3 CLI and Error Experience

- normalize bad input errors
- improve adb/device/package-not-found diagnostics
- add examples for common test scenarios
- consider a future `doctor` command only if it checks real blockers

### P4 Web and Report Refinement

- keep Web UI functional without introducing a build pipeline
- improve chart readability and dump history UX
- keep offline report self-contained
- add report parser tests if report complexity grows

## Suggested Order

1. P0
2. P1
3. P2
4. P3
5. P4

## Not in Scope

- broad rewrite to TypeScript
- frontend framework adoption
- publishing before device validation
- automatic memory leak root-cause analysis
- changing leak rules without product/design update

## Acceptance

- a new user can install or run with `npx`, then observe an Android app by package name
- text mode emits understandable samples
- Web mode exposes live samples and manual dump when available
- leak decisions match `docs/leak_capture_design.md`
- package tarball contains only intended source/docs/tests/scripts

