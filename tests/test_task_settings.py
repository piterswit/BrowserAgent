import ast
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from config_store import load_configuration, save_configuration
from task_settings import DEFAULT_TASK_SETTINGS, normalize_task_settings, validate_task_settings


class TaskSettingsTest(unittest.TestCase):
    def test_defaults_and_corrupt_values(self):
        for value in (None, [], {}, {"activity_minutes": True, "cancel_request_limit": 0},
                      {"activity_minutes": "20", "cancel_request_limit": 1001}):
            self.assertEqual(normalize_task_settings(value), DEFAULT_TASK_SETTINGS)

    def test_valid_boundaries_and_integer_inputs(self):
        self.assertEqual(validate_task_settings({"activity_minutes": " 15 ", "cancel_request_limit": "200"}),
                         {"activity_minutes": 15, "cancel_request_limit": 200})
        for minutes, limit in ((1, 1), (1440, 1000)):
            values = {"activity_minutes": minutes, "cancel_request_limit": limit}
            self.assertEqual(normalize_task_settings(values), values)
            self.assertEqual(validate_task_settings(values), values)

    def test_invalid_settings_do_not_silently_save(self):
        for key, invalid in (("activity_minutes", "0"), ("activity_minutes", "1441"),
                             ("activity_minutes", "1.5"), ("cancel_request_limit", "-1"),
                             ("cancel_request_limit", "1001"), ("cancel_request_limit", "")):
            with self.subTest(key=key, invalid=invalid), self.assertRaises(ValueError):
                validate_task_settings({**DEFAULT_TASK_SETTINGS, key: invalid})

    def test_settings_roundtrip_preserves_other_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            configuration = {"avatar_directory": "D:/photos", "task_settings": {"activity_minutes": 12, "cancel_request_limit": 55}}
            save_configuration(configuration, directory)
            self.assertEqual(load_configuration(directory), configuration)


class TaskSettingsServerTest(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "server.py"
        app_class = next(node for node in ast.parse(source.read_text(encoding="utf-8")).body if isinstance(node, ast.ClassDef))
        namespace = {"tb": SimpleNamespace(Window=object), "asyncio": asyncio, "json": json}
        exec(compile(ast.Module(body=[app_class], type_ignores=[]), str(source), "exec"), namespace)
        self.app = namespace["App"].__new__(namespace["App"])
        self.app.configuration = {"other": "preserve"}
        self.app.clients = {}
        self.app.loop = object()
        self.sent = []

        async def send(message):
            self.sent.append(json.loads(message))

        self.socket = SimpleNamespace(send=send)

    def test_settings_sync_sends_both_defaults_or_saved_values(self):
        asyncio.run(self.app.send_task_settings(self.socket))
        self.assertEqual(self.sent[-1], {"action": "update_task_settings", "settings": DEFAULT_TASK_SETTINGS})
        self.app.configuration["task_settings"] = {"activity_minutes": 9, "cancel_request_limit": 80}
        asyncio.run(self.app.send_task_settings(self.socket))
        self.assertEqual(self.sent[-1]["settings"], self.app.configuration["task_settings"])

    def test_failed_save_rolls_back_and_does_not_broadcast(self):
        self.app.persist_configuration = lambda: False
        self.assertFalse(self.app.save_task_settings({"activity_minutes": 9, "cancel_request_limit": 80}))
        self.assertEqual(self.app.configuration, {"other": "preserve"})

    def test_successful_save_broadcasts_to_connected_browsers(self):
        self.app.persist_configuration = lambda: True
        self.app.clients = {"a": self.socket, "b": self.socket}
        with patch.object(asyncio, "run_coroutine_threadsafe", side_effect=lambda coroutine, loop: asyncio.run(coroutine)):
            self.assertTrue(self.app.save_task_settings({"activity_minutes": 9, "cancel_request_limit": 80}))
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(self.sent[0]["settings"]["activity_minutes"], 9)
        self.assertEqual(self.app.configuration["other"], "preserve")
