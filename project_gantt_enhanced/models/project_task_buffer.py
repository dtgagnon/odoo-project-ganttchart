# -*- coding: utf-8 -*-
from odoo import api, fields, models


class ProjectTaskBuffer(models.Model):
    _name = "project.task.buffer"
    _description = "Task Buffer & Propagation Journal"
    _order = "create_date desc"

    link_id = fields.Many2one(
        "project.task.link",
        required=True,
        ondelete="cascade",
    )
    predecessor_id = fields.Many2one(
        "project.task",
        related="link_id.source_task_id",
        store=True,
    )
    successor_id = fields.Many2one(
        "project.task",
        related="link_id.target_task_id",
        store=True,
    )
    previous_start = fields.Datetime()
    previous_end = fields.Datetime()
    new_start = fields.Datetime(required=True)
    new_end = fields.Datetime(required=True)
    user_id = fields.Many2one(
        "res.users",
        required=True,
        default=lambda self: self.env.user,
    )
    trigger = fields.Selection(
        [
            ("auto", "Automatic"),
            ("manual", "Manual"),
            ("undo", "Undo"),
            ("redo", "Redo"),
        ],
        default="auto",
        required=True,
    )
    comment = fields.Text()

    @api.model
    def _log_auto_propagation(
        self,
        predecessor,
        successor,
        link,
        new_start,
        new_end,
        previous_start=None,
        previous_end=None,
        trigger="auto",
    ):
        self.create(
            {
                "link_id": link.id,
                "previous_start": previous_start,
                "previous_end": previous_end,
                "new_start": new_start,
                "new_end": new_end,
                "trigger": trigger,
            }
        )

    @api.model
    def record_manual_adjustment(
        self, link, previous_start, previous_end, new_start, new_end, comment=None
    ):
        return self.create(
            {
                "link_id": link.id,
                "previous_start": previous_start,
                "previous_end": previous_end,
                "new_start": new_start,
                "new_end": new_end,
                "trigger": "manual",
                "comment": comment,
            }
        )
