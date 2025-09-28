/** @odoo-module */

import { registry } from "@web/core/registry";
import { EventBus } from "@odoo/owl";

const undoService = {
    dependencies: ["rpc", "notification"],
    start(env, { rpc, notification }) {
        const undoStack = [];
        const redoStack = [];
        const bus = new EventBus();

        function emitChange() {
            bus.trigger("undo-stack-changed");
        }

        return {
            bus,
            push(action) {
                undoStack.push(action);
                redoStack.length = 0;
                emitChange();
            },
            canUndo() {
                return undoStack.length > 0;
            },
            canRedo() {
                return redoStack.length > 0;
            },
            async undo() {
                if (!undoStack.length) {
                    notification.add(env._t("Nothing to undo."), { type: "info" });
                    throw new Error("Undo stack empty");
                }
                const action = undoStack.pop();
                redoStack.push(action);
                emitChange();
                const response = await rpc("/project_gantt_enhanced/task/undo", { action });
                if (action.type === "link:delete" && response && response.link_id) {
                    action.link_id = response.link_id;
                    action.payload.id = response.link_id;
                }
            },
            async redo() {
                if (!redoStack.length) {
                    notification.add(env._t("Nothing to redo."), { type: "info" });
                    throw new Error("Redo stack empty");
                }
                const action = redoStack.pop();
                undoStack.push(action);
                emitChange();
                if (action.type === "move") {
                    await rpc("/project_gantt_enhanced/task/update", {
                        task_id: action.task_id,
                        values: {
                            planned_date_begin: action.new_start,
                            planned_date_end: action.new_end,
                        },
                        undo_context: { skip_gantt_hooks: false },
                    });
                } else if (action.type === "link:create") {
                    const res = await rpc("/project_gantt_enhanced/task/link", {
                        source_id: action.source_id,
                        target_id: action.target_id,
                    });
                    action.link_id = res.id;
                } else if (action.type === "link:delete") {
                    await rpc("/project_gantt_enhanced/task/unlink", {
                        link_id: action.link_id,
                    });
                }
            },
        };
    },
};

registry.category("services").add("project_gantt_undo", undoService);
