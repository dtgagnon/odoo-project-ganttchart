# Project Gantt Enhanced

This addon delivers an interactive Gantt planning workspace for Odoo Project, inspired by the
reverse-engineering analysis of the Enterprise Gantt experience. It focuses on stakeholder
requirements highlighted in *Reverse_Engineering_Odoo_Project_Gantt_Chart_Feature_Analysis_and_Dev_Plan.md*.

## Feature Highlights

- **Visual Timeline Planning** – Tasks render as resizable bars on a zoomable daily/weekly/monthly horizon.
- **Drag-and-Drop Scheduling** – Drag a task bar to instantly reschedule the task; successors can auto-shift or prompt for approval when buffers are enforced.
- **Task Dependencies with Buffers** – Link tasks via finish-to-start relationships, including buffer delays and auto-propagation.
- **Blocking Logic** – Tasks cannot move to an “In Progress” state while predecessors remain incomplete.
- **Undo / Redo Stack** – Client-side undo/redo with server reconciliation for moves and link operations.
- **Workload Grouping** – Switch grouping between assignee, project, or stage for resource balancing.
- **Non-Working Time Awareness** – Calendar data is exposed for non-working intervals (UI overlay ready).
- **Hierarchy & Milestones** – Expand/collapse nested tasks, with milestone tasks rendered as diamond markers.
- **Inline Dependency Controls** – Start a dependency by dragging from a task handle and remove successors via inline chips.
- **Quick Scheduling Dialog** – Add or schedule tasks directly from the sidebar, pre-filtered by the active grouping.

## Usage

1. Enable the *Plan Gantt* stat button on a project (project form → "Plan Gantt").
2. Drag task bars to reschedule; when dependencies lack auto-propagation the UI offers to keep successor gaps aligned.
3. Hover a task to expose the link handle; drag to another bar to create a dependency or click a successor chip to remove it. Toolbar **Link/Unlink** remains available for multi-selection workflows.
4. Use the **Undo/Redo** controls to roll back or reapply recent planning changes.
5. Keyboard users can focus a task bar (Tab/Shift+Tab) then use **Enter/Space** to toggle selection. Nudge schedules with **← / →** (±1 day), **Shift+Arrow** (±1 week), **Ctrl/Cmd+Arrow** (±1 hour), or **Alt+Arrow** (±12 hours).
6. Click the sidebar “+” next to any grouping row to schedule an unscheduled task or create a new one with default duration.

### Visual cues

- Shaded regions highlight non-working periods sourced from the project or company calendar.
- A vertical orange line marks “today” within the current zoom window.
- Dependency connectors draw elbow paths; hovering a bar surfaces linked predecessors/successors and highlights viable link targets.
- Milestones render as orange diamonds centred on the task start.

## Technical Notes

- New models `project.task.link` and `project.task.buffer` track dependency topology and scheduling history.
- Task writes trigger propagation hooks and dependency blocking checks.
- JSON controllers expose task data to the client action for low-latency interactions.
- OWL client action defined in `static/src/js/project_gantt_controller.js` manages the timeline UI.
- Basic regression tests (`tests/test_gantt_logic.py`) validate dependency blocking and buffer propagation.
- Front-end polish includes non-working overlays, today indicator, SVG connectors, and keyboard accessibility helpers.

## Roadmap

- Render curved dependency connectors and highlight non-working overlays in the UI.
- Support additional link types (SS/FF/SF) in the drag interaction layer.
- Extend undo/redo coverage to include task creation/deletion and buffer adjustments.
