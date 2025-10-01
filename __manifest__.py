# -*- coding: utf-8 -*-
{
    "name": "Project Gantt Enhanced",
    "summary": "Interactive Gantt planning with dependencies, buffers, and workload grouping for Project tasks.",
    "description": "Implements a comprehensive Gantt planning experience for Odoo Project. Includes drag & drop scheduling, dependency enforcement, workload grouping, buffer management, non-working time overlays, and undo/redo support.",
    "version": "18.0.2.0.0",
    "category": "Project",
    "author": "dtgagnon",
    "license": "LGPL-3",
    "depends": [
        "project",
        "web",
    ],
    "data": [
        "security/ir.model.access.csv",
        "views/project_task_views.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "project_gantt_enhanced/static/src/scss/project_gantt.scss",
            "project_gantt_enhanced/static/src/js/project_gantt_controller.js",
            "project_gantt_enhanced/static/src/js/project_gantt_undo_service.js",
            "project_gantt_enhanced/static/src/xml/project_gantt_templates.xml",
        ],
    },
    "installable": True,
    "application": True,
}
