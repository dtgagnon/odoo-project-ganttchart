# Project Gantt Enhanced – Implementation Tracker

## Phase 1 – Data & Server Compliance
- [x] Surface `planned_date_begin` and `planned_date_end` on the task form (and list in debug) so schedulers can inspect planned dates directly.
- [x] Expose dependency editing on tasks: add editable relation widgets, successor smart button, and immediate waiting-state updates when links are added/removed.
- [x] Harden link RPC handling: ensure buffer options persist, validation errors surface cleanly, and stage adjustments respect access rights.

## Phase 2 – Front-End UX Parity
- [x] Render hierarchy cues and milestone styling (indentation, expand/collapse, summary bars, diamond markers).
- [x] Add drag-edge resize with live duration tooltip and calendar boundary clamping.
- [x] Introduce bar-level dependency handles and inline delete affordances; keep toolbar actions as fallback.
- [x] Prompt users when predecessor moves impact successors, logging buffer decisions.
- [x] Provide an "Add Task" dialog keyed to current grouping with default duration handling.
- [x] Display hover tooltips for drag/resize and extend keyboard nudging shortcuts.

## Phase 3 – QA & Tests
- [x] Extend Python unit tests for link auto-wait, undo/redo of new interactions, non-working overlays, and buffer prompts.
- [ ] Add JS-side tests or instrumentation for undo service stack behaviour after new operations.
- [ ] Run full test + lint pipeline once features land.

## Phase 4 – Documentation & Release Prep
- [x] Update README/docs with new UX screenshots and workflow notes.
- [ ] Record changes in CHANGELOG and bump manifest version post-gap closure.
- [ ] Prepare UAT checklist covering dependency handles, resizing, add-task flow, milestone visuals, auto-blocking, and undo/redo.
