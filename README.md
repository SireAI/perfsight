# PerfSight

PerfSight is a local Android performance watcher for endurance runs. It samples app CPU, total PSS, memory composition, leak signals, heap dumps, and Web UI live state from `adb`.

## Quick Start

### Install

```bash
npm install -g @sireai/perfsight
```

Or run without installing:

```bash
npx @sireai/perfsight text com.mi.car.mobile
```

### Run

Text mode:

```bash
perfsight text com.mi.car.mobile
```

Web mode:

```bash
perfsight web com.mi.car.mobile
```

Enable leak capture:

```bash
perfsight text com.mi.car.mobile --enable-leak-capture
perfsight web com.mi.car.mobile --enable-leak-capture
```

Start from a clean artifact set for the current package:

```bash
perfsight text com.mi.car.mobile --output-dir ./data --reset-output-dir
```

Run text mode without periodic sample lines while still printing automatic dump events:

```bash
perfsight text com.mi.car.mobile --enable-leak-capture --quiet-samples
```

### Common Commands

```bash
perfsight --help
perfsight help text
perfsight help web
perfsight help leak-capture
perfsight version
perfsight upgrade
```

Web mode also starts a local server at:

```text
http://127.0.0.1:8765
```

## Output Layout

PerfSight writes managed artifacts under `output-dir` with a package-scoped structure:

```text
<output-dir>/
  sessions/<package>/<timestamp>/
    samples.csv
    session.json
    report.html
  captures/<package>/
  simpleperf/<package>/
  logs/<package>/
```

`--reset-output-dir` clears the current package's existing `sessions`, `captures`, `simpleperf`, and `logs` artifacts before a new run.

`--quiet-samples` is useful in text mode when you want a quieter console and only care about startup, errors, and automatic dump events.

## Web UI Features

- live App CPU chart
- live Total PSS and composition chart
- manual `Dump Memory`
- manual simpleperf `Start Recording` / `Stop Recording`
- automatic leak-triggered dump capture
- reconnect-aware device state

On macOS, PerfSight bundles the simpleperf Gecko conversion runtime used to open CPU recordings in Firefox Profiler. Other hosts fall back to a local Android NDK simpleperf install when available.

## More Docs

- [Documentation Index](docs/README.md)
- [Leak Capture Design](docs/leak_capture_design.md)
- [NPM Architecture](docs/npm_architecture.md)
- [Product Notes](docs/product.md)
- [Development and Maintenance](docs/development_maintenance.md)
