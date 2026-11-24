import importlib.util
import json
import struct
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SPEC = importlib.util.spec_from_file_location(
    "check_release", Path(__file__).resolve().parents[1] / "tools" / "check_release.py"
)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    @staticmethod
    def native_image(subsystem=2, managed=True):
        data = bytearray(512)
        data[:2] = b"MZ"
        struct.pack_into("<I", data, 0x3c, 64)
        data[64:68] = b"PE\0\0"
        struct.pack_into("<H", data, 88, 0x10b)
        struct.pack_into("<H", data, 88 + 68, subsystem)
        if managed:
            struct.pack_into("<II", data, 88 + 96 + 14 * 8, 0x2000, 72)
        return bytes(data)

    def setUp(self):
        manifest = json.loads(
            (release.EXTENSION / "manifest.json").read_text(encoding="utf-8")
        )
        self.tag = "v" + release.release_version(manifest)

    def test_versions_match(self):
        release.check_versions(self.tag)

    def test_wrong_tag_rejected(self):
        with self.assertRaises(ValueError):
            release.check_versions("v999.0")

    def test_beta_version_keeps_chrome_numeric_version_separate(self):
        self.assertEqual(release.release_version({"version": "0.9.0", "version_name": "0.9.0-beta.1"}), "0.9.0-beta.1")
        self.assertEqual(release.release_version({"version": "0.9.0"}), "0.9.0")
        for manifest in [{"version": "0.9-beta"}, {"version": "0.09.0"}, {"version": "0.9.65536"},
                         {"version": "0.0"}, {"version": "0.9.0", "version_name": "0.8.0-beta.1"}]:
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                release.release_version(manifest)

    def make_archive(self, path, omit=None, extra=None, version=None, corrupt=None):
        prefix = f"FB_Auto_Active_{self.tag}/"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(prefix + "FB_server.exe", b"test executable")
            if omit != "conf/FB_bridge_host.exe":
                archive.writestr(prefix + "conf/FB_bridge_host.exe", self.native_image())
            archive.writestr(prefix + "README.md", "test readme")
            for file in release.EXTENSION.rglob("*"):
                if not file.is_file():
                    continue
                relative = file.relative_to(release.EXTENSION).as_posix()
                if relative == omit:
                    continue
                data = file.read_bytes()
                if relative == corrupt:
                    data = b"stale extension script"
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

    def test_unreviewed_extension_files_cannot_be_distributed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            self.make_archive(path, extra="Browser_Extension/.env")
            with self.assertRaisesRegex(ValueError, "Unexpected local file"):
                release.check_archive(path, self.tag)

    def test_extension_copy_does_not_include_local_secrets_or_backups(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source", Path(directory) / "target"
            source.mkdir()
            (source / "manifest.json").write_text("{}")
            (source / ".env").write_text("local config, not a real credential")
            (source / "backup.js").write_text("local backup")
            with patch.object(release, "EXTENSION", source), patch.object(release, "EXTENSION_FILES", ("manifest.json",)):
                release.copy_extension(target)
            self.assertEqual([p.name for p in target.iterdir()], ["manifest.json"])

    def test_stale_packaged_script_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            self.make_archive(path, corrupt="bg.js")
            with self.assertRaisesRegex(ValueError, "differs from source"):
                release.check_archive(path, self.tag)

    def test_console_and_python_launcher_native_images_rejected(self):
        for image in (self.native_image(subsystem=3), self.native_image(managed=False), b"invalid"):
            with self.assertRaises(ValueError):
                release.check_native_host_image(image)

    def test_missing_asset_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            self.make_archive(path, omit="icon/avatar-placeholder.png")
            with self.assertRaises(ValueError):
                release.check_archive(path, self.tag)

    def test_missing_native_host_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            self.make_archive(path, omit="conf/FB_bridge_host.exe")
            with self.assertRaises(ValueError):
                release.check_archive(path, self.tag)

    def test_user_configuration_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            self.make_archive(path, extra="conf/config.json")
            with self.assertRaises(ValueError):
                release.check_archive(path, self.tag)

    def test_native_host_must_not_be_exposed_at_release_root(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            self.make_archive(path, extra="FB_bridge_host.exe")
            with self.assertRaises(ValueError):
                release.check_archive(path, self.tag)

    def test_packaged_version_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            self.make_archive(path, version="999.0")
            with self.assertRaises(ValueError):
                release.check_archive(path, self.tag)
