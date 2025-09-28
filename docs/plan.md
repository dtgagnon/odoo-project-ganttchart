# Next Steps for Project Gantt Enhanced

1. **Stabilize Computed Fields**
   - Split `dependency_blocker_ids` and `dependency_blocked` into dedicated compute methods to resolve the warnings raised during test execution.
   - Confirm both fields share consistent `compute_sudo` and `store` semantics once refactored.

2. **Tighten Unit Coverage**
   - Extend tests to verify non-working interval overlays, undo/redo flows, and dependency propagation with multiple successors.
   - Add regression checks for the dependency-blocking workflow once the compute refactor is complete.

3. **Polish Client Action** ✅
   - Dependency connectors now render as elbow paths with tooltip-ready SVG segments.
   - Non-working periods and a “today” marker overlay the timeline grid.
   - Keyboard navigation (selection, nudge scheduling) is supported on task bars.

4. **Document Usage**
   - Expand README usage notes with screenshots showing drag-and-drop, linking, and undo/redo in action.
   - Provide guidance on enabling the module in existing databases (dependencies, security groups, scheduling flags).

5. **Prepare for Release**
   - Bump the manifest version after addressing the warnings and UI polish items.
   - Fill in a changelog entry and ensure linting (`black`, `pylint`) passes before tagging the build.
