# -*- coding: utf-8 -*-
from datetime import timedelta

import pytz

from odoo import fields
from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase


class TestProjectGantt(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.project = cls.env["project.project"].create(
            {
                "name": "Gantt QA",
                "gantt_enable_dependencies": True,
            }
        )
        cls.stage_progress = cls.env["project.task.type"].create(
            {
                "name": "In Progress",
                "sequence": 20,
                "project_ids": [(4, cls.project.id)],
            }
        )
        cls.stage_done = cls.env["project.task.type"].create(
            {
                "name": "Done",
                "sequence": 30,
                "fold": True,
                "project_ids": [(4, cls.project.id)],
            }
        )
        today = fields.Datetime.now()
        cls.task_predecessor = cls.env["project.task"].create(
            {
                "name": "Design",
                "project_id": cls.project.id,
                "planned_date_begin": today,
                "planned_date_end": today + timedelta(days=2),
            }
        )
        cls.task_successor = cls.env["project.task"].create(
            {
                "name": "Build",
                "project_id": cls.project.id,
                "planned_date_begin": today + timedelta(days=2),
                "planned_date_end": today + timedelta(days=4),
            }
        )
        cls.link = cls.env["project.task.link"].create(
            {
                "source_task_id": cls.task_predecessor.id,
                "target_task_id": cls.task_successor.id,
                "link_type": "fs",
                "buffer_quantity": 1,
                "buffer_unit": "day",
            }
        )

    def test_dependency_blocking_prevents_progress(self):
        """Successor cannot move to in-progress when predecessor unfinished."""
        with self.assertRaises(ValidationError):
            self.task_successor.write({"stage_id": self.stage_progress.id})

    def test_auto_propagation_applies_buffer(self):
        delta = timedelta(days=3)
        new_start = self.task_predecessor.planned_date_begin + delta
        new_end = self.task_predecessor.planned_date_end + delta
        self.task_predecessor.write(
            {
                "planned_date_begin": new_start,
                "planned_date_end": new_end,
            }
        )
        expected_start = new_end + timedelta(days=self.link.buffer_quantity)
        self.task_successor.invalidate_recordset(["planned_date_begin"])
        self.assertEqual(
            fields.Datetime.to_datetime(self.task_successor.planned_date_begin),
            expected_start,
        )

    def test_auto_propagation_multiple_successors(self):
        """When one predecessor moves, multiple successors follow respecting buffers."""
        extra_successor = self.env["project.task"].create(
            {
                "name": "QA",
                "project_id": self.project.id,
                "planned_date_begin": self.task_predecessor.planned_date_end,
                "planned_date_end": self.task_predecessor.planned_date_end
                + timedelta(days=2),
            }
        )
        link = self.env["project.task.link"].create(
            {
                "source_task_id": self.task_predecessor.id,
                "target_task_id": extra_successor.id,
                "link_type": "fs",
                "buffer_quantity": 2,
                "buffer_unit": "day",
            }
        )
        move_delta = timedelta(days=1)
        self.task_predecessor.write(
            {
                "planned_date_begin": self.task_predecessor.planned_date_begin
                + move_delta,
                "planned_date_end": self.task_predecessor.planned_date_end + move_delta,
            }
        )
        self.task_successor.invalidate_recordset(["planned_date_begin"])
        extra_successor.invalidate_recordset(["planned_date_begin"])
        expected_first = self.task_predecessor.planned_date_end + timedelta(
            days=self.link.buffer_quantity
        )
        expected_second = (
            self.task_predecessor.planned_date_end + link.get_buffer_timedelta()
        )
        self.assertEqual(
            fields.Datetime.to_datetime(self.task_successor.planned_date_begin),
            expected_first,
        )
        self.assertEqual(
            fields.Datetime.to_datetime(extra_successor.planned_date_begin),
            expected_second,
        )

    def test_dependency_unblocks_after_completion(self):
        """Blocked successor can progress once predecessor reaches a closed stage."""
        self.task_predecessor.write({"stage_id": self.stage_done.id})
        self.task_successor.invalidate_recordset(
            [
                "dependency_blocked",
                "dependency_blocker_ids",
            ]
        )
        self.assertFalse(self.task_successor.dependency_blocked)
        # Should now allow moving to progress stage without raising
        self.task_successor.write({"stage_id": self.stage_progress.id})

    def test_non_working_interval_fallback(self):
        """Non-working intervals return list even without calendars."""
        intervals = self.task_predecessor.with_context(
            employee_timezone=pytz.UTC
        )._gantt_non_working_intervals(horizon_days=1)
        self.assertIsInstance(intervals, list)

    def test_project_calendar_non_working(self):
        """Project calendar exposures feed through `_get_calendar_non_working`."""
        calendar = self.env["resource.calendar"].create(
            {"name": "Gantt Calendar", "hours_per_day": 8}
        )
        self.project.resource_calendar_id = calendar
        slots = self.project.with_context(
            employee_timezone=pytz.UTC
        )._get_calendar_non_working(horizon_days=2)
        self.assertIsInstance(slots, list)
