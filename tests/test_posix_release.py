import ast
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
SPEC = importlib.util.spec_from_file_location("build_posix_release", TOOLS / "build_posix_release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class PosixReleaseTests(unittest.TestCase):
    manifest = {"version": "0.9.0", "version_name": "0.9.0-beta.1"}

    def test_architecture_selection_rejects_cross_architecture_python(self):
        for actual, requested, expected in [("arm64", "auto", "arm64"), ("aarch64", "arm64", "arm64"),
                                            ("AMD64", "x64", "x86_64"), ("x86_64", "x86_64", "x86_64")]:
            self.assertEqual(release.native_architecture(actual, requested), expected)
        for actual, requested in [("arm64", "x64"), ("x86_64", "arm64"), ("i686", "auto")]:
            with self.subTest(actual=actual, requested=requested), self.assertRaises(ValueError):
                release.native_architecture(actual, requested)

    def test_mac_spec_builds_native_onedir_bundle_with_version_and_host(self):
        for architecture in ("arm64", "x86_64"):
            with self.subTest(architecture=architecture):
                source = release.macos_spec(Path("source space 中文"), Path("work"), Path("host/FB_bridge_host"), architecture, self.manifest)
                tree = ast.parse(source)
                calls = {node.func.id: node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
                exe = {item.arg: ast.literal_eval(item.value) for item in calls["EXE"].keywords}
                self.assertEqual(exe["target_arch"], architecture)
                self.assertTrue(exe["exclude_binaries"])
                self.assertFalse(exe["console"])
                self.assertIsNone(exe["codesign_identity"])
                bundle = {item.arg: ast.literal_eval(item.value) for item in calls["BUNDLE"].keywords}
                self.assertEqual(bundle["info_plist"]["CFBundleShortVersionString"], "0.9.0")
                self.assertEqual(bundle["info_plist"]["CFBundleVersion"], "0.9.0")
                self.assertEqual(bundle["info_plist"]["CFBundleGetInfoString"], "0.9.0-beta.1")
                data = ast.literal_eval(next(item.value for item in calls["Analysis"].keywords if item.arg == "datas"))
                self.assertIn((str(Path("host/FB_bridge_host")), "conf"), data)

    def make_bundle(self, directory):
        bundle = Path(directory) / "BrowserAgent.app"
        for relative in ("Contents/MacOS/BrowserAgent", "Contents/Resources/conf/FB_bridge_host"):
            file = bundle / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"fixture Mach-O")
        (bundle / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "com.browseragent.desktop", "CFBundleShortVersionString": "0.9.0",
            "CFBundleGetInfoString": "0.9.0-beta.1"}))
        return bundle

    def test_both_mac_executables_are_checked_before_signature_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = self.make_bundle(directory)
            with patch.object(release.os, "access", return_value=True), \
                    patch.object(release.subprocess, "check_output", return_value="arm64\n") as architectures, \
                    patch.object(release.subprocess, "run") as signing:
                release.verify_macos_bundle(bundle, "arm64", self.manifest)
                self.assertEqual(architectures.call_count, 2)
                signing.assert_called_once_with(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(bundle)], check=True)

    def test_wrong_host_architecture_or_version_cannot_be_packaged(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = self.make_bundle(directory)
            with patch.object(release.os, "access", return_value=True), \
                    patch.object(release.subprocess, "check_output", side_effect=["arm64", "x86_64"]), \
                    patch.object(release.subprocess, "run") as signing:
                with self.assertRaisesRegex(RuntimeError, "Wrong architecture"):
                    release.verify_macos_bundle(bundle, "arm64", self.manifest)
                signing.assert_not_called()
            (bundle / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": "0.8.1"}))
            with self.assertRaisesRegex(RuntimeError, "metadata"):
                release.verify_macos_bundle(bundle, "arm64", self.manifest)

    def test_compiled_host_must_authenticate_with_isolated_credentials(self):
        key = "1" * 64
        for response_key, expected in [(key, True), ("2" * 64, False)]:
            message = json.dumps({"protocol": 1, "key": response_key}).encode()
            results = [subprocess.CompletedProcess([], 1, b"", b""),
                       subprocess.CompletedProcess([], 0, struct.pack("<I", len(message)) + message, b"")]
            with self.subTest(expected=expected), patch("posix_native.ensure_secret", return_value=key), \
                    patch.object(release.subprocess, "run", side_effect=results) as run:
                if expected:
                    release.verify_native_host(Path("/tmp/FB_bridge_host"), "darwin")
                else:
                    with self.assertRaisesRegex(RuntimeError, "invalid credentials"):
                        release.verify_native_host(Path("/tmp/FB_bridge_host"), "darwin")
                env = run.call_args.kwargs["env"]
                self.assertNotEqual(env["HOME"], str(Path.home()))


if __name__ == "__main__":
    unittest.main()
