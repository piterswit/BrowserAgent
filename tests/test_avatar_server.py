import ast
import asyncio
import json
import random
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


class AvatarServerTest(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "server.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        app_class = next(node for node in tree.body if isinstance(node, ast.ClassDef))
        namespace = {"tb": SimpleNamespace(Window=object), "Path": Path,
                     "random": random, "asyncio": asyncio, "json": json}
        self.dialogs = []
        namespace["messagebox"] = SimpleNamespace(
            showwarning=lambda *args, **kwargs: self.dialogs.append(args),
            showerror=lambda *args, **kwargs: self.dialogs.append(args))
        exec(compile(ast.Module(body=[app_class], type_ignores=[]), str(source), "exec"), namespace)
        self.app = namespace["App"].__new__(namespace["App"])
        self.app.avatar_pending = set()
        self.app.clients = {"a": object(), "b": object()}
        self.app.root = SimpleNamespace(after=lambda _, fn: fn())
        self.app.selected_targets = lambda: ["a", "b"]
        self.states = []
        self.app.set_status = lambda cid, status: self.states.append((cid, status))

    def test_empty_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            self.app.avatar_directory = SimpleNamespace(get=lambda: directory)
            self.app.change_avatar()
        self.assertEqual(len(self.dialogs), 1)
        self.assertFalse(self.app.avatar_pending)

    def test_send_path_and_release_pending_on_error(self):
        sent = []

        async def send(message):
            sent.append(json.loads(message))

        self.app.clients["a"] = SimpleNamespace(send=send)
        image = Path("D:/avatars/photo.png")
        asyncio.run(self.app.send_avatar("a", image))
        self.assertEqual(sent, [{"action": "change_avatar", "file_path": str(image)}])
        self.app.avatar_pending.add("missing")
        asyncio.run(self.app.send_avatar("missing", image))
        self.assertNotIn("missing", self.app.avatar_pending)
        self.assertIn("发送失败", self.states[-1][1])

    def test_batch_filters_images_and_skips_pending_accounts(self):
        sent = []

        async def capture(cid, image):
            sent.append((cid, image))

        self.app.send_avatar = capture
        self.app.loop = object()
        self.app.avatar_pending.add("b")
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "头像.PNG"
            image.write_bytes(b"image")
            (Path(directory) / "notes.txt").write_text("ignored")
            (Path(directory) / "empty.jpg").touch()
            self.app.avatar_directory = SimpleNamespace(get=lambda: directory)
            with patch.object(asyncio, "run_coroutine_threadsafe", side_effect=lambda coro, loop: asyncio.run(coro)):
                self.app.change_avatar()
            self.assertEqual(sent, [("a", image)])
            self.assertEqual(self.app.avatar_pending, {"a", "b"})


if __name__ == "__main__":
    unittest.main()
