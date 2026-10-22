import base64
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

import native_bridge as native


class NativeProtocolTests(unittest.TestCase):
    def request(self, value, origin=native.EXTENSION_ORIGIN):
        data = json.dumps(value).encode()
        output = io.BytesIO()
        with patch.object(native, "load_secret", return_value="ab" * 32):
            result = native.serve_native(origin, io.BytesIO(struct.pack("<I", len(data)) + data), output)
        raw = output.getvalue()
        if raw:
            self.assertEqual(struct.unpack("<I", raw[:4])[0], len(raw) - 4)
            return result, json.loads(raw[4:])
        return result, None

    def test_credentials_only_for_exact_extension_origin(self):
        result, response = self.request({"cmd": "get_bridge_credentials"})
        self.assertEqual(result, 0)
        self.assertEqual(response, {"protocol": 1, "key": "ab" * 32})
        for origin in ("", "https://evil.example/", native.EXTENSION_ORIGIN + "x"):
            self.assertEqual(self.request({"cmd": "get_bridge_credentials"}, origin), (1, None))

    def test_invalid_messages_do_not_read_credentials(self):
        for data in (b"", struct.pack("<I", native.MAX_REQUEST + 1),
                     struct.pack("<I", 3) + b"{", struct.pack("<I", 2) + b"[]"):
            output = io.BytesIO()
            with patch.object(native, "load_secret") as load:
                native.serve_native(native.EXTENSION_ORIGIN, io.BytesIO(data), output)
                load.assert_not_called()
            self.assertNotIn(b'"key"', output.getvalue())
        _, result = self.request({"cmd": "run_arbitrary_command"})
        self.assertIn("error", result)

    def test_public_key_matches_registered_extension_identity(self):
        manifest = json.loads((Path(__file__).parents[1] / "WS Browser Bridge/manifest.json").read_text())
        digest = hashlib.sha256(base64.b64decode(manifest["key"], validate=True)).digest()[:16]
        identity = "".join(chr(97 + n) for byte in digest for n in (byte >> 4, byte & 15))
        self.assertEqual(identity, native.EXTENSION_ID)
        self.assertIn("nativeMessaging", manifest["permissions"])


@unittest.skipUnless(sys.platform == "win32", "Windows DPAPI and registry")
class WindowsCredentialTests(unittest.TestCase):
    def test_secret_is_persistent_encrypted_and_corruption_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            key = native.ensure_secret(directory)
            self.assertEqual(len(key), 64)
            self.assertEqual(native.ensure_secret(directory), key)
            raw = (Path(directory) / "credential.dpapi").read_bytes()
            self.assertNotIn(bytes.fromhex(key), raw)
            self.assertNotIn(key.encode(), raw)
            (Path(directory) / "credential.dpapi").write_bytes(b"corrupt")
            with self.assertRaises(OSError):
                native.ensure_secret(directory)

    def test_registration_is_per_user_and_restricted_to_our_extension(self):
        import winreg
        from contextlib import nullcontext
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(winreg, "CreateKeyEx", return_value=nullcontext("key")) as create, \
                    patch.object(winreg, "SetValueEx") as set_value:
                secret = native.prepare_native_bridge(directory, frozen=False)
                self.assertEqual(secret, native.load_secret(directory))
            manifest = json.loads((Path(directory) / "host.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["allowed_origins"], [native.EXTENSION_ORIGIN])
            self.assertEqual(manifest["type"], "stdio")
            self.assertEqual(create.call_count, 6)
            self.assertTrue(all(call.args[0] == winreg.HKEY_CURRENT_USER for call in create.call_args_list))
            self.assertEqual(set_value.call_count, 6)

    def test_missing_release_helper_does_not_register_broken_path(self):
        import winreg
        with tempfile.TemporaryDirectory() as directory, patch.object(winreg, "CreateKeyEx") as create:
            with self.assertRaises(OSError):
                native.prepare_native_bridge(directory, Path(directory) / "FB_server.exe", frozen=True)
            create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
