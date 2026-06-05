# Goal and Boundary

## Project Goal

- build PerfSight as an installable npm CLI for Android app performance observation
- keep CPU/PSS sampling, leak watermark detection, HPROF capture, Web view, CSV archival, and report export cohesive
- make the project easy for AI agents to evolve without violating module boundaries or leak-rule semantics

## Current Stage Goal

- converge from a Python single-file prototype to a publishable npm package
- keep the Node.js implementation modular and standard-library based
- preserve core behavior from the reference implementation where still desired
- remove deprecated Java Heap trend-window rules from the forward path
- keep docs, CLI help, tests, and package metadata aligned with the npm implementation

## Current Non-Goals

- full hosted platform or cloud dashboard
- React/Vue frontend build pipeline
- TypeScript migration
- third-party charting or CLI frameworks
- automatic root/device repair
- reviving deprecated trend-window leak detection
- deleting legacy Python reference code before the npm CLI is validated on devices

## Entry Docs

- product: `docs/product.md`
- architecture: `docs/npm_architecture.md`
- leak design: `docs/leak_capture_design.md`

