"""issue-watch.py：零 token 续跑脚本（PraiseZhu/approve-exec#69 SC1、SC2、SC3、SC8，#77 SC4，#78 SC1、SC2，#79 SC1）。"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))
_spec = importlib.util.spec_from_file_location("issue_watch", ROOT / "scripts" / "issue-watch.py")
issue_watch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(issue_watch)

from cindy_script import RpcError  # noqa: E402

LEAD = "lead-1"
NOW = 1_800_000_000.0
ISO_NOW = "2027-01-15T08:00:00+00:00"  # == NOW


class FakeClient:
    def __init__(self, error: Exception | None = None, target: str = LEAD):
        self.calls: list[dict] = []
        self.error = error
        self.target = target

    def call(self, method, params, timeout=30):
        self.calls.append({"method": method, **params})
        if self.error:
            raise self.error
        return {"target_session_id": self.target, "wake_kind": "resumed"}


class FakeGitHub:
    def __init__(self, closed=(), heads=None, pending=()):
        self.closed = set(closed)
        self.heads = heads or {}
        self.pending = set(pending)

    def issue_done(self, ref):
        return ref in self.closed

    def pr_head(self, repo, number):
        return self.heads.get(number, "h" * 40)

    def ci_pending(self, repo, number):
        return number in self.pending


def item(ref, state, **extra):
    base = {"ref": ref, "repo": ref.split("#")[0], "state": state, "hard_deps": [], "checkpoint": None,
            "checkpoint_seq": 0, "blocked": None, "last_activity_at": ISO_NOW}
    return {**base, **extra}


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="issue-watch-"))
        self.ledger_path = self.dir / "ledger.json"
        self.config = self.dir / "issue-watch.json"
        self.config.write_text(json.dumps({"schema": "issue-watch-v1", "lead_session_id": LEAD,
                                           "ledger_paths": [str(self.ledger_path)], "stalled_after_sec": 1800}))

    def ledger(self, *items, **extra):
        self.ledger_path.write_text(json.dumps({"schema": "issue-run-v1", "root": {"ref": "o/r#10"},
                                                "items": {i["ref"]: i for i in items}, **extra}))

    def run_once(self, client, gh, now=NOW):
        return issue_watch.run_once(self.config, client=client, gh=gh, now=now)


class AcceptTests(Base):
    def test_sc1_awaiting_acceptance_wakes_lead_exactly_once(self):
        self.ledger(item("o/r#11", "awaiting_acceptance", checkpoint_seq=1, checkpoint={"pr": 5, "head": "a" * 40}),
                    item("o/r#12", "dispatched"))
        client = FakeClient()
        first = self.run_once(client, FakeGitHub())
        self.assertEqual(first["status"], "dispatched")
        self.assertEqual(first["signals"], ["accept:o/r#11:1"])
        self.assertEqual(client.calls[0]["target_session_id"], LEAD)
        self.assertIn("[待验收] o/r#11：PR #5", client.calls[0]["message"])
        second = self.run_once(client, FakeGitHub(), now=NOW + 300)
        self.assertEqual(second["status"], "monitoring")
        self.assertEqual(len(client.calls), 1, "同一个 checkpoint 不重复唤醒")

    def test_new_checkpoint_after_revise_wakes_again(self):
        self.ledger(item("o/r#11", "awaiting_acceptance", checkpoint_seq=1, checkpoint={"pr": 5, "head": "a" * 40}))
        client = FakeClient()
        self.run_once(client, FakeGitHub())
        self.ledger(item("o/r#11", "awaiting_acceptance", checkpoint_seq=2, checkpoint={"pr": 5, "head": "b" * 40}))
        self.assertEqual(self.run_once(client, FakeGitHub(), now=NOW + 300)["signals"], ["accept:o/r#11:2"])


class UnlockTests(Base):
    def test_sc2_wakes_only_after_dependency_closed(self):
        self.ledger(item("o/r#11", "archived"), item("o/r#13", "pending", hard_deps=["o/r#11"]))
        client = FakeClient()
        self.assertEqual(self.run_once(client, FakeGitHub())["status"], "monitoring")
        self.assertEqual(client.calls, [])
        res = self.run_once(client, FakeGitHub(closed={"o/r#11"}), now=NOW + 300)
        self.assertEqual(res["signals"], ["unlock:o/r#13"])
        self.assertIn("[可派] o/r#13：依赖 o/r#11 已合入", client.calls[0]["message"])


class StallTests(Base):
    def test_sc3_stalled_once_after_threshold(self):
        self.ledger(item("o/r#11", "revising", checkpoint={"pr": 5, "head": "a" * 40}))
        client = FakeClient()
        gh = FakeGitHub(heads={5: "a" * 40})
        self.assertEqual(self.run_once(client, gh)["status"], "monitoring")
        self.assertEqual(self.run_once(client, gh, now=NOW + 1700)["status"], "monitoring", "未到 30 分钟")
        res = self.run_once(client, gh, now=NOW + 1801)
        self.assertEqual(len(res["signals"]), 1)
        self.assertTrue(res["signals"][0].startswith("stalled:o/r#11:"))
        self.assertIn("[停滞] o/r#11：状态 revising", client.calls[0]["message"])
        self.assertEqual(self.run_once(client, gh, now=NOW + 3700)["status"], "monitoring", "同一停滞不重复唤醒")

    def test_head_change_resets_stall_clock(self):
        self.ledger(item("o/r#11", "revising", checkpoint={"pr": 5, "head": "a" * 40}))
        client = FakeClient()
        self.run_once(client, FakeGitHub(heads={5: "a" * 40}))
        self.assertEqual(self.run_once(client, FakeGitHub(heads={5: "b" * 40}), now=NOW + 1500)["status"], "monitoring")
        self.assertEqual(self.run_once(client, FakeGitHub(heads={5: "b" * 40}), now=NOW + 1900)["status"], "monitoring",
                         "head 在 NOW+1500 变过，从那时起算")
        self.assertEqual(client.calls, [])

    def test_waiting_ci_is_not_stalled(self):
        self.ledger(item("o/r#11", "accepted", checkpoint={"pr": 5, "head": "a" * 40}))
        client = FakeClient()
        self.run_once(client, FakeGitHub(pending={5}))
        self.assertEqual(self.run_once(client, FakeGitHub(pending={5}), now=NOW + 4000)["status"], "monitoring")
        self.assertEqual(client.calls, [])


class LeadCloseoutTests(Base):
    def test_78_sc1_ready_wakes_lead_once_with_closeout_steps(self):
        self.ledger(item("o/r#11", "ready", checkpoint_seq=3, checkpoint={"pr": 5, "head": "a" * 40}))
        client = FakeClient()
        res = self.run_once(client, FakeGitHub())
        self.assertEqual(res["signals"], ["ready:o/r#11:3"])
        msg = client.calls[0]["message"]
        self.assertIn("[待收尾] o/r#11：PR #5 已转正式", msg)
        for step in ("accept-check --stage ready", "issue-run cleanup", "archive_sessions", "issue-run archived"):
            self.assertIn(step, msg)
        self.assertEqual(self.run_once(client, FakeGitHub(), now=NOW + 300)["status"], "monitoring")
        self.assertEqual(len(client.calls), 1, "同一个 ready 不重复唤醒")

    def test_78_sc2_lead_pending_states_wake_once_after_threshold(self):
        steps = {"claimed": "issue-run bind", "awaiting_acceptance": "issue-run verdict", "cleaned": "issue-run archived"}
        for state, step in steps.items():
            with self.subTest(state=state):
                self.setUp()
                self.ledger(item("o/r#11", state, checkpoint_seq=1, checkpoint={"pr": 5, "head": "a" * 40}))
                client = FakeClient()
                first = self.run_once(client, FakeGitHub())
                base = 1 if state == "awaiting_acceptance" else 0  # 待验收本来就当场叫一次
                self.assertEqual(len(client.calls), base)
                self.assertEqual(self.run_once(client, FakeGitHub(), now=NOW + 1700)["status"], "monitoring", "未到阈值不叫")
                res = self.run_once(client, FakeGitHub(), now=NOW + 1801)
                self.assertEqual(res["signals"], [f"lead_stalled:o/r#11:{state}:{int(NOW)}"])
                msg = client.calls[-1]["message"]
                self.assertIn(f"[lead 未处理] o/r#11：停在 {state} 30 分钟", msg)
                self.assertIn(step, msg)
                self.assertEqual(self.run_once(client, FakeGitHub(), now=NOW + 3700)["status"], "monitoring", "同一次停留只叫一次")
                self.assertEqual(len(client.calls), base + 1)


class AcceptedStallTests(Base):
    def test_78_sc2_accepted_stall_gives_executable_steps_not_release(self):
        self.ledger(item("o/r#11", "accepted", checkpoint={"pr": 5, "head": "a" * 40}))
        client = FakeClient()
        gh = FakeGitHub(heads={5: "a" * 40})
        self.assertEqual(self.run_once(client, gh)["status"], "monitoring")
        res = self.run_once(client, gh, now=NOW + 1801)
        self.assertEqual(len(res["signals"]), 1)
        msg = client.calls[0]["message"]
        self.assertIn("[停滞] o/r#11：状态 accepted", msg)
        self.assertIn("checkpoint --state ready", msg)
        self.assertIn("先跑 accept-check --stage ready", msg, "补写 ready 前要过 ready 档检查（review-pr81 第 2 轮）")
        self.assertLess(msg.index("accept-check --stage ready"), msg.index("checkpoint --state ready"))
        self.assertIn("告诉用户", msg)
        self.assertNotIn("release", msg, "release 不收 accepted（review-pr81）")


class BlockedAndTerminalTests(Base):
    def test_sc8_blocked_user_wakes_lead_with_reason(self):
        self.ledger(item("o/r#11", "blocked_user", blocked={"seq": 2, "at": ISO_NOW, "reason": "需要管理员建规则集"}))
        client = FakeClient()
        res = self.run_once(client, FakeGitHub())
        self.assertEqual(res["signals"], [f"blocked:o/r#11:2:{ISO_NOW}"])
        self.assertIn("[需要用户] o/r#11：需要管理员建规则集", client.calls[0]["message"])

    def test_77_sc4_needs_lead_wakes_lead_exactly_once(self):
        self.ledger(item("o/r#11", "needs_lead", blocked={"seq": 3, "at": ISO_NOW, "reason": "要改 docs/sync.md 才能补 SC2"}))
        client = FakeClient()
        res = self.run_once(client, FakeGitHub())
        self.assertEqual(res["signals"], [f"lead:o/r#11:3:{ISO_NOW}"])
        self.assertIn("[需要 lead] o/r#11：要改 docs/sync.md 才能补 SC2。", client.calls[0]["message"])
        self.assertIn("issue-run unblock --note", client.calls[0]["message"])
        self.assertEqual(self.run_once(client, FakeGitHub(), now=NOW + 300)["status"], "monitoring")
        self.assertEqual(self.run_once(client, FakeGitHub(), now=NOW + 4000)["status"], "monitoring", "等 lead 定不算停滞")
        self.assertEqual(len(client.calls), 1, "同一次 needs_lead 不重复唤醒")

    def test_complete_run_never_wakes(self):
        self.ledger(item("o/r#11", "archived"), item("o/r#12", "closed"),
                    handoffs=[{"n": 1, "items": ["o/r#11", "o/r#12"]}])
        client = FakeClient()
        self.assertEqual(self.run_once(client, FakeGitHub())["status"], "complete")
        self.assertEqual(client.calls, [])

    def test_79_sc1_all_done_wakes_root_acceptance_once_until_handoff(self):
        self.ledger(item("o/r#11", "archived"), item("o/r#12", "closed"), handoffs=[])
        client = FakeClient()
        res = self.run_once(client, FakeGitHub())
        self.assertEqual(res["signals"], ["root:o/r#10:1:2"])
        msg = client.calls[0]["message"]
        self.assertIn("[待总验收] o/r#10：全部子 issue 收工，还没交接第 1 次总 issue 验收", msg)
        for step in ("root-check --preview", "issue-run handoff", "issue-run add", "root-check --cleanup"):
            self.assertIn(step, msg)
        self.assertEqual(self.run_once(client, FakeGitHub(), now=NOW + 300)["status"], "monitoring", "同一次只叫一次")
        self.assertEqual(len(client.calls), 1)
        # 交接后 complete；add 了新子 issue 并收工后要再交接一次（第 2 次）。
        self.ledger(item("o/r#11", "archived"), item("o/r#12", "closed"), handoffs=[{"n": 1, "items": ["o/r#11", "o/r#12"]}])
        self.assertEqual(self.run_once(client, FakeGitHub(), now=NOW + 600)["status"], "complete")
        self.ledger(item("o/r#11", "archived"), item("o/r#12", "closed"), item("o/r#15", "archived"),
                    handoffs=[{"n": 1, "items": ["o/r#11", "o/r#12"]}])
        self.assertEqual(self.run_once(client, FakeGitHub(), now=NOW + 900)["signals"], ["root:o/r#10:2:3"])

    def test_79_sc1_single_child_entry_has_no_root_acceptance(self):
        self.ledger(item("o/r#11", "archived"), root_acceptance=False, handoffs=[])
        client = FakeClient()
        self.assertEqual(self.run_once(client, FakeGitHub())["status"], "complete")
        self.assertEqual(client.calls, [])

    def test_lead_missing_is_blocked_and_unknown_receipt_retries(self):
        self.ledger(item("o/r#11", "awaiting_acceptance", checkpoint_seq=1, checkpoint={"pr": 5, "head": "a" * 40}))
        res = self.run_once(FakeClient(error=RpcError("NOT_FOUND", "session not found")), FakeGitHub())
        self.assertEqual(res, {"status": "blocked", "lead_missing": True, "dispatched": False})
        res = self.run_once(FakeClient(target="someone-else"), FakeGitHub(), now=NOW + 300)
        self.assertEqual(res["status"], "pending-receipt")
        ok = FakeClient()
        self.assertEqual(self.run_once(ok, FakeGitHub(), now=NOW + 600)["signals"], ["accept:o/r#11:1"], "没确认送达就下一轮重发")

    def test_config_validation(self):
        self.config.write_text(json.dumps({"schema": "issue-watch-v1", "lead_session_id": LEAD, "ledger_paths": ["relative.json"]}))
        with self.assertRaises(issue_watch.ConfigError):
            self.run_once(FakeClient(), FakeGitHub())


if __name__ == "__main__":
    unittest.main()
