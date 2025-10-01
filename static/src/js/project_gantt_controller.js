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

const RESIZE_MIN_DURATION_MS = 30 * 60 * 1000; // 30 minutes

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
        this.dialogService = useService("dialog");

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
            resizingTaskId: null,
            resizePreviewStart: null,
            resizePreviewEnd: null,
            resizeHandle: null,
        });

        this.timelineRef = useRef("timeline");
        this.dragContext = null;
        this.resizeContext = null;
        this.linkingContext = null;

        this.collapsedTaskIds = new Set();
        this.visibleTaskIds = new Set();

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
            const successorMap = new Map();
            const successorNames = new Map();
            for (const link of payload.links || []) {
                if (!successorMap.has(link.source)) {
                    successorMap.set(link.source, []);
                    successorNames.set(link.source, new Map());
                }
                successorMap.get(link.source).push({
                    id: link.target,
                    name: link.target_name,
                    buffer: link.buffer,
                    buffer_unit: link.buffer_unit,
                });
                successorNames.get(link.source).set(link.target, link.target_name);
            }
            this.state.links = payload.links;
            this.state.nonWorking = (payload.meta?.non_working || []).map((slot) => ({
                start: toDateTime(slot.start),
                end: toDateTime(slot.end),
            }));
            this._cleanupCollapsed();
            this._indexLinks();
            this._clearResizePreview();
            this._updateTodayIndicator();
            for (const task of this.state.tasks) {
                const map = successorNames.get(task.id);
                if (map) {
                    task._successorNames = map;
                }
            }
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
        this.visibleTaskIds = new Set();
        const result = [];
        let rowIndex = 0;
        for (const row of rows.values()) {
            const decoratedTasks = this._buildHierarchyForRow(row.tasks, rowIndex);
            result.push({
                key: row.key,
                name: row.name,
                tasks: decoratedTasks,
                index: rowIndex,
            });
            rowIndex += 1;
        }
        return result;
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

    _cleanupCollapsed() {
        const ids = new Set(this.state.tasks.map((task) => task.id));
        for (const id of Array.from(this.collapsedTaskIds)) {
            if (!ids.has(id)) {
                this.collapsedTaskIds.delete(id);
            }
        }
    }

    _indexLinks() {
        const incomingMap = new Map();
        const outgoingMap = new Map();
        for (const task of this.state.tasks) {
            incomingMap.set(task.id, []);
            outgoingMap.set(task.id, []);
        }
        for (const link of this.state.links) {
            if (incomingMap.has(link.target)) {
                incomingMap.get(link.target).push(link);
            }
            if (outgoingMap.has(link.source)) {
                outgoingMap.get(link.source).push({
                    ...link,
                    target_name: link.target_name || this._lookupTaskName(link.target),
                });
            }
        }
        for (const task of this.state.tasks) {
            task._incomingLinks = incomingMap.get(task.id) || [];
            task._outgoingLinks = outgoingMap.get(task.id) || [];
        }
    }

    _compareTasks(a, b) {
        const startA = a.start ? a.start.toMillis() : 0;
        const startB = b.start ? b.start.toMillis() : 0;
        if (startA !== startB) {
            return startA - startB;
        }
        const seqA = a.sequence ?? 0;
        const seqB = b.sequence ?? 0;
        if (seqA !== seqB) {
            return seqA - seqB;
        }
        return (a.id || 0) - (b.id || 0);
    }

    _buildHierarchyForRow(tasks, rowIndex) {
        if (!tasks.length) {
            return [];
        }
        const nodes = new Map();
        const order = [...tasks];
        for (const task of order) {
            nodes.set(task.id, { task, children: [] });
        }
        for (const node of nodes.values()) {
            const parentId = node.task.parent_id;
            if (parentId && nodes.has(parentId)) {
                nodes.get(parentId).children.push(node);
            }
        }
        const roots = [];
        for (const node of nodes.values()) {
            const parentId = node.task.parent_id;
            if (!parentId || !nodes.has(parentId)) {
                roots.push(node);
            }
        }
        roots.sort((a, b) => this._compareTasks(a.task, b.task));
        const flatten = [];
        const visit = (node, depth) => {
            const task = node.task;
            task._depth = depth;
            task._hasChildren = node.children.length > 0;
            task._isCollapsed = task._hasChildren && this.collapsedTaskIds.has(task.id);
            task._isMilestone = Boolean(task.is_milestone);
            task._rowIndex = rowIndex;
            task._incomingLinks = task._incomingLinks || [];
            task._outgoingLinks = task._outgoingLinks || [];
            flatten.push(task);
            this.visibleTaskIds.add(task.id);
            if (!task._isCollapsed) {
                node.children.sort((aChild, bChild) => this._compareTasks(aChild.task, bChild.task));
                for (const child of node.children) {
                    visit(child, depth + 1);
                }
            }
        };
        for (const root of roots) {
            visit(root, 0);
        }
        return flatten;
    }

    _lookupTaskName(taskId) {
        const task = this.state.tasks.find((item) => item.id === taskId);
        return task ? task.name : this.env._t("Task") + ` #${taskId}`;
    }

    toggleTaskCollapse(task) {
        if (!task._hasChildren) {
            return;
        }
        if (this.collapsedTaskIds.has(task.id)) {
            this.collapsedTaskIds.delete(task.id);
        } else {
            this.collapsedTaskIds.add(task.id);
        }
        this.render();
    }

    computeSidebarTaskStyle(task) {
        const indent = (task._depth || 0) * 18;
        return `padding-left:${indent + 4}px;`;
    }

    getTaskClasses(task) {
        const classes = ["o_project_gantt_enhanced__bar"];
        if (this.isTaskSelected(task)) {
            classes.push("o-selected");
        }
        if (task._hasChildren) {
            classes.push("o_project_gantt_enhanced__bar--summary");
        }
        if (task._isMilestone) {
            classes.push("o_project_gantt_enhanced__bar--milestone");
        }
        if (this.state.hoverTaskId === task.id && this.linkingContext) {
            classes.push("o_project_gantt_enhanced__bar--link-target");
        }
        if (this.linkingContext && this.linkingContext.sourceId === task.id) {
            classes.push("o_project_gantt_enhanced__bar--link-source");
        }
        return classes.join(" ");
    }

    computeBarStyle(task) {
        const dates = this.getTaskDates(task);
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
        if (barEnd <= barStart && !task._isMilestone) {
            return "display:none";
        }
        const left = ((barStart - start.toMillis()) / total) * 100;
        if (task._isMilestone) {
            return `left:${left}%;`;
        }
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
        if (
            !this.visibleTaskIds.has(source.id) ||
            !this.visibleTaskIds.has(target.id)
        ) {
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
        if (this.linkingContext && this.linkingContext.sourceId === task.id) {
            this._cancelLinking();
        }
    }

    onTaskKeydown(ev, task) {
        if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            this.onSelectTask(ev, task);
        } else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
            ev.preventDefault();
            const direction = ev.key === "ArrowRight" ? 1 : -1;
            const { start, end } = this.getTaskDates(task);
            if (!start || !end) {
                return;
            }
            if (task._isMilestone) {
                return;
            }
            let delta;
            if (ev.ctrlKey || ev.metaKey) {
                delta = { hours: direction }; // 1 hour nudge
            } else if (ev.altKey) {
                delta = { hours: 12 * direction };
            } else if (ev.shiftKey) {
                delta = { days: 7 * direction };
            } else {
                delta = { days: direction };
            }
            const newStart = start.plus(delta);
            const newEnd = end.plus(delta);
            this.onScheduleTask(task, newStart, newEnd);
        }
        if (this.linkingContext) {
            this._cancelLinking();
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

    async onScheduleTask(task, newStart, newEnd, options = {}) {
        if (task._isMilestone) {
            return;
        }
        if (
            !options.silentDependents &&
            task._outgoingLinks &&
            task._outgoingLinks.length &&
            !this._isAutoPropagateMove(task, newStart, newEnd)
        ) {
            const dependents = task._outgoingLinks.map((link) => [
                link.target,
                link.target_name || this._lookupTaskName(link.target),
                link.id,
            ]);
            this.state.dependentPrompt = {
                sourceId: task.id,
                sourceName: task.name,
                previewStart: newStart,
                previewEnd: newEnd,
                dependents,
            };
            this.state.stagedDependentMoves = dependents.map(([id, name, linkId]) => ({
                id,
                name,
                linkId,
                startDelta: newStart.diff(task.start, "milliseconds").milliseconds,
                endDelta: newEnd.diff(task.end, "milliseconds").milliseconds,
            }));
            this.render();
            return;
        }
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
        await this._createLinkInline(sourceId, targetId);
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
            await this._removeLinkInline(link.id);
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
        if (task._isMilestone) {
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
        if (this.linkingContext) {
            this._cancelLinking();
        }
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
        if (this.dragContext.task._successorNames && this.dragContext.task._successorNames.size) {
            this.dragContext.dependents = Array.from(this.dragContext.task._successorNames.entries());
        }
        this.render();
    };

    _onPointerUp = async () => {
        window.removeEventListener("pointermove", this._onPointerMove);
        if (!this.dragContext) {
            return;
        }
        const { task, previewStart, previewEnd, dependents } = this.dragContext;
        if (previewStart && previewEnd) {
            const deferred = dependents && dependents.length ? dependents : null;
            if (deferred) {
                this.state.dependentPrompt = {
                    sourceId: task.id,
                    sourceName: task.name,
                    previewStart,
                    previewEnd,
                    dependents: deferred,
                };
                this.render();
            } else {
                await this.onScheduleTask(task, previewStart, previewEnd);
            }
        }
        this._clearDragPreview();
    };

    _clearDragPreview() {
        if (!this.dragContext) {
            return;
        }
        const { task } = this.dragContext;
        if (task) {
            delete task.__previewStart;
            delete task.__previewEnd;
        }
        this.dragContext = null;
        this.state.hoverTaskId = null;
        if (!this.state.dependentPrompt) {
            this.state.stagedDependentMoves = null;
        }
    }

    _isAutoPropagateMove(task, newStart, newEnd) {
        if (!task._outgoingLinks || !task._outgoingLinks.length) {
            return true;
        }
        for (const link of task._outgoingLinks) {
            if (link.auto_propagate) {
                return true;
            }
        }
        return false;
    }

    onResizeHandlePointerDown(ev, task, handle) {
        if (ev.button !== 0 || task._isMilestone) {
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        if (!this.timelineRef.el) {
            return;
        }
        const rect = this.timelineRef.el.getBoundingClientRect();
        const totalMs = this.state.end.toMillis() - this.state.start.toMillis();
        if (totalMs <= 0 || rect.width <= 0) {
            return;
        }
        const pxPerMs = rect.width / totalMs;
        this.resizeContext = {
            task,
            handle,
            start: task.start,
            end: task.end,
            originX: ev.clientX,
            pxPerMs,
        };
        this.state.resizingTaskId = task.id;
        this.state.resizeHandle = handle;
        this.state.resizePreviewStart = task.start;
        this.state.resizePreviewEnd = task.end;
        task.__previewStart = task.start;
        task.__previewEnd = task.end;
        window.addEventListener("pointermove", this._onResizePointerMove);
        window.addEventListener("pointerup", this._onResizePointerUp, { once: true });
    }

    _onResizePointerMove = (ev) => {
        if (!this.resizeContext) {
            return;
        }
        const deltaX = ev.clientX - this.resizeContext.originX;
        const deltaMs = deltaX / this.resizeContext.pxPerMs;
        let newStart = this.resizeContext.start;
        let newEnd = this.resizeContext.end;
        if (this.resizeContext.handle === "start") {
            newStart = this.resizeContext.start.plus({ milliseconds: deltaMs });
            if (newEnd.toMillis() - newStart.toMillis() < RESIZE_MIN_DURATION_MS) {
                newStart = newEnd.minus({ milliseconds: RESIZE_MIN_DURATION_MS });
            }
        } else {
            newEnd = this.resizeContext.end.plus({ milliseconds: deltaMs });
            if (newEnd.toMillis() - newStart.toMillis() < RESIZE_MIN_DURATION_MS) {
                newEnd = newStart.plus({ milliseconds: RESIZE_MIN_DURATION_MS });
            }
        }
        this.state.resizePreviewStart = newStart;
        this.state.resizePreviewEnd = newEnd;
        this.resizeContext.task.__previewStart = newStart;
        this.resizeContext.task.__previewEnd = newEnd;
        this.render();
    };

    _onResizePointerUp = async () => {
        window.removeEventListener("pointermove", this._onResizePointerMove);
        if (!this.resizeContext) {
            return;
        }
        const { task } = this.resizeContext;
        const newStart = this.state.resizePreviewStart || task.start;
        const newEnd = this.state.resizePreviewEnd || task.end;
        if (newStart && newEnd) {
            await this.onScheduleTask(task, newStart, newEnd);
        }
        this._clearResizePreview();
    };

    _clearResizePreview() {
        if (this.resizeContext && this.resizeContext.task) {
            delete this.resizeContext.task.__previewStart;
            delete this.resizeContext.task.__previewEnd;
        }
        this.resizeContext = null;
        this.state.resizingTaskId = null;
        this.state.resizePreviewStart = null;
        this.state.resizePreviewEnd = null;
        this.state.resizeHandle = null;
    }

    getResizeTooltip() {
        if (!this.state.resizingTaskId) {
            return null;
        }
        const task = this.state.tasks.find((item) => item.id === this.state.resizingTaskId);
        const start = this.state.resizePreviewStart || task?.start;
        const end = this.state.resizePreviewEnd || task?.end;
        if (!task || !start || !end) {
            return null;
        }
        const { start: frameStart, end: frameEnd } = this.state;
        const total = frameEnd.toMillis() - frameStart.toMillis();
        if (total <= 0) {
            return null;
        }
        const leftPercent = ((start.toMillis() - frameStart.toMillis()) / total) * 100;
        const widthPercent = ((end.toMillis() - start.toMillis()) / total) * 100;
        const center = Math.max(0, Math.min(leftPercent + widthPercent / 2, 100));
        const rowHeight = 44;
        const top = (task._rowIndex || 0) * rowHeight + 6;
        const durationHours = Math.max(end.diff(start, "minutes").minutes / 60, 0);
        const label = `${start.toFormat("LLL dd HH:mm")} → ${end.toFormat("LLL dd HH:mm")} (${durationHours.toFixed(1)} h)`;
        return {
            leftPercent: center,
            top,
            label,
        };
    }

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

    startLinkingFrom(task) {
        if (task._isMilestone) {
            return;
        }
        if (this.linkingContext && this.linkingContext.sourceId === task.id) {
            this._cancelLinking();
            return;
        }
        this.linkingContext = {
            sourceId: task.id,
            hoverTargetId: null,
        };
        this.state.selectedTaskIds = [task.id];
        window.addEventListener("pointerup", this._onLinkPointerUp);
        this.render();
    }

    onBarPointerEnter(task) {
        if (this.linkingContext) {
            if (task.id !== this.linkingContext.sourceId) {
                this.linkingContext.hoverTargetId = task.id;
                this.state.hoverTaskId = task.id;
            } else {
                this.linkingContext.hoverTargetId = null;
                this.state.hoverTaskId = null;
            }
        }
    }

    onBarPointerLeave(task) {
        if (this.linkingContext && this.linkingContext.hoverTargetId === task.id) {
            this.linkingContext.hoverTargetId = null;
        }
        if (this.state.hoverTaskId === task.id) {
            this.state.hoverTaskId = null;
        }
    }

    _onLinkPointerUp = async () => {
        const context = this.linkingContext;
        if (!context) {
            return;
        }
        const { sourceId, hoverTargetId } = context;
        if (hoverTargetId && hoverTargetId !== sourceId) {
            await this._createLinkInline(sourceId, hoverTargetId);
        }
        this._cancelLinking();
    };

    _cancelLinking() {
        if (!this.linkingContext) {
            return;
        }
        window.removeEventListener("pointerup", this._onLinkPointerUp);
        this.linkingContext = null;
        this.state.hoverTaskId = null;
        this.render();
    }

    async applyDependentMove(applyDependents) {
        const prompt = this.state.dependentPrompt;
        if (!prompt) {
            return;
        }
        const sourceTask = this.state.tasks.find((task) => task.id === prompt.sourceId);
        if (!sourceTask) {
            this.state.dependentPrompt = null;
            this.render();
            return;
        }
        this.state.dependentPrompt = null;
        this.render();
        await this.onScheduleTask(sourceTask, prompt.previewStart, prompt.previewEnd, {
            silentDependents: true,
        });
        if (applyDependents && this.state.stagedDependentMoves) {
            const moves = [];
            for (const move of this.state.stagedDependentMoves) {
                const dependentTask = this.state.tasks.find((task) => task.id === move.id);
                if (!dependentTask || dependentTask._isMilestone) {
                    continue;
                }
                const newStart = dependentTask.start.plus({ milliseconds: move.startDelta });
                const newEnd = dependentTask.end.plus({ milliseconds: move.endDelta });
                moves.push({
                    id: dependentTask.id,
                    link_id: move.linkId,
                    previous_start: dependentTask.start.toUTC().toISO(),
                    previous_end: dependentTask.end.toUTC().toISO(),
                    new_start: newStart.toUTC().toISO(),
                    new_end: newEnd.toUTC().toISO(),
                });
            }
            if (moves.length) {
                await this.rpc("/project_gantt_enhanced/task/adjust_dependents", {
                    moves,
                });
            }
        }
        this.state.stagedDependentMoves = null;
        await this.loadData();
    }

    cancelDependentMove() {
        this.state.dependentPrompt = null;
        this.state.stagedDependentMoves = null;
        this.render();
}

    async _fetchAddTaskOptions(row) {
        const normalizedKey = row.key === "__unassigned__" ? false : row.key;
        const numericKey = normalizedKey === false || normalizedKey === null ? null : Number(normalizedKey);
        return await this.rpc("/project_gantt_enhanced/task/options", {
            project_id: this.state.projectId,
            grouping: this.state.grouping,
            group_key: numericKey,
        });
    }

    openAddTaskDialog(row) {
        const defaultStart = this.state.start || DateTime.local();
        this.dialogService.add(AddTaskDialog, {
            fetchOptions: () => this._fetchAddTaskOptions(row),
            defaultStart,
            defaultDuration: 1,
            row,
            grouping: this.state.grouping,
            rpc: this.rpc,
            onConfirm: async (payload) => {
                await this._handleAddTaskConfirm(row, payload);
            },
        });
    }

    async _handleAddTaskConfirm(row, payload) {
        const grouping = this.state.grouping;
        const normalizedKey = row.key === "__unassigned__" ? false : row.key;
        const numericKey = normalizedKey === false || normalizedKey === null ? null : Number(normalizedKey);
        const start = DateTime.fromISO(payload.start || "");
        if (!start.isValid) {
            this.notification.add(this.env._t("Please enter a valid start date."), {
                type: "warning",
            });
            return;
        }
        const duration = Math.max(parseFloat(payload.duration || 1) || 1, 0.1);
        const end = start.plus({ days: duration });
        let taskId = payload.taskId;
        if (!taskId && payload.newName) {
            const result = await this.rpc("/project_gantt_enhanced/task/create", {
                project_id: this.state.projectId,
                name: payload.newName,
                grouping,
                group_key: numericKey,
            });
            taskId = result?.id;
        }
        if (!taskId) {
            this.notification.add(this.env._t("Select or create a task to schedule."), {
                type: "warning",
            });
            return;
        }
        const values = {};
        if (grouping === "user") {
            values.user_id = numericKey || false;
        } else if (grouping === "stage" && numericKey) {
            values.stage_id = numericKey;
        }
        values.planned_date_begin = start.toUTC().toISO();
        values.planned_date_end = end.toUTC().toISO();
        await this.rpc("/project_gantt_enhanced/task/update", {
            task_id: taskId,
            values,
        });
        await this.loadData();
        this.notification.add(this.env._t("Task scheduled."), { type: "success" });
    }

    async _createLinkInline(sourceId, targetId) {
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

    async _removeLinkInline(linkId) {
        try {
            const payload = await this.rpc("/project_gantt_enhanced/task/unlink", { link_id: linkId });
            this.undoService.push({
                type: "link:delete",
                link_id: linkId,
                payload,
            });
            await this.loadData();
        } catch (error) {
            this.notification.add(
                this.env._t("Unable to remove dependency."),
                { type: "danger" }
            );
        }
    }

}

registry.category("actions").add(ACTION_TAG, ProjectGanttClientAction);

class AddTaskDialog extends Component {
    static template = "project_gantt_enhanced.AddTaskDialog";

    setup() {
        const start = this.props.defaultStart || DateTime.local();
        this.state = useState({
            loading: true,
            taskOptions: [],
            selectedTaskId: null,
            newName: "",
            startValue: start.toFormat("yyyy-MM-dd'T'HH:mm"),
            duration: String(this.props.defaultDuration || 1),
        });
        onWillStart(async () => {
            const options = await this.props.fetchOptions();
            this.state.taskOptions = options;
            if (options.length) {
                this.state.selectedTaskId = options[0].id;
            }
            this.state.loading = false;
        });
    }

    get confirmDisabled() {
        const hasExisting = Boolean(this.state.selectedTaskId);
        const hasNew = Boolean(this.state.newName.trim());
        if (!hasExisting && !hasNew) {
            return true;
        }
        if (!this.state.startValue) {
            return true;
        }
        return false;
    }

    onConfirm() {
        if (this.confirmDisabled) {
            return;
        }
        const payload = {
            taskId: this.state.newName.trim() ? null : this.state.selectedTaskId,
            newName: this.state.newName.trim(),
            start: this.state.startValue,
            duration: this.state.duration,
        };
        const close = this.props.close;
        Promise.resolve(this.props.onConfirm(payload))
            .then(() => close())
            .catch((error) => {
                console.error(error);
            });
    }

    onCancel() {
        this.props.close();
    }

    onTaskSelect(ev) {
        this.state.selectedTaskId = ev.target.value ? Number(ev.target.value) : null;
    }

    onStartChange(ev) {
        this.state.startValue = ev.target.value;
    }

    onDurationChange(ev) {
        this.state.duration = ev.target.value;
    }

    onNameInput(ev) {
        this.state.newName = ev.target.value;
    }
}
