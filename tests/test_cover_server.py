import ast
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from post_manager import available_images, shuffled_cycles


class CoverServerTest(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "server.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        app_class = next(node for node in tree.body if isinstance(node, ast.ClassDef))
        self.dialogs = []
        namespace = {
            "tb": SimpleNamespace(Window=object), "Path": Path, "uuid4": uuid4,
            "json": json, "asyncio": asyncio, "available_images": available_images,
            "shuffled_cycles": shuffled_cycles,
            "messagebox": SimpleNamespace(
                showwarning=lambda *args, **kwargs: self.dialogs.append(args),
                showerror=lambda *args, **kwargs: self.dialogs.append(args),
                askyesno=lambda *args, **kwargs: True,
            ),
        }
        exec(compile(ast.Module(body=[app_class], type_ignores=[]), str(source), "exec"), namespace)
        self.app = namespace["App"].__new__(namespace["App"])
        self.app.clients = {"a": object(), "b": object()}
        self.app.ports = {}
        self.app.accounts = {cid: {"profile_url": f"https://www.facebook.com/{cid}"} for cid in self.app.clients}
        self.app.avatar_pending = set()
        self.app.post_pending = {}
        self.app.cover_pending = {}
        self.states = {cid: "空闲" for cid in self.app.clients}
        self.details = {}
        self.timers = []
        self.app.root = SimpleNamespace(after=lambda duration, callback: self.timers.append((duration, callback)))
        self.app.list_view = SimpleNamespace(
            exists=lambda cid: cid in self.states,
            set=lambda cid, column, value=None: self.details.update({cid: value}) if value is not None else self.states[cid],
            item=lambda *args, **kwargs: None,
        )
        self.app.set_status = lambda cid, state: self.states.update({cid: state})
        self.app.selected_targets = lambda: ["a", "b"]
        self.app.loop = object()
        self.sent = []

        async def send_cover(cid, task_id, image, profile):
            self.sent.append((cid, task_id, image, profile))

        self.app.send_cover = send_cover
        self.run = patch.object(asyncio, "run_coroutine_threadsafe", side_effect=lambda coroutine, loop: asyncio.run(coroutine))

    def test_cover_batch_skips_busy_and_unidentified_accounts(self):
        self.app.post_pending["b"] = "post-task"
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "wide.png"
            image.write_bytes(b"fixture")
            (Path(directory) / "empty.jpg").touch()
            self.app.cover_directory = SimpleNamespace(get=lambda: directory)
            with self.run:
                self.app.change_cover()
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(self.sent[0][0], "a")
            self.assertEqual(self.sent[0][2], image.resolve())
            self.assertEqual(self.sent[0][3], "https://www.facebook.com/a")
        self.assertEqual(self.states["a"], "更换封面中")
        self.assertEqual(self.app.post_pending["b"], "post-task")

    def test_cover_batch_distributes_without_repetition(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ("one.png", "two.jpg"):
                (Path(directory) / name).write_bytes(b"fixture")
            self.app.cover_directory = SimpleNamespace(get=lambda: directory)
            with self.run:
                self.app.change_cover()
        self.assertEqual(len({entry[2] for entry in self.sent}), 2)
        self.assertEqual(len({entry[1] for entry in self.sent}), 2)

    def test_old_cover_result_cannot_finish_new_task(self):
        self.app.cover_pending["a"] = "new"
        self.app.finish_cover("a", "old", True, True, "stale")
        self.assertEqual(self.app.cover_pending["a"], "new")
        self.assertNotIn("a", self.details)
        self.app.finish_cover("a", "new", True, False, "请核对")
        self.assertNotIn("a", self.app.cover_pending)
        self.assertEqual(self.states["a"], "待核实")

    def test_cover_timeout_is_pending_and_late_timeout_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "cover.png").write_bytes(b"fixture")
            self.app.cover_directory = SimpleNamespace(get=lambda: directory)
            with self.run:
                self.app.change_cover()
        self.timers[0][1]()
        self.assertEqual(self.states["a"], "待核实")
        task = self.app.cover_pending["b"]
        self.app.finish_cover("b", task, True, True, "已更新")
        self.timers[1][1]()
        self.assertEqual(self.states["b"], "封面已更新")

    def test_cover_task_blocks_posts_avatars_and_activity_commands(self):
        self.app.cover_pending = {"a": "cover"}
        self.assertFalse(self.app.post_available("a"))
        self.app.set_activity_detail = lambda cid, detail: self.details.update({cid: detail})
        asyncio.run(self.app.send(None, "a", {"action": "scroll30"}))
        self.app.stop_scroll()
        self.assertIn("更换封面中", self.details["a"])

    def test_empty_directory_does_not_start_tasks(self):
        with tempfile.TemporaryDirectory() as directory:
            self.app.cover_directory = SimpleNamespace(get=lambda: directory)
            self.app.change_cover()
        self.assertFalse(self.sent)
        self.assertFalse(self.app.cover_pending)
        self.assertEqual(len(self.dialogs), 1)

    def test_lost_connection_releases_cover_pending(self):
        self.app.cover_pending["missing"] = "task"
        self.app.root.after = lambda duration, callback: callback()
        actual_send = self.app.__class__.send_cover
        asyncio.run(actual_send(self.app, "missing", "task", Path("D:/cover.png"), "https://www.facebook.com/a"))
        self.assertNotIn("missing", self.app.cover_pending)
        self.assertEqual(self.states.get("missing"), "更换封面失败")

    def test_expired_queued_cover_is_not_sent(self):
        self.app.cover_pending["a"] = "new-task"
        self.app.clients["a"] = SimpleNamespace(send=lambda _: self.fail("expired task was sent"))
        asyncio.run(self.app.__class__.send_cover(
            self.app, "a", "old-task", Path("D:/cover.png"), "https://www.facebook.com/a"))
        self.assertEqual(self.app.cover_pending["a"], "new-task")
        self.assertFalse(self.timers)

    def test_account_switch_rejects_cover_before_sending(self):
        self.app.cover_pending["a"] = "task"
        self.app.accounts["a"]["profile_url"] = "https://www.facebook.com/changed"
        self.app.clients["a"] = SimpleNamespace(send=lambda _: self.fail("changed account task was sent"))
        asyncio.run(self.app.__class__.send_cover(
            self.app, "a", "task", Path("D:/cover.png"), "https://www.facebook.com/a"))
        self.timers[-1][1]()
        self.assertNotIn("a", self.app.cover_pending)
        self.assertEqual(self.states["a"], "更换封面失败")


if __name__ == "__main__":
    unittest.main()
