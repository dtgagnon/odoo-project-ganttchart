# -*- coding: utf-8 -*-
from datetime import timedelta

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


class ProjectTaskLink(models.Model):
    """Directional dependency link between two project tasks."""

    _name = "project.task.link"
    _description = "Task Dependency Link"
    _order = "source_task_id, sequence, id"

    source_task_id = fields.Many2one(
        "project.task",
        required=True,
        ondelete="cascade",
        string="Predecessor",
        help="Task that must be completed before the successor can proceed.",
    )
    target_task_id = fields.Many2one(
        "project.task",
        required=True,
        ondelete="cascade",
        string="Successor",
    )
    sequence = fields.Integer(default=10)
    link_type = fields.Selection(
        [
            ("fs", "Finish to Start"),
            ("ss", "Start to Start"),
            ("ff", "Finish to Finish"),
            ("sf", "Start to Finish"),
        ],
        default="fs",
        required=True,
        string="Relation",
        help="Project scheduling relationship enforced between the two tasks.",
    )
    buffer_quantity = fields.Float(
        default=0.0,
        string="Buffer",
        help="Positive number shifts the successor by a delay once dependency conditions are met.",
    )
    buffer_unit = fields.Selection(
        [
            ("hour", "Hours"),
            ("day", "Days"),
        ],
        default="day",
        required=True,
    )
    auto_propagate = fields.Boolean(
        string="Auto Propagate",
        default=True,
        help="Automatically push/pull the successor when the predecessor is rescheduled.",
    )

    _sql_constraints = [
        (
            "project_task_link_unique",
            "unique(source_task_id, target_task_id)",
            "A dependency between these tasks already exists.",
        ),
    ]

    @api.constrains("source_task_id", "target_task_id")
    def _check_loop(self):
        for link in self:
            if link.source_task_id == link.target_task_id:
                raise ValidationError(_("A task cannot depend on itself."))
            if link.target_task_id._gantt_has_cycle(link.source_task_id):
                raise ValidationError(
                    _("Creating this dependency would introduce a scheduling cycle.")
                )

    def get_buffer_timedelta(self):
        self.ensure_one()
        quantity = self.buffer_quantity
        if not quantity:
            return timedelta()
        if self.buffer_unit == "hour":
            return timedelta(hours=quantity)
        return timedelta(days=quantity)
