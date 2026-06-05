# Harness Framework

`harness/` is the control plane for AI-guided engineering work on PerfSight.

## Layers

- entry: `AGENTS.md`
- constraints: `CONSTRAINTS.md`
- checklist: `CHECKLIST.md`
- product: `docs/product.md`
- architecture: `docs/npm_architecture.md`
- leak design: `docs/leak_capture_design.md`
- goal: `GOAL.md`
- plan: `TASK_PLAN.md`
- handoff: `HANDOFF.md`

## Boundaries

- `harness/`: AI control rules, stage goals, current engineering state
- `docs/`: long-lived product, architecture, and leak-rule documents
- `src/`: npm runtime source
- `test/`: unit tests runnable without Android devices
- `tools/`: legacy/reference Python implementation
- `data/`: generated local runtime output; never treat as source

## Update Rules

- long-term rules -> `CONSTRAINTS.md`
- end-of-change validation -> `CHECKLIST.md`
- product meaning -> `docs/product.md`
- architecture boundaries -> `docs/npm_architecture.md`
- leak semantics -> `docs/leak_capture_design.md`
- current stage priorities -> `GOAL.md` or `TASK_PLAN.md`
- recent status, risk, validation -> `HANDOFF.md`

## AI Operating Contract

- Read the harness before changing code.
- Prefer implementing through existing layers.
- Keep changes scoped to the requested behavior.
- Update docs in the same turn as behavior changes.
- Run the validation baseline before handing off, or state exactly why it could not run.

