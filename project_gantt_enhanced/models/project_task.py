# -*- coding: utf-8 -*-
from datetime import timedelta

from pytz import timezone as pytz_timezone

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


class ProjectTask(models.Model):
    _inherit = "project.task"

    planned_date_begin = fields.Datetime(tracking=True)
    planned_date_end = fields.Datetime(tracking=True)
    dependency_link_ids = fields.One2many(
        "project.task.link",
        "target_task_id",
        string="Predecessors",
    )
    successor_link_ids = fields.One2many(
        "project.task.link",
        "source_task_id",
        string="Successors",
    )
    dependency_blocker_ids = fields.Many2many(
        "project.task",
        compute="_compute_dependency_blocker_ids",
        compute_sudo=True,
        string="Blocking Tasks",
        help="List of predecessors that are not yet satisfied.",
    )
    dependency_blocked = fields.Boolean(
        compute="_compute_dependency_blocked",
        compute_sudo=True,
        string="Blocked by Dependencies",
        store=True,
    )
    auto_schedule = fields.Boolean(
        default=True,
        string="Auto Schedule",
        help="When enabled, the task automatically reacts to predecessor movements.",
    )
    workload_group_key = fields.Selection(
        selection="_selection_workload_group_key",
        default="user",
        string="Workload Grouping",
        help="Preferred grouping when displaying this task in a resource-centric Gantt row.",
    )
    last_schedule_write_uid = fields.Many2one(
        "res.users",
        string="Last Scheduler",
        readonly=True,
        tracking=True,
    )
    last_schedule_write_date = fields.Datetime(
        string="Last Schedule Update",
        readonly=True,
        tracking=True,
    )

    def _selection_workload_group_key(self):
        return [
            ("user", "Assignee"),
            ("project", "Project"),
            ("stage", "Stage"),
        ]

    @api.depends(
        "dependency_link_ids.source_task_id",
        "dependency_link_ids.source_task_id.stage_id",
        "dependency_link_ids.source_task_id.active",
    )
    def _compute_dependency_blocker_ids(self):
        blockers_map = self._gantt_collect_dependency_blockers()
        for task in self:
            blockers = blockers_map.get(task.id, blockers_map.get(task))
            task.dependency_blocker_ids = blockers

    @api.depends(
        "dependency_link_ids.source_task_id",
        "dependency_link_ids.source_task_id.stage_id",
        "dependency_link_ids.source_task_id.active",
    )
    def _compute_dependency_blocked(self):
        blockers_map = self._gantt_collect_dependency_blockers()
        for task in self:
            blockers = blockers_map.get(task.id, blockers_map.get(task))
            task.dependency_blocked = bool(blockers)

    def _gantt_dependency_blockers(self):
        self.ensure_one()
        blockers = self.env["project.task"]
        for link in self.dependency_link_ids:
            predecessor = link.source_task_id
            if not predecessor._gantt_is_completed_for_dependency(link):
                blockers |= predecessor
        return blockers

    def _gantt_collect_dependency_blockers(self):
        """Helper used by compute fields to avoid recomputing dependencies twice."""
        blockers_map = {}
        for task in self:
            record_key = task.id or task
            blockers_map[record_key] = task._gantt_dependency_blockers()
        return blockers_map

    def _gantt_is_completed_for_dependency(self, link=None):
        self.ensure_one()
        if not self.active:
            return True
        kanban_state = getattr(self, "kanban_state", False)
        if kanban_state == "done":
            return True
        stage = self.stage_id
        if stage and getattr(stage, "is_closed", False):
            return True
        if stage and stage.fold:
            return True
        return False

    def _gantt_has_cycle(self, upstream_task):
        self.ensure_one()
        visited = set()

        def dfs(task):
            if task.id in visited:
                return False
            visited.add(task.id)
            if task == self:
                return True
            for link in task.dependency_link_ids:
                if dfs(link.source_task_id):
                    return True
            return False

        return dfs(upstream_task)

    def write(self, vals):
        if self.env.context.get("skip_gantt_hooks"):
            return super().write(vals)
        schedule_fields = {"planned_date_begin", "planned_date_end"}
        schedule_changed = bool(schedule_fields & set(vals))
        res = super().write(vals)
        if schedule_changed:
            self._gantt_propagate_successors(vals)
            self._gantt_track_schedule_author()
        if "stage_id" in vals or "kanban_state" in vals:
            self._gantt_validate_blocking(vals)
        return res

    def _gantt_validate_blocking(self, vals):
        if self.env.context.get("bypass_dependency_blocking"):
            return
        target_stage = None
        if "stage_id" in vals:
            target_stage = self.env["project.task.type"].browse(vals["stage_id"])
        for task in self:
            blockers = task._gantt_dependency_blockers()
            if not blockers:
                continue
            kanban_state = vals.get("kanban_state")
            if kanban_state in {"done", "normal"}:
                raise ValidationError(
                    _(
                        "Task %(task)s is blocked by unfinished predecessors: %(deps)s",
                        task=task.display_name,
                        deps=", ".join(blockers.mapped("display_name")),
                    )
                )
            if (
                target_stage
                and not target_stage.fold
                and not getattr(target_stage, "is_blocking_stage", False)
            ):
                raise ValidationError(
                    _(
                        "Cannot move '%(task)s' to stage '%(stage)s' until predecessors are completed.",
                        task=task.display_name,
                        stage=target_stage.display_name,
                    )
                )

    def _gantt_propagate_successors(self, vals):
        for task in self:
            if not task.successor_link_ids:
                continue
            for link in task.successor_link_ids.filtered("auto_propagate"):
                successor = link.target_task_id
                if not successor or successor == task:
                    continue
                if not successor.auto_schedule:
                    continue
                successor._gantt_apply_predecessor_move(task, link)

    def _gantt_apply_predecessor_move(self, predecessor, link):
        self.ensure_one()
        if self.env.context.get("suppress_gantt_propagation"):
            return
        start = self.planned_date_begin
        end = self.planned_date_end
        predecessor_start = predecessor.planned_date_begin
        predecessor_end = predecessor.planned_date_end
        if not (start and end and predecessor_start and predecessor_end):
            return
        buffer_delta = link.get_buffer_timedelta()
        desired_start = predecessor_end + buffer_delta

        if link.link_type == "ss":
            desired_start = predecessor_start + buffer_delta
        elif link.link_type == "ff":
            duration = end - start
            desired_end = predecessor_end + buffer_delta
            desired_start = desired_end - duration
        elif link.link_type == "sf":
            duration = end - start
            desired_end = predecessor_start + buffer_delta
            desired_start = desired_end - duration

        if desired_start <= start:
            return

        duration = end - start
        new_start = desired_start
        new_end = new_start + duration
        previous_start = start
        previous_end = end
        self.with_context(
            skip_gantt_hooks=True, suppress_gantt_propagation=True
        ).sudo().write(
            {
                "planned_date_begin": new_start,
                "planned_date_end": new_end,
            }
        )
        self.env["project.task.buffer"].sudo()._log_auto_propagation(
            predecessor,
            self,
            link,
            new_start,
            new_end,
            previous_start=previous_start,
            previous_end=previous_end,
        )

    def _gantt_track_schedule_author(self):
        vals = {
            "last_schedule_write_uid": self.env.user.id,
            "last_schedule_write_date": fields.Datetime.now(),
        }
        self.with_context(skip_gantt_hooks=True).write(vals)

    def action_open_gantt(self):
        self.ensure_one()
        return {
            "type": "ir.actions.client",
            "tag": "project_gantt_enhanced.action_gantt",
            "context": {
                "active_id": self.id,
                "active_model": "project.task",
                "default_project_id": self.project_id.id,
            },
        }

    def _gantt_gantt_payload(self, extra_domain=None):
        domain = [
            ("project_id", "=", self.project_id.id),
        ]
        if extra_domain:
            domain += extra_domain
        tasks = self.search(domain)
        result = []
        for task in tasks:
            result.append(
                {
                    "id": task.id,
                    "name": task.display_name,
                    "start": fields.Datetime.to_string(
                        task.planned_date_begin or task.date_deadline
                    ),
                    "end": fields.Datetime.to_string(
                        task.planned_date_end or task.date_deadline
                    ),
                    "is_milestone": task.is_milestone,
                    "assignee_id": task.user_id.id,
                    "assignee_name": task.user_id.partner_id.name,
                    "project_id": task.project_id.id,
                    "stage_id": task.stage_id.id,
                    "blocked": task.dependency_blocked,
                    "blockers": task.dependency_blocker_ids.mapped("id"),
                    "successors": task.successor_link_ids.mapped("target_task_id").ids,
                }
            )
        return result

    def _gantt_non_working_intervals(self, horizon_days=30):
        self.ensure_one()
        if self.project_id:
            return self.project_id._get_calendar_non_working(horizon_days=horizon_days)
        calendar = self.env.user.company_id.resource_calendar_id
        if not calendar:
            return []
        start = self._gantt_now_with_tz()
        end = start + timedelta(days=horizon_days)
        work_intervals_map = calendar._work_intervals_batch(start, end)
        intervals = work_intervals_map.get(False) or []
        non_working = []
        cursor = start
        for interval in intervals:
            interval_start = interval[0]
            interval_end = interval[1]
            if interval_start > cursor:
                non_working.append(
                    {
                        "start": fields.Datetime.to_string(cursor),
                        "end": fields.Datetime.to_string(interval_start),
                    }
                )
            cursor = interval_end
        if cursor < end:
            non_working.append(
                {
                    "start": fields.Datetime.to_string(cursor),
                    "end": fields.Datetime.to_string(end),
                }
            )
        return non_working


class Project(models.Model):
    _inherit = "project.project"

    gantt_enable_dependencies = fields.Boolean(
        string="Enable Gantt Dependencies",
        default=True,
        help="Allow tasks in this project to participate in dependency scheduling.",
    )

    def _get_calendar_non_working(self, horizon_days=30):
        self.ensure_one()
        calendar = self.resource_calendar_id or self.company_id.resource_calendar_id
        if not calendar:
            return []
        start = self._gantt_now_with_tz()
        end = start + timedelta(days=horizon_days)
        work_intervals_map = calendar._work_intervals_batch(start, end)
        intervals = work_intervals_map.get(False) or []
        non_working = []
        cursor = start
        for interval in intervals:
            interval_start = interval[0]
            interval_end = interval[1]
            if interval_start > cursor:
                non_working.append(
                    {
                        "start": fields.Datetime.to_string(cursor),
                        "end": fields.Datetime.to_string(interval_start),
                    }
                )
            cursor = interval_end
        if cursor < end:
            non_working.append(
                {
                    "start": fields.Datetime.to_string(cursor),
                    "end": fields.Datetime.to_string(end),
                }
            )
        return non_working

    def _gantt_now_with_tz(self):
        tzname = self.env.context.get("employee_timezone") or self.env.user.tz or "UTC"
        timestamp = fields.Datetime.context_timestamp(
            self.with_context(tz=tzname), fields.Datetime.now()
        )
        if timestamp.tzinfo is None:
            timestamp = pytz_timezone(tzname).localize(timestamp)
        return timestamp
