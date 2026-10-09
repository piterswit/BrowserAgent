import ast
import asyncio
import json
import random
import time
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
                     "random": random, "asyncio": asyncio, "json": json, "time": time, "websockets": SimpleNamespace(ConnectionClosed=type("ConnectionClosed", (Exception,), {}))}
        self.dialogs = []
        namespace["messagebox"] = SimpleNamespace(
            showwarning=lambda *args, **kwargs: self.dialogs.append(args),
            showerror=lambda *args, **kwargs: self.dialogs.append(args))
        exec(compile(ast.Module(body=[app_class], type_ignores=[]), str(source), "exec"), namespace)
        self.app = namespace["App"].__new__(namespace["App"])
        self.app.avatar_pending = set()
        self.app.clients = {"a": object(), "b": object()}
        self.app.accounts = {}
        self.app.ports = {}
        self.app.last_seen = {}
        self.app.list_view = SimpleNamespace(exists=lambda cid: False)
        self.app.root = SimpleNamespace(after=lambda _, fn: fn())
        self.app.selected_targets = lambda: ["a", "b"]
        self.states = []
        self.app.set_status = lambda cid, status: self.states.append((cid, status))
        self.app._remove_client_ui = lambda cid: None

    def test_socket_close_immediately_removes_account(self):
        async def messages():
            yield json.dumps({"type": "init", "client_id": "a", "fb_name": "Alice"})
        class Socket:
            def __aiter__(self):
                return messages()
        ws = Socket()
        self.app.register_client_ui = lambda *args: None
        asyncio.run(self.app.ws_handler(ws, 8765))
        self.assertNotIn("a", self.app.clients)
        self.assertNotIn("a", self.app.last_seen)
        self.assertNotIn("a", self.app.accounts)

    def test_custom_activity_sends_its_own_action(self):
        sent = []
        self.app.ports = {"a": 8765}
        self.app.loop = object()

        async def capture(port, cid, data):
            sent.append((cid, data))

        self.app.send = capture
        with patch.object(asyncio, "run_coroutine_threadsafe", side_effect=lambda coro, loop: asyncio.run(coro)):
            self.app.auto_custom()
        self.assertEqual(sent, [("a", {"action": "auto_custom"})])

    def test_locate_browser_only_targets_clicked_account(self):
        sent = []
        self.app.ports = {"b": 8766}
        self.app.loop = object()

        async def capture(port, cid, data):
            sent.append((port, cid, data))

        self.app.send = capture
        with patch.object(asyncio, "run_coroutine_threadsafe", side_effect=lambda coro, loop: asyncio.run(coro)):
            self.app.locate_browser("b")
            self.app.locate_browser("disconnected")
        self.assertEqual(sent, [(8766, "b", {"action": "locate_browser"})])

    def test_activity_pause_reason_reaches_the_result_column(self):
        details = []
        self.app.register_client_ui = lambda *args: None
        self.app.set_activity_detail = lambda cid, detail: details.append((cid, detail))

        async def messages():
            yield json.dumps({"type": "init", "client_id": "a", "fb_name": "Alice"})
            yield json.dumps({"type": "activity_detail", "detail": "暂停：页面存在可见弹窗或菜单"})

        class Socket:
            def __aiter__(self):
                return messages()

        asyncio.run(self.app.ws_handler(Socket(), 8765))
        self.assertEqual(details, [("a", "暂停：页面存在可见弹窗或菜单")])

    def test_stop_is_pending_until_browser_acknowledges(self):
        sent = []
        callbacks = []
        self.app.ports = {"a": 8765}
        self.app.loop = object()
        self.app.root = SimpleNamespace(after=lambda delay, fn: callbacks.append(fn))

        async def capture(port, cid, data):
            sent.append((cid, data))

        self.app.send = capture
        with patch.object(asyncio, "run_coroutine_threadsafe", side_effect=lambda coro, loop: asyncio.run(coro)):
            self.app.stop_scroll()
        self.assertEqual(self.states[-1], ("a", "正在停止"))
        self.assertEqual(sent, [("a", {"action": "stop_scroll"})])
        self.assertEqual(len(callbacks), 1)

    def test_stop_confirmation_timeout_is_not_success(self):
        errors = []
        self.app.list_view = SimpleNamespace(exists=lambda cid: True, set=lambda *args: "正在停止")
        self.app.activity_error = lambda cid, detail: errors.append((cid, detail))
        self.app.check_stop_confirmation("a")
        self.assertIn("未收到停止确认", errors[0][1])

    def test_real_websocket_disconnect_removes_account(self):
        import websockets
        ready = asyncio.Event()
        self.app.register_client_ui = lambda *args: ready.set()

        async def scenario():
            async with websockets.serve(lambda ws: self.app.ws_handler(ws, 8765), "127.0.0.1", 0) as listener:
                port = listener.sockets[0].getsockname()[1]
                async with websockets.connect(f"ws://127.0.0.1:{port}") as socket:
                    await socket.send(json.dumps({"type": "init", "client_id": "a", "fb_name": "Alice"}))
                    await asyncio.wait_for(ready.wait(), 2)
                    self.assertIn("a", self.app.clients)
                for _ in range(100):
                    if "a" not in self.app.clients:
                        break
                    await asyncio.sleep(0.01)
                self.assertNotIn("a", self.app.clients)

        asyncio.run(scenario())

    def test_old_connection_cannot_remove_replacement(self):
        replacement = object()
        async def messages():
            yield json.dumps({"type": "init", "client_id": "a", "fb_name": "Alice"})
            self.app.clients["a"] = replacement
        class Socket:
            def __aiter__(self):
                return messages()
        self.app.register_client_ui = lambda *args: None
        asyncio.run(self.app.ws_handler(Socket(), 8765))
        self.assertIs(self.app.clients["a"], replacement)

    def test_closed_socket_and_missing_heartbeat_are_removed(self):
        self.app.clients = {"a": SimpleNamespace(close_code=1000), "b": SimpleNamespace(close_code=None)}
        self.app.last_seen = {"a": time.time(), "b": time.time() - 61}
        self.app.root = SimpleNamespace(after=lambda *args: None)
        self.app.check_alive()
        self.assertFalse(self.app.clients)
        self.assertFalse(self.app.last_seen)

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
        self.assertEqual(sent, [{"action": "change_avatar", "file_path": str(image), "profile_url": None}])
        self.app.avatar_pending.add("missing")
        asyncio.run(self.app.send_avatar("missing", image))
        self.assertNotIn("missing", self.app.avatar_pending)
        self.assertEqual(self.states[-1][1], "执行失败")

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
