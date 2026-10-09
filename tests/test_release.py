import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


SPEC = importlib.util.spec_from_file_location(
    "check_release", Path(__file__).resolve().parents[1] / "tools" / "check_release.py"
)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tag = "v" + json.loads(
            (release.EXTENSION / "manifest.json").read_text(encoding="utf-8")
        )["version"]

    def test_versions_match(self):
        release.check_versions(self.tag)

    def test_wrong_tag_rejected(self):
        with self.assertRaises(ValueError):
            release.check_versions("v999.0")

    def make_archive(self, path, omit=None, extra=None, version=None):
        prefix = f"FB_Auto_Active_{self.tag}/"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(prefix + "FB_server.exe", b"test executable")
            archive.writestr(prefix + "README.md", "test readme")
            for file in release.EXTENSION.rglob("*"):
                if not file.is_file():
                    continue
                relative = file.relative_to(release.EXTENSION).as_posix()
                if relative == omit:
                    continue
                data = file.read_bytes()
                if relative == "manifest.json" and version:
                    manifest = json.loads(data)
                    manifest["version"] = version
                    data = json.dumps(manifest).encode()
                archive.writestr(prefix + "Browser_Extension/" + relative, data)
            if extra:
                archive.writestr(prefix + extra, "test")

    def test_complete_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            self.make_archive(path)
            release.check_archive(path, self.tag)

    def test_missing_asset_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            self.make_archive(path, omit="icon/avatar-placeholder.png")
            with self.assertRaises(ValueError):
                release.check_archive(path, self.tag)

    def test_user_configuration_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            self.make_archive(path, extra="conf/config.json")
            with self.assertRaises(ValueError):
                release.check_archive(path, self.tag)

    def test_packaged_version_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            self.make_archive(path, version="999.0")
            with self.assertRaises(ValueError):
                release.check_archive(path, self.tag)
