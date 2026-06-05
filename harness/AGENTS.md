# Harness Entry

You are working inside the PerfSight engineering harness.

PerfSight is an npm-published Android performance watcher. It samples an Android app through adb, records CPU/PSS data, detects leak suspicion through structure and Java Heap watermark rules, and can capture HPROF files.

## Read Order

1. `harness/CONSTRAINTS.md`
2. `harness/CHECKLIST.md`
3. `docs/product.md`
4. `docs/npm_architecture.md`
5. `docs/leak_capture_design.md`
6. `harness/FRAMEWORK.md`
7. `harness/GOAL.md`
8. `harness/TASK_PLAN.md`
9. `harness/HANDOFF.md`

## File Roles

- `CONSTRAINTS.md`: long-lived project invariants
- `CHECKLIST.md`: end-of-change self-review
- `FRAMEWORK.md`: harness document boundaries
- `GOAL.md`: current-stage goal and non-goals
- `TASK_PLAN.md`: prioritized work queue
- `HANDOFF.md`: current state, risks, validation, next entry point

## Rules

- Do not skip constraints or checklist.
- Do not put long-term rules into `HANDOFF.md`.
- Do not put current-stage status into `CONSTRAINTS.md`.
- If product meaning changes, update `docs/product.md`.
- If module boundaries change, update `docs/npm_architecture.md`.
- If leak detection behavior changes, update `docs/leak_capture_design.md`.
- If validation, risks, or current state changes, update `HANDOFF.md`.

