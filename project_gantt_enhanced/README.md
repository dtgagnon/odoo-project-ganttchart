# Project Gantt Enhanced

This addon delivers an interactive Gantt planning workspace for Odoo Project, inspired by the
reverse-engineering analysis of the Enterprise Gantt experience. It focuses on stakeholder
requirements highlighted in *Reverse_Engineering_Odoo_Project_Gantt_Chart_Feature_Analysis_and_Dev_Plan.md*.

## Feature Highlights

- **Visual Timeline Planning** – Tasks render as resizable bars on a zoomable daily/weekly/monthly horizon.
- **Drag-and-Drop Scheduling** – Drag a task bar to instantly reschedule the task; updates propagate to successors.
- **Task Dependencies with Buffers** – Link tasks via finish-to-start relationships, including buffer delays and auto-propagation.
- **Blocking Logic** – Tasks cannot move to an “In Progress” state while predecessors remain incomplete.
- **Undo / Redo Stack** – Client-side undo/redo with server reconciliation for moves and link operations.
- **Workload Grouping** – Switch grouping between assignee, project, or stage for resource balancing.
- **Non-Working Time Awareness** – Calendar data is exposed for non-working intervals (UI overlay ready).

## Usage

1. Enable the *Plan Gantt* stat button on a project (project form → "Plan Gantt").
2. Drag task bars to reschedule; dependency-bound successors adjust automatically when buffers demand it.
3. Select two tasks and click **Link** to add a dependency, or **Unlink** to remove it.
4. Use the **Undo/Redo** controls to roll back or reapply recent planning changes.
5. Keyboard users can focus a task bar (Tab/Shift+Tab) then use **Enter/Space** to toggle selection or **← / →** to nudge the schedule by one day.

### Visual cues

- Shaded regions highlight non-working periods sourced from the project or company calendar.
- A vertical orange line marks “today” within the current zoom window.
- Dependency connectors draw elbow paths; hovering a bar surfaces the linked predecessors/successors.

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
