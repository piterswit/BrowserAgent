import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import config_store


class ConfigurationTest(unittest.TestCase):
    def test_source_directory_is_independent_of_working_directory(self):
        self.assertEqual(config_store.application_directory(), Path(config_store.__file__).resolve().parent)

    def test_packaged_directory_uses_executable_not_extraction_directory(self):
        with patch.object(sys, "frozen", True, create=True), \
                patch.object(sys, "executable", "D:/Apps/BrowserAgent/server.exe"), \
                patch.object(sys, "_MEIPASS", "D:/Temp/extracted", create=True):
            self.assertEqual(config_store.application_directory(), Path("D:/Apps/BrowserAgent"))

    def test_roundtrip_and_atomic_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            data = {"avatar_directory": "D:/头像/照片", "other": True}
            config_store.save_configuration(data, directory)
            self.assertEqual(config_store.load_configuration(directory), data)
            config_store.save_configuration({**data, "avatar_directory": "E:/photos"}, directory)
            path = Path(directory) / "conf" / "config.json"
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["avatar_directory"], "E:/photos")
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_missing_corrupt_and_nonobject_config(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(config_store.load_configuration(directory), {})
            folder = Path(directory) / "conf"
            folder.mkdir()
            for value in ["invalid json", "[]", "null"]:
                (folder / "config.json").write_text(value, encoding="utf-8")
                self.assertEqual(config_store.load_configuration(directory), {})
