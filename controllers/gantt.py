# -*- coding: utf-8 -*-
from odoo import http, fields
from odoo.exceptions import UserError
from odoo.http import request


class ProjectGanttController(http.Controller):
    @http.route("/project_gantt_enhanced/load", type="json", auth="user")
    def load(self, project_id=None, domain=None):
        if not project_id and request.env.context.get("default_project_id"):
            project_id = request.env.context.get("default_project_id")
        if not project_id:
            return {"tasks": [], "links": [], "meta": {}}
        project = request.env["project.project"].browse(project_id)
        project._check_access_rights("read")
        task_model = request.env["project.task"].with_context(active_test=False)
        base_domain = [("project_id", "=", project_id)]
        if domain:
            base_domain += domain
        tasks = task_model.search(base_domain)
        result_tasks = []
        for task in tasks:
            result_tasks.append(
                {
                    "id": task.id,
                    "name": task.display_name,
                    "start": fields.Datetime.to_string(
                        task.planned_date_begin or task.date_deadline
                    ),
                    "end": fields.Datetime.to_string(
                        task.planned_date_end or task.date_deadline
                    ),
                    "progress": task.progress,
                    "assignee_id": task.user_id.id,
                    "assignee_name": task.user_id.partner_id.name,
                    "project_id": task.project_id.id,
                    "project_name": task.project_id.display_name,
                    "stage_id": task.stage_id.id,
                    "stage_name": task.stage_id.display_name,
                    "blocked": task.dependency_blocked,
                    "kanban_state": task.kanban_state,
                    "is_milestone": task.is_milestone,
                    "parent_id": task.parent_id.id,
                    "color": task.color,
                    "sequence": task.sequence,
                }
            )
        result_links = []
        for link in request.env["project.task.link"].search(
            [
                ("source_task_id", "in", tasks.ids),
                ("target_task_id", "in", tasks.ids),
            ]
        ):
            result_links.append(
                {
                    "id": link.id,
                    "source": link.source_task_id.id,
                    "source_name": link.source_task_id.display_name,
                    "target": link.target_task_id.id,
                    "target_name": link.target_task_id.display_name,
                    "type": link.link_type,
                    "buffer": link.buffer_quantity,
                    "buffer_unit": link.buffer_unit,
                    "auto_propagate": link.auto_propagate,
                }
            )
        return {
            "tasks": result_tasks,
            "links": result_links,
            "meta": {
                "non_working": project._get_calendar_non_working(),
                "project_name": project.display_name,
                "gantt_enable_dependencies": project.gantt_enable_dependencies,
            },
        }

    @http.route("/project_gantt_enhanced/task/update", type="json", auth="user")
    def update_task(self, task_id, values, undo_context=None):
        task = request.env["project.task"].browse(task_id)
        task._check_access_rule("write")
        write_vals = {}
        for key, value in values.items():
            if key in {"planned_date_begin", "planned_date_end"} and value:
                write_vals[key] = fields.Datetime.from_string(value)
            else:
                write_vals[key] = value
        previous = {
            "planned_date_begin": task.planned_date_begin,
            "planned_date_end": task.planned_date_end,
        }
        task.with_context(undo_context or {}).write(write_vals)
        return {
            "id": task.id,
            "write_vals": write_vals,
            "previous": previous,
        }

    @http.route("/project_gantt_enhanced/task/link", type="json", auth="user")
    def link_task(
        self,
        source_id,
        target_id,
        link_type="fs",
        buffer_quantity=0.0,
        buffer_unit="day",
        auto_propagate=True,
    ):
        env = request.env
        Task = env["project.task"]
        if source_id == target_id:
            raise UserError("A task cannot depend on itself.")
        source_task = Task.browse(source_id)
        target_task = Task.browse(target_id)
        source_task._check_access_rule("read")
        target_task._check_access_rule("write")
        if not target_task.project_id or source_task.project_id != target_task.project_id:
            raise UserError("Dependencies must link tasks inside the same project.")
        if not target_task.project_id.gantt_enable_dependencies:
            raise UserError("Dependencies are disabled on this project.")
        vals = {
            "source_task_id": source_task.id,
            "target_task_id": target_task.id,
            "link_type": link_type,
            "buffer_quantity": buffer_quantity,
            "buffer_unit": buffer_unit,
            "auto_propagate": auto_propagate,
        }
        link = env["project.task.link"].create(vals)
        return {
            "id": link.id,
            "source": link.source_task_id.id,
            "source_name": link.source_task_id.display_name,
            "target": link.target_task_id.id,
            "target_name": link.target_task_id.display_name,
            "type": link.link_type,
            "buffer": link.buffer_quantity,
            "buffer_unit": link.buffer_unit,
            "auto_propagate": link.auto_propagate,
        }

    @http.route("/project_gantt_enhanced/task/unlink", type="json", auth="user")
    def unlink_task(self, link_id):
        link = request.env["project.task.link"].browse(link_id)
        if not link.exists():
            raise UserError("Dependency link not found.")
        link._check_access_rule("unlink")
        target_task = link.target_task_id
        previous = {
            "id": link.id,
            "source": link.source_task_id.id,
            "target": link.target_task_id.id,
            "link_type": link.link_type,
            "buffer_quantity": link.buffer_quantity,
            "buffer_unit": link.buffer_unit,
            "auto_propagate": link.auto_propagate,
        }
        link.unlink()
        if target_task:
            target_task.invalidate_recordset(
                ["dependency_link_ids", "dependency_blocked", "dependency_blocker_ids"]
            )
        return previous

    @http.route("/project_gantt_enhanced/task/options", type="json", auth="user")
    def task_options(self, project_id, grouping=None, group_key=None):
        Task = request.env["project.task"].sudo()
        domain = [
            ("project_id", "=", project_id),
            ("planned_date_begin", "=", False),
            ("planned_date_end", "=", False),
        ]
        normalized_key = group_key
        if normalized_key in ("__unassigned__", None):
            normalized_key = False
        if grouping == "user":
            if normalized_key:
                domain.append(("user_id", "=", int(normalized_key)))
            else:
                domain.append(("user_id", "=", False))
        elif grouping == "stage" and normalized_key:
            domain.append(("stage_id", "=", int(normalized_key)))
        elif grouping == "project" and normalized_key:
            domain.append(("project_id", "=", int(normalized_key)))
        tasks = Task.search(domain, limit=50, order="name asc")
        return [
            {
                "id": task.id,
                "name": task.display_name,
            }
            for task in tasks
        ]

    @http.route("/project_gantt_enhanced/task/create", type="json", auth="user")
    def create_task(self, project_id, name, grouping=None, group_key=None):
        env = request.env
        project = env["project.project"].browse(project_id)
        project._check_access_rights("read")
        vals = {"name": name, "project_id": project_id}
        normalized_key = group_key
        if normalized_key in ("__unassigned__", None):
            normalized_key = False
        if grouping == "user":
            if normalized_key:
                vals["user_id"] = int(normalized_key)
            else:
                vals["user_id"] = False
        elif grouping == "stage" and normalized_key:
            vals["stage_id"] = int(normalized_key)
        task = env["project.task"].sudo().create(vals)
        return {"id": task.id, "name": task.display_name}

    @http.route("/project_gantt_enhanced/task/adjust_dependents", type="json", auth="user")
    def adjust_dependents(self, moves):
        processed = request.env["project.task"].sudo()._gantt_adjust_dependents(moves)
        return {"moved": processed}

    @http.route("/project_gantt_enhanced/task/undo", type="json", auth="user")
    def undo_action(self, action):
        """Basic undo endpoint; expects an action dict from the client stack."""
        action_type = action.get("type")
        response = {"status": "ok"}
        if action_type == "move":
            task = request.env["project.task"].browse(action["task_id"])
            task.with_context(skip_gantt_hooks=True).write(
                {
                    "planned_date_begin": fields.Datetime.from_string(
                        action["old_start"]
                    ),
                    "planned_date_end": fields.Datetime.from_string(action["old_end"]),
                }
            )
        elif action_type == "link:create":
            request.env["project.task.link"].sudo().browse(action["link_id"]).unlink()
        elif action_type == "link:delete":
            new_link = request.env["project.task.link"].sudo().create(action["payload"])
            response["link_id"] = new_link.id
        return response


class Project(http.Controller):
    @http.route("/project_gantt_enhanced/project/non_working", type="json", auth="user")
    def non_working(self, project_id, horizon_days=30):
        project = request.env["project.project"].browse(project_id)
        return {
            "non_working": project._get_calendar_non_working(horizon_days=horizon_days)
        }
