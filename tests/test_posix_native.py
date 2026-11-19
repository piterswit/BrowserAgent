import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import native_bridge
import posix_native
from posix_instance import PosixSingleInstance


@unittest.skipIf(sys.platform == "win32", "Requires POSIX permissions, flock and executable launchers")
class PosixNativeTests(unittest.TestCase):
    def test_secret_persists_privately_and_corruption_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            key = posix_native.ensure_secret(directory)
            self.assertEqual(key, posix_native.ensure_secret(directory))
            path = Path(directory) / "credential.key"
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(Path(directory).stat().st_mode & 0o777, 0o700)
            path.write_bytes(b"corrupt")
            with self.assertRaises(ValueError):
                posix_native.ensure_secret(directory)

    def test_symlinks_and_world_readable_credentials_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            outside = folder / "outside"
            outside.write_bytes(b"x" * 32)
            (folder / "credential.key").symlink_to(outside)
            with self.assertRaises(OSError):
                posix_native.ensure_secret(folder)
            (folder / "credential.key").unlink()
            posix_native.ensure_secret(folder)
            (folder / "credential.key").chmod(0o644)
            with self.assertRaises(OSError):
                posix_native.load_secret(folder)

    def test_registration_and_real_host_roundtrip_with_spaces_and_unicode(self):
        with tempfile.TemporaryDirectory(prefix="bridge space 中文 ") as directory:
            base = Path(directory)
            folder = base / "private"
            destination = base / "browser/NativeMessagingHosts"
            with patch.object(posix_native, "manifest_directories", return_value=[destination]):
                key = posix_native.prepare_native_bridge(folder, frozen=False)
            manifest = json.loads((destination / (native_bridge.HOST_NAME + ".json")).read_text())
            self.assertEqual(manifest["allowed_origins"], [native_bridge.EXTENSION_ORIGIN])
            self.assertTrue(os.access(manifest["path"], os.X_OK))
            # Point the separate host process at the same private test credential store.
            script = "import native_bridge,sys; native_bridge.state_directory=lambda: __import__('pathlib').Path(sys.argv[2]); raise SystemExit(native_bridge.main())"
            message = json.dumps({"cmd": "get_bridge_credentials"}).encode()
            packet = struct.pack("<I", len(message)) + message
            result = subprocess.run([sys.executable, "-c", script, native_bridge.EXTENSION_ORIGIN, str(folder)],
                                    input=packet, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            size = struct.unpack("<I", result.stdout[:4])[0]
            self.assertEqual(size, len(result.stdout) - 4)
            self.assertEqual(json.loads(result.stdout[4:]), {"protocol": 1, "key": key})
            denied = subprocess.run([manifest["path"], "chrome-extension://wrong/"], input=b"", capture_output=True, timeout=10)
            self.assertEqual(denied.returncode, 1)
            self.assertEqual(denied.stdout, b"")

    def test_two_instances_share_lock_and_signal_primary(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second, replacement = (PosixSingleInstance(directory=directory) for _ in range(3))
            try:
                self.assertTrue(first.claim())
                self.assertFalse(second.claim())
                self.assertNotEqual(first.token(), first.observed)
                second.close()
                first.close()
                self.assertTrue(replacement.claim())
            finally:
                first.close()
                second.close()
                replacement.close()

    def test_frozen_helper_must_exist_and_be_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with self.assertRaises(OSError):
                posix_native.prepare_native_bridge(folder / "state", folder / "app/FB_server", frozen=True)

    def test_nonregular_credential_file_is_rejected_without_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            os.mkfifo(Path(directory) / "credential.key", mode=0o600)
            with self.assertRaises(OSError):
                posix_native.load_secret(directory)

    def test_frozen_bundle_resolves_the_native_helper_without_a_python_install(self):
        for bundle in (False, True):
            with self.subTest(bundle=bundle), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                executable = base / "BrowserAgent.app/Contents/MacOS/FB_server" if bundle else base / "FB_server"
                host = base / "BrowserAgent.app/Contents/Resources/conf/FB_bridge_host" if bundle else base / "conf/FB_bridge_host"
                host.parent.mkdir(parents=True)
                host.write_text("#!/bin/sh\nexit 1\n")
                host.chmod(0o700)
                with patch.object(posix_native, "manifest_directories", return_value=[base / "manifests"]):
                    posix_native.prepare_native_bridge(base / "state", executable, frozen=True)
                manifest = json.loads((base / "state/host.json").read_text())
                self.assertEqual(manifest["path"], str(host.resolve()))


if __name__ == "__main__":
    unittest.main()
