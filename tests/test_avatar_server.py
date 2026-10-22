import ast
import asyncio
import ctypes
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
        self.foreground_permissions = []
        self.allow_foreground = lambda process: self.foreground_permissions.append(process.value)
        namespace["ctypes"] = SimpleNamespace(c_uint32=ctypes.c_uint32,
            windll=SimpleNamespace(user32=SimpleNamespace(AllowSetForegroundWindow=self.allow_foreground)))
        self.dialogs = []
        namespace["messagebox"] = SimpleNamespace(
            showwarning=lambda *args, **kwargs: self.dialogs.append(args),
            showerror=lambda *args, **kwargs: self.dialogs.append(args),
            showinfo=lambda *args, **kwargs: self.dialogs.append(args))
        exec(compile(ast.Module(body=[app_class], type_ignores=[]), str(source), "exec"), namespace)
        self.app = namespace["App"].__new__(namespace["App"])
        self.app.avatar_pending = set()
        self.app.clients = {"a": object(), "b": object()}
        self.app.accounts = {}
        self.app.ports = {}
        self.app.last_seen = {}
        self.app.list_view = SimpleNamespace(exists=lambda cid: False)
        self.app.root = SimpleNamespace(after=lambda _, fn: fn(), after_idle=lambda fn: fn())
        self.app.selected_targets = lambda: ["a", "b"]
        self.states = []
        self.app.set_status = lambda cid, status: self.states.append((cid, status))
        self.app._remove_client_ui = lambda cid: None

    def test_socket_close_immediately_removes_account(self):
        self.app.clients = {}
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

    def test_duplicate_id_cannot_replace_an_existing_connection(self):
        legitimate = self.app.clients["a"]
        closed = []
        async def messages():
            yield json.dumps({"type": "init", "client_id": "a"})
        class Socket:
            def __aiter__(self): return messages()
            async def close(self, **kwargs): closed.append(kwargs["code"])
        asyncio.run(self.app.ws_handler(Socket(), 8765))
        self.assertEqual(closed, [1008])
        self.assertIs(self.app.clients["a"], legitimate)

    def test_connection_cannot_switch_ids_or_leave_an_orphan(self):
        self.app.clients = {}
        self.app.register_client_ui = lambda *args: None
        closed = []
        async def messages():
            yield json.dumps({"type": "init", "client_id": "first"})
            yield json.dumps({"type": "init", "client_id": "second"})
        class Socket:
            def __aiter__(self): return messages()
            async def close(self, **kwargs): closed.append(kwargs["code"])
        asyncio.run(self.app.ws_handler(Socket(), 8765))
        self.assertEqual(closed, [1008])
        self.assertFalse(self.app.clients)
        self.assertFalse(self.app.accounts)

    def test_busy_account_does_not_receive_new_activity_commands(self):
        sent, details = [], []
        async def send(message):
            sent.append(json.loads(message))
        self.app.clients["a"] = SimpleNamespace(send=send)
        self.app.avatar_pending.add("a")
        self.app.set_activity_detail = lambda cid, detail: details.append((cid, detail))
        for action in ("scroll30", "auto_group", "auto_custom", "auto_reels", "cancel_friend_requests", "stop_scroll"):
            asyncio.run(self.app.send(8765, "a", {"action": action}))
        self.assertFalse(sent)
        self.assertEqual(len(details), 6)
        self.assertFalse(self.states)
        self.app.avatar_pending.clear()
        asyncio.run(self.app.send(8765, "a", {"action": "scroll30"}))
        self.assertEqual(sent, [{"action": "scroll30"}])

    def test_busy_account_stop_button_keeps_avatar_state(self):
        self.app.avatar_pending = {"a", "b"}
        details = []
        self.app.set_activity_detail = lambda cid, detail: details.append(cid)
        self.app.stop_scroll()
        self.assertEqual(details, ["a", "b"])
        self.assertFalse(self.states)

    def test_identity_refresh_preserves_running_state_and_result(self):
        values = ("Alice", "123", "活跃首页", "正在浏览")
        rows = []
        def item(cid, option=None, **kwargs):
            if option == "values":
                return values
            rows.append(kwargs["values"])
        self.app.list_view = SimpleNamespace(exists=lambda cid: True, item=item)
        self.app.default_avatar = "avatar"
        self.app.avatar_photos = {}
        self.app.update_avatar_ui = lambda *args: None
        self.app.update_summary = lambda: None
        self.app.register_client_ui("a", "Alice Updated", "123")
        self.assertEqual(rows, [("Alice Updated", "123", "活跃首页", "正在浏览")])

    def test_locate_browser_only_targets_clicked_account(self):
        sent = []
        self.app.ports = {"b": 8766}
        self.app.loop = object()

        async def capture(port, cid, data):
            self.assertEqual(self.foreground_permissions, [0xFFFFFFFF])
            sent.append((port, cid, data))

        self.app.send = capture
        with patch.object(asyncio, "run_coroutine_threadsafe", side_effect=lambda coro, loop: asyncio.run(coro)):
            self.app.locate_browser("b")
            self.app.locate_browser("disconnected")
        self.assertEqual(sent, [(8766, "b", {"action": "locate_browser"})])
        self.assertFalse(self.states)

    def test_double_click_locates_only_the_clicked_row(self):
        located = []
        self.app.locate_browser = located.append
        for region in ("tree", "cell"):
            self.app.list_view = SimpleNamespace(
                identify_region=lambda x, y, value=region: value,
                identify_row=lambda y: "b", selection=lambda: ("a", "b"))
            self.assertEqual(self.app.on_account_double_click(SimpleNamespace(x=20, y=60)), "break")
        self.assertEqual(located, ["b", "b"])

    def test_double_click_ignores_heading_separator_empty_and_disconnected_rows(self):
        located = []
        self.app.locate_browser = located.append
        for region, row in (("heading", "b"), ("separator", "b"), ("nothing", ""),
                            ("cell", ""), ("cell", "disconnected")):
            self.app.list_view = SimpleNamespace(
                identify_region=lambda x, y, value=region: value,
                identify_row=lambda y, value=row: value)
            self.assertIsNone(self.app.on_account_double_click(SimpleNamespace(x=20, y=60)))
        self.assertFalse(located)

    def test_browser_foreground_is_granted_after_menu_closes(self):
        callbacks = []
        sent = []
        self.app.root.after_idle = callbacks.append
        self.app.loop = object()

        async def capture(port, cid, data):
            sent.append(cid)

        self.app.send = capture
        self.app.locate_browser("a")
        self.assertFalse(self.foreground_permissions)
        self.assertFalse(sent)
        with patch.object(asyncio, "run_coroutine_threadsafe", side_effect=lambda coro, loop: asyncio.run(coro)):
            callbacks[0]()
        self.assertEqual(self.foreground_permissions, [0xFFFFFFFF])
        self.assertEqual(sent, ["a"])

    def test_disconnected_browser_does_not_receive_foreground_permission(self):
        callbacks = []
        self.app.root.after_idle = callbacks.append
        self.app.locate_browser("a")
        self.app.clients.pop("a")
        callbacks[0]()
        self.assertFalse(self.foreground_permissions)

    def test_activity_pause_reason_reaches_the_result_column(self):
        self.app.clients = {}
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

    def test_final_activity_counts_keep_unconfirmed_actions_separate(self):
        details = []
        self.app.set_activity_detail = lambda cid, detail: details.append((cid, detail))
        self.app.show_activity_stats("a", {"attempted": {"like": 3, "comment": 2, "share": 1},
                                           "confirmed": {"like": 2, "comment": 1, "share": 0}})
        self.assertEqual(details, [("a", "点赞 2 次；评论 1 次；分享 0 次（未确认：点赞 1 次、评论 1 次、分享 1 次）")])

    def test_activity_counts_reject_invalid_values(self):
        details = []
        self.app.set_activity_detail = lambda cid, detail: details.append(detail)
        self.app.show_activity_stats("a", {"attempted": {"like": True, "comment": -2, "share": "2"},
                                           "confirmed": {"like": 999, "comment": 5, "share": 2}}, "已停止")
        self.assertEqual(details, ["已停止；点赞 0 次；评论 0 次；分享 0 次"])

    def test_zero_interaction_result_includes_skip_reason(self):
        details = []
        self.app.set_activity_detail = lambda cid, detail: details.append(detail)
        self.app.show_activity_stats("a", {"issue": "未识别到帖子容器，页面布局可能不兼容"})
        self.assertEqual(details, ["点赞 0 次；评论 0 次；分享 0 次；原因：未识别到帖子容器，页面布局可能不兼容"])

    def test_execution_detail_shows_full_result_as_separate_lines(self):
        self.app.list_view = SimpleNamespace(exists=lambda cid: cid == "a",
            set=lambda cid, column: "点赞 3 次；评论 0 次；评论：缺少帖子链接；分享：没有快拍入口")
        self.app.show_execution_detail("a")
        self.assertEqual(self.dialogs, [("执行详情", "点赞 3 次\n评论 0 次\n评论：缺少帖子链接\n分享：没有快拍入口")])
        self.app.show_execution_detail("disconnected")
        self.assertEqual(len(self.dialogs), 1)

    def test_comment_and_share_reasons_are_visible_even_when_likes_succeed(self):
        details = []
        self.app.set_activity_detail = lambda cid, detail: details.append(detail)
        self.app.show_activity_stats("a", {
            "attempted": {"like": 3}, "confirmed": {"like": 3},
            "issues": {"comment": "缺少可校验的帖子链接", "share": "没有快拍入口"}})
        self.assertEqual(details, ["点赞 3 次；评论 0 次；分享 0 次；评论：缺少可校验的帖子链接；分享：没有快拍入口"])

    def test_action_reasons_ignore_invalid_values_and_successful_actions(self):
        details = []
        self.app.set_activity_detail = lambda cid, detail: details.append(detail)
        self.app.show_activity_stats("a", {
            "attempted": {"comment": 1}, "confirmed": {"comment": 1},
            "issues": {"comment": "Old failure", "share": {"invalid": True}}})
        self.assertEqual(details, ["点赞 0 次；评论 1 次；分享 0 次"])

    def test_global_block_reason_is_not_hidden_by_action_scan_issues(self):
        details = []
        self.app.set_activity_detail = lambda cid, detail: details.append(detail)
        self.app.show_activity_stats("a", {"issue": "暂停：登录或安全验证弹框需要人工处理",
            "issues": {"like": "未找到点赞入口", "comment": "未找到评论入口", "share": "未找到分享入口"}})
        self.assertIn("点赞：未找到点赞入口", details[0])
        self.assertIn("原因：暂停：登录或安全验证弹框需要人工处理", details[0])

    def test_duplicate_global_reason_is_shown_only_once(self):
        details = []
        self.app.set_activity_detail = lambda cid, detail: details.append(detail)
        self.app.show_activity_stats("a", {"issue": "未找到点赞入口", "issues": {"like": "未找到点赞入口"}})
        self.assertEqual(details[0].count("未找到点赞入口"), 1)

    def test_stop_message_displays_counts_after_setting_idle(self):
        self.app.clients = {}
        events = []
        self.app.register_client_ui = lambda *args: None
        self.app.set_status = lambda cid, status: events.append(status)
        self.app.set_activity_detail = lambda cid, detail: events.append(detail)
        async def messages():
            yield json.dumps({"type": "init", "client_id": "a"})
            yield json.dumps({"type": "status", "status": "stop", "stats": {
                "attempted": {"like": 1}, "confirmed": {"like": 1}}})
        class Socket:
            def __aiter__(self):
                return messages()
        asyncio.run(self.app.ws_handler(Socket(), 8765))
        self.assertEqual(events, ["空闲", "点赞 1 次；评论 0 次；分享 0 次"])

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
        self.app.clients = {}
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
        self.app.clients = {}
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

    def run_avatar_batch(self, account_count, image_count):
        sent = []
        targets = [f"account-{index}" for index in range(account_count)]
        self.app.clients = dict.fromkeys(targets, object())
        self.app.selected_targets = lambda: targets
        self.app.loop = object()

        async def capture(cid, image):
            sent.append((cid, image.name))

        self.app.send_avatar = capture
        with tempfile.TemporaryDirectory() as directory:
            for index in range(image_count):
                (Path(directory) / f"avatar-{index}.png").write_bytes(b"image")
            self.app.avatar_directory = SimpleNamespace(get=lambda: directory)
            with patch.object(asyncio, "run_coroutine_threadsafe", side_effect=lambda coro, loop: asyncio.run(coro)):
                self.app.change_avatar()
        return sent

    def test_batch_uses_different_images_when_enough(self):
        sent = self.run_avatar_batch(4, 5)
        self.assertEqual(len(sent), 4)
        self.assertEqual(len({image for _, image in sent}), 4)
        self.assertFalse(self.dialogs)

    def test_batch_reuses_only_after_each_pool_is_exhausted_and_warns_once(self):
        sent = self.run_avatar_batch(7, 3)
        images = [image for _, image in sent]
        self.assertEqual(len(images), 7)
        self.assertEqual(len(set(images[:3])), 3)
        self.assertEqual(len(set(images[3:6])), 3)
        self.assertTrue(all(left != right for left, right in zip(images, images[1:])))
        self.assertEqual(sorted(images.count(image) for image in set(images)), [2, 2, 3])
        self.assertEqual(len(self.dialogs), 1)
        self.assertEqual(self.dialogs[0][0], "头像数量不足")
        self.assertIn("7 个账号", self.dialogs[0][1])
        self.assertIn("3 张", self.dialogs[0][1])

    def test_single_image_can_be_reused_with_warning(self):
        sent = self.run_avatar_batch(3, 1)
        self.assertEqual(len(sent), 3)
        self.assertEqual(len({image for _, image in sent}), 1)
        self.assertEqual(len(self.dialogs), 1)


if __name__ == "__main__":
    unittest.main()
