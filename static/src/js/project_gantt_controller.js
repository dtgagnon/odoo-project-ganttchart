/** @odoo-module */

import { registry } from "@web/core/registry";
import { Component, onWillStart } from "@odoo/owl";
import { DateTime } from "@web/core/luxon";
import { useService } from "@web/core/utils/hooks";
import { useState, useRef } from "@odoo/owl";
import { useBus } from "@web/core/utils/hooks";

const ACTION_TAG = "project_gantt_enhanced.action_gantt";
const SCALE_CONFIG = {
    day: { label: "Day", spanDays: 7, tick: "day" },
    week: { label: "Week", spanDays: 28, tick: "week" },
    month: { label: "Month", spanDays: 120, tick: "month" },
};

function toDateTime(value) {
    return value ? DateTime.fromISO(value, { zone: "utc" }).toLocal() : null;
}

export class ProjectGanttClientAction extends Component {
    static template = "project_gantt_enhanced.Gantt";

    setup() {
        this.rpc = useService("rpc");
        this.notification = useService("notification");
        this.undoService = useService("project_gantt_undo");
        this.actionService = useService("action");

        const now = DateTime.local();
        const projectId =
            this.props.context?.default_project_id || this.props.action?.params?.project_id;

        this.state = useState({
            loading: true,
            tasks: [],
            links: [],
            scale: "week",
            grouping: "user",
            start: now.startOf("week"),
            end: now.startOf("week").plus({ days: SCALE_CONFIG.week.spanDays }),
            projectId,
            selectedTaskIds: [],
            hoverTaskId: null,
            nonWorking: [],
            todayPosition: null,
        });

        this.timelineRef = useRef("timeline");

        onWillStart(async () => {
            await this.loadData();
        });


        useBus(this.undoService.bus, "undo-stack-changed", () => this.render());
    }

    get scaleOptions() {
        return Object.entries(SCALE_CONFIG).map(([key, cfg]) => ({
            key,
            ...cfg,
        }));
    }

    async loadData() {
        if (!this.state.projectId) {
            this.state.loading = false;
            return;
        }
        this.state.loading = true;
        try {
            const payload = await this.rpc("/project_gantt_enhanced/load", {
                project_id: this.state.projectId,
            });
            this.state.tasks = payload.tasks.map((task) => ({
                ...task,
                start: toDateTime(task.start),
                end: toDateTime(task.end),
            }));
            this.state.links = payload.links;
            this.state.nonWorking = (payload.meta?.non_working || []).map((slot) => ({
                start: toDateTime(slot.start),
                end: toDateTime(slot.end),
            }));
            this._updateTodayIndicator();
        } catch (error) {
            this.notification.add(
                this.env._t("Failed to load Gantt data. Please try again."),
                {
                    type: "warning",
                }
            );
            throw error;
        } finally {
            this.state.loading = false;
        }
    }

    _updateTodayIndicator() {
        const today = DateTime.local().startOf("day");
        const { start, end } = this.state;
        const total = end.toMillis() - start.toMillis();
        if (total <= 0 || today < start || today > end) {
            this.state.todayPosition = null;
            return;
        }
        this.state.todayPosition = ((today.toMillis() - start.toMillis()) / total) * 100;
    }

    get timelineTicks() {
        const ticks = [];
        const { start, end, scale } = this.state;
        const unit = SCALE_CONFIG[scale].tick;
        let cursor = start.startOf(unit);
        while (cursor < end) {
            ticks.push(cursor);
            cursor = cursor.plus({ [unit]: 1 });
        }
        return ticks;
    }

    get computedRows() {
        const rows = new Map();
        for (const task of this.state.tasks) {
            const key = this._resolveGroupingKey(task);
            if (!rows.has(key.value)) {
                rows.set(key.value, {
                    key: key.value,
                    name: key.label,
                    tasks: [],
                });
            }
            rows.get(key.value).tasks.push(task);
        }
        return Array.from(rows.values()).map((row, index) => ({
            ...row,
            index,
        }));
    }

    _resolveGroupingKey(task) {
        switch (this.state.grouping) {
            case "project":
                return {
                    value: task.project_id,
                    label: task.project_name || this.env._t("Project") + " #" + task.project_id,
                };
            case "stage":
                return {
                    value: task.stage_id,
                    label: task.stage_name || this.env._t("No Stage"),
                };
            case "user":
            default:
                return {
                    value: task.assignee_id || "__unassigned__",
                    label: task.assignee_name || this.env._t("Unassigned"),
                };
        }
    }

    computeBarStyle(dates) {
        const { start, end } = this.state;
        if (!dates.start || !dates.end) {
            return "display:none";
        }
        const total = end.toMillis() - start.toMillis();
        if (total <= 0) {
            return "display:none";
        }
        const barStart = Math.max(dates.start.toMillis(), start.toMillis());
        const barEnd = Math.min(dates.end.toMillis(), end.toMillis());
        if (barEnd <= barStart) {
            return "display:none";
        }
        const left = ((barStart - start.toMillis()) / total) * 100;
        const width = ((barEnd - barStart) / total) * 100;
        return `left:${left}%;width:${Math.max(width, 1)}%;`;
    }

    computeRowStyle(row) {
        const rowHeight = 44;
        const top = row.index * rowHeight;
        return `top:${top}px;`;
    }

    computeLinkStyle(link) {
        const source = this.state.tasks.find((task) => task.id === link.source);
        const target = this.state.tasks.find((task) => task.id === link.target);
        if (!source || !target) {
            return "";
        }
        const sourceDates = this.getTaskDates(source);
        const targetDates = this.getTaskDates(target);
        if (!sourceDates.end || !targetDates.start) {
            return "";
        }
        const { start, end } = this.state;
        const total = end.toMillis() - start.toMillis();
        if (total <= 0) {
            return "";
        }
        const sourceRight = ((sourceDates.end.toMillis() - start.toMillis()) / total) * 100;
        const targetLeft = ((targetDates.start.toMillis() - start.toMillis()) / total) * 100;
        if (targetLeft <= sourceRight) {
            return "";
        }
        const rowHeight = 44;
        const rows = this.computedRows;
        const sourceRow = rows.find((row) => row.tasks.some((task) => task.id === link.source));
        const targetRow = rows.find((row) => row.tasks.some((task) => task.id === link.target));
        if (!sourceRow || !targetRow) {
            return "";
        }
        const top = sourceRow.index * rowHeight + rowHeight / 2;
        const bottom = targetRow.index * rowHeight + rowHeight / 2;
        const height = bottom - top;
        return {
            leftPercent: sourceRight,
            widthPercent: Math.max(targetLeft - sourceRight, 0.5),
            top: Math.min(top, bottom),
            height,
        };
    }

    buildLinkPath(style) {
        const startX = style.leftPercent;
        const endX = startX + style.widthPercent;
        const midX = startX + style.widthPercent / 2;
        const startY = style.top;
        const endY = startY + style.height;
        return `M${startX},${startY} L${midX},${startY} L${midX},${endY} L${endX},${endY}`;
    }

    onSelectTask(ev, task) {
        ev.stopPropagation();
        const selected = new Set(this.state.selectedTaskIds);
        if (selected.has(task.id)) {
            selected.delete(task.id);
        } else {
            if (!ev.ctrlKey && !ev.metaKey) {
                selected.clear();
            }
            selected.add(task.id);
        }
        this.state.selectedTaskIds = Array.from(selected);
    }

    onTaskKeydown(ev, task) {
        if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            this.onSelectTask(ev, task);
        } else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
            ev.preventDefault();
            const increment = ev.key === "ArrowRight" ? 1 : -1;
            const { start, end } = this.getTaskDates(task);
            if (!start || !end) {
                return;
            }
            this.onScheduleTask(
                task,
                start.plus({ days: increment }),
                end.plus({ days: increment })
            );
        }
    }

    onTaskKeydown(ev, task) {
        if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            this.onSelectTask(ev, task);
        } else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
            ev.preventDefault();
            const increment = ev.key === "ArrowRight" ? 1 : -1;
            const { start, end } = this.getTaskDates(task);
            if (!start || !end) {
                return;
            }
            this.onScheduleTask(task, start.plus({ days: increment }), end.plus({ days: increment }));
        }
    }

    get nonWorkingSegments() {
        const { start, end } = this.state;
        const total = end.toMillis() - start.toMillis();
        if (total <= 0) {
            return [];
        }
        return this.state.nonWorking
            .map((slot) => {
                if (!slot.start || !slot.end) {
                    return null;
                }
                const segStart = Math.max(slot.start.toMillis(), start.toMillis());
                const segEnd = Math.min(slot.end.toMillis(), end.toMillis());
                if (segEnd <= segStart) {
                    return null;
                }
                return {
                    left: ((segStart - start.toMillis()) / total) * 100,
                    width: ((segEnd - segStart) / total) * 100,
                };
            })
            .filter(Boolean);
    }

    get timelineHeight() {
        const rowHeight = 44;
        return Math.max(rowHeight, this.computedRows.length * rowHeight);
    }

    isTaskSelected(task) {
        return this.state.selectedTaskIds.includes(task.id);
    }

    async onScheduleTask(task, newStart, newEnd) {
        const payload = {
            task_id: task.id,
            values: {
                planned_date_begin: newStart.toUTC().toISO(),
                planned_date_end: newEnd.toUTC().toISO(),
            },
        };
        try {
            await this.rpc("/project_gantt_enhanced/task/update", payload);
            this.undoService.push({
                type: "move",
                task_id: task.id,
                old_start: task.start.toUTC().toISO(),
                old_end: task.end.toUTC().toISO(),
                new_start: newStart.toUTC().toISO(),
                new_end: newEnd.toUTC().toISO(),
            });
            task.start = newStart;
            task.end = newEnd;
            await this.loadData();
        } catch (error) {
            this.notification.add(
                this.env._t("Failed to reschedule task."),
                {
                    type: "danger",
                }
            );
        }
    }

    onScaleChange(scale) {
        const cfg = SCALE_CONFIG[scale];
        const currentSpan = this.state.end.diff(this.state.start, "days").days || cfg.spanDays;
        const center = this.state.start.plus({ days: currentSpan / 2 });
        const halfSpan = cfg.spanDays / 2;
        this.state.scale = scale;
        this.state.start = center.minus({ days: halfSpan }).startOf("day");
        this.state.end = this.state.start.plus({ days: cfg.spanDays });
        this._updateTodayIndicator();
    }

    onShiftRange(direction) {
        const span = this.state.end.diff(this.state.start, "days").days || 1;
        const delta = Math.round(span / 3) || 1;
        this.state.start = this.state.start.plus({ days: delta * direction });
        this.state.end = this.state.end.plus({ days: delta * direction });
        this._updateTodayIndicator();
    }

    onGoToday() {
        const cfg = SCALE_CONFIG[this.state.scale];
        const today = DateTime.local().startOf("day");
        const half = cfg.spanDays / 2;
        this.state.start = today.minus({ days: half }).startOf("day");
        this.state.end = this.state.start.plus({ days: cfg.spanDays });
        this._updateTodayIndicator();
    }

    onGroupingChange(grouping) {
        this.state.grouping = grouping;
    }

    async onCreateLink() {
        if (this.state.selectedTaskIds.length !== 2) {
            this.notification.add(
                this.env._t("Select exactly two tasks to create a dependency."),
                { type: "warning" }
            );
            return;
        }
        const [sourceId, targetId] = this.state.selectedTaskIds;
        try {
            const link = await this.rpc("/project_gantt_enhanced/task/link", {
                source_id: sourceId,
                target_id: targetId,
                link_type: "fs",
            });
            this.undoService.push({
                type: "link:create",
                link_id: link.id,
                source_id: sourceId,
                target_id: targetId,
            });
            await this.loadData();
        } catch (error) {
            this.notification.add(
                this.env._t("Unable to create dependency."),
                { type: "danger" }
            );
        }
    }

    async onRemoveLink() {
        if (this.state.selectedTaskIds.length !== 2) {
            this.notification.add(
                this.env._t("Select the predecessor and successor tasks to remove a dependency."),
                { type: "warning" }
            );
            return;
        }
        const [sourceId, targetId] = this.state.selectedTaskIds;
        const link = this.state.links.find(
            (item) => item.source === sourceId && item.target === targetId
        );
        if (!link) {
            this.notification.add(
                this.env._t("No dependency exists between the selected tasks."),
                { type: "warning" }
            );
            return;
        }
        try {
            const payload = await this.rpc("/project_gantt_enhanced/task/unlink", { link_id: link.id });
            this.undoService.push({
                type: "link:delete",
                link_id: link.id,
                payload: payload,
            });
            await this.loadData();
        } catch (error) {
            this.notification.add(
                this.env._t("Unable to remove dependency."),
                { type: "danger" }
            );
        }
    }

    async onUndo() {
        try {
            await this.undoService.undo();
            await this.loadData();
        } catch (error) {
            this.notification.add(this.env._t("Nothing to undo."), { type: "info" });
        }
    }

    async onRedo() {
        try {
            await this.undoService.redo();
            await this.loadData();
        } catch (error) {
            this.notification.add(this.env._t("Nothing to redo."), { type: "info" });
        }
    }

    get canUndo() {
        return this.undoService.canUndo();
    }

    get canRedo() {
        return this.undoService.canRedo();
    }

    onTimelinePointerDown(ev, task) {
        if (ev.button !== 0) {
            return;
        }
        ev.preventDefault();
        if (!this.timelineRef.el) {
            return;
        }
        const rect = this.timelineRef.el.getBoundingClientRect();
        const totalMs = this.state.end.toMillis() - this.state.start.toMillis();
        if (totalMs <= 0 || rect.width <= 0) {
            return;
        }
        const pxPerMs = rect.width / totalMs;
        this.dragContext = {
            task,
            originX: ev.clientX,
            start: task.start,
            end: task.end,
            pxPerMs,
        };
        window.addEventListener("pointermove", this._onPointerMove);
        window.addEventListener("pointerup", this._onPointerUp, { once: true });
    }

    _onPointerMove = (ev) => {
        if (!this.dragContext) {
            return;
        }
        const deltaX = ev.clientX - this.dragContext.originX;
        const deltaMs = deltaX / this.dragContext.pxPerMs;
        const newStart = this.dragContext.start.plus({ milliseconds: deltaMs });
        const newEnd = this.dragContext.end.plus({ milliseconds: deltaMs });
        this.dragContext.previewStart = newStart;
        this.dragContext.previewEnd = newEnd;
        this.dragContext.task.__previewStart = newStart;
        this.dragContext.task.__previewEnd = newEnd;
        this.render();
    };

    _onPointerUp = async () => {
        window.removeEventListener("pointermove", this._onPointerMove);
        if (!this.dragContext) {
            return;
        }
        const { task, previewStart, previewEnd } = this.dragContext;
        if (previewStart && previewEnd) {
            await this.onScheduleTask(task, previewStart, previewEnd);
        }
        delete task.__previewStart;
        delete task.__previewEnd;
        this.dragContext = null;
    };

    getTaskDates(task) {
        if (task.__previewStart && task.__previewEnd) {
            return {
                start: task.__previewStart,
                end: task.__previewEnd,
            };
        }
        return {
            start: task.start,
            end: task.end,
        };
    }

    onOpenTask(task) {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            res_model: "project.task",
            res_id: task.id,
            views: [[false, "form"]],
            target: "current",
        });
    }

}

registry.category("actions").add(ACTION_TAG, ProjectGanttClientAction);
