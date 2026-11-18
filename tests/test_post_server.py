import ast
import asyncio
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4


class PostServerTest(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "server.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        app_class = next(node for node in tree.body if isinstance(node, ast.ClassDef))
        namespace = {"tb": SimpleNamespace(Window=object), "uuid4": uuid4,
                     "asyncio": asyncio, "json": json}
        exec(compile(ast.Module(body=[app_class], type_ignores=[]), str(source), "exec"), namespace)
        self.app = namespace["App"].__new__(namespace["App"])
        self.sent, self.timers, self.details = [], [], {}

        async def send(payload):
            self.sent.append(json.loads(payload))

        self.app.clients = {"a": SimpleNamespace(send=send), "b": SimpleNamespace(send=send)}
        self.app.accounts = {cid: {"profile_url": f"https://www.facebook.com/{cid}"}
                             for cid in self.app.clients}
        self.app.avatar_pending, self.app.cover_pending, self.app.post_pending = set(), {}, {}
        self.states = {cid: "空闲" for cid in self.app.clients}
        self.app.root = SimpleNamespace(after=lambda duration, fn: self.timers.append((duration, fn)))
        self.app.list_view = SimpleNamespace(
            exists=lambda cid: cid in self.states,
            set=lambda cid, key, value=None: self.details.update({cid: value}) if value is not None else self.states[cid],
            item=lambda *args, **kwargs: None)
        self.app.set_status = lambda cid, state: self.states.update({cid: state})
        self.app.loop = object()
        self.run = patch.object(asyncio, "run_coroutine_threadsafe",
                                side_effect=lambda coroutine, loop: asyncio.run(coroutine))

    def assignment(self, cid="a", text="Hello", image=None):
        return cid, text, f"https://www.facebook.com/{cid}", image

    def test_batch_sends_distinct_tasks_and_expected_payload(self):
        with self.run:
            self.assertTrue(self.app.start_post([self.assignment(image=Path("D:/photo.png")), self.assignment("b")]))
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(len({message["task_id"] for message in self.sent}), 2)
        self.assertEqual(self.sent[0]["action"], "publish_post")
        self.assertEqual(self.sent[0]["image_path"], str(Path("D:/photo.png")))
        self.assertIsNone(self.sent[1]["image_path"])
        self.assertEqual(self.states["a"], "正在发帖")

    def test_duplicate_accounts_and_invalid_text_reject_the_entire_batch(self):
        for assignments in ([self.assignment(), self.assignment()],
                            [self.assignment(), self.assignment("b", " ")],
                            [self.assignment(text="x" * 5001)], []):
            with self.subTest(assignments=assignments), self.run:
                self.assertFalse(self.app.start_post(assignments))
            self.assertFalse(self.sent)
            self.assertFalse(self.app.post_pending)

    def test_busy_or_changed_accounts_reject_the_entire_batch(self):
        for reason in ("avatar", "cover", "post", "activity", "profile"):
            with self.subTest(reason=reason):
                self.app.avatar_pending.clear()
                self.app.cover_pending.clear()
                self.app.post_pending.clear()
                self.states["b"] = "空闲"
                self.app.accounts["b"]["profile_url"] = "https://www.facebook.com/b"
                if reason == "avatar":
                    self.app.avatar_pending.add("b")
                elif reason == "cover":
                    self.app.cover_pending["b"] = "other"
                elif reason == "post":
                    self.app.post_pending["b"] = "other"
                elif reason == "activity":
                    self.states["b"] = "活跃首页"
                else:
                    self.app.accounts["b"]["profile_url"] = "https://www.facebook.com/changed"
                with self.run:
                    self.assertFalse(self.app.start_post([self.assignment(), self.assignment("b")]))
                self.assertFalse(self.sent)
                self.assertNotIn("a", self.app.post_pending)

    def test_expired_queued_task_is_not_sent(self):
        self.app.post_pending["a"] = "new-task"
        asyncio.run(self.app.send_post("a", "expired-task", "Hello", None, "https://www.facebook.com/a"))
        self.assertFalse(self.sent)
        self.assertEqual(self.app.post_pending["a"], "new-task")

    def test_account_switch_before_sending_is_reported_without_publishing(self):
        self.app.post_pending["a"] = "task"
        self.app.accounts["a"]["profile_url"] = "https://www.facebook.com/changed"
        asyncio.run(self.app.send_post("a", "task", "Hello", None, "https://www.facebook.com/a"))
        self.assertFalse(self.sent)
        self.timers[-1][1]()
        self.assertEqual(self.states["a"], "发帖失败")
        self.assertNotIn("a", self.app.post_pending)

    def test_disconnect_releases_pending_task(self):
        self.app.post_pending["a"] = "task"
        self.app.clients.pop("a")
        asyncio.run(self.app.send_post("a", "task", "Hello", None, "https://www.facebook.com/a"))
        self.timers[-1][1]()
        self.assertEqual(self.states["a"], "发帖失败")
        self.assertNotIn("a", self.app.post_pending)

    def test_old_result_and_timeout_cannot_overwrite_newer_results(self):
        with self.run:
            self.app.start_post([self.assignment()])
        task = self.app.post_pending["a"]
        self.app.finish_post("a", "obsolete", True, True, "wrong")
        self.assertEqual(self.app.post_pending["a"], task)
        self.app.finish_post("a", task, True, True, "published")
        self.timers[0][1]()
        self.assertEqual(self.states["a"], "发帖成功")
        self.assertEqual(self.details["a"], "published")

    def test_timeout_remains_uncertain_without_automatic_retry(self):
        with self.run:
            self.app.start_post([self.assignment()])
        self.timers[0][1]()
        self.assertEqual(self.states["a"], "待核实")
        self.assertFalse(self.app.post_pending)
        self.assertEqual(len(self.sent), 1)


if __name__ == "__main__":
    unittest.main()
