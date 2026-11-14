"""reconcile-tick.py：对账任务入口（PraiseZhu/approve-exec#108 SC1–SC4）。

文件名以 continuation 结尾，是为了被 CI 里现有的 `unittest discover -p 'test_*continuation.py'` 收进去，不改 CI 配置。
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))
_spec = importlib.util.spec_from_file_location("reconcile_tick", ROOT / "scripts" / "reconcile-tick.py")
tick = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tick)

from cindy_script import RpcError  # noqa: E402

NOW = 1_800_000_000.0
LEAD = "a" * 64 + "::lead-1"
ROOT_REF = "acme/app#10"


def due(ref: str, action: str, target: str, since: str = "2026-11-14T01:00:00Z") -> dict:
    return {"key": f"{ref}|{action}|{since}", "ref": ref, "action": action, "target": target, "reason": f"{action} 的原因"}


def result(actions: list[dict], lead: str = LEAD) -> dict:
    return {"ok": True, "runs": [{
        "root": ROOT_REF, "lead_session": lead,
        "children": [{"ref": "acme/app#11", "session": "s11"}, {"ref": "acme/app#12", "session": "s12"}],
        "due": actions,
    }]}


class FakeClient:
    def __init__(self, errors: dict[str, str] | None = None):
        self.calls: list[dict] = []
        self.errors = errors or {}

    def call(self, method, params, timeout=30):
        self.calls.append({"method": method, **params})
        code = self.errors.get(params.get("target_session_id"))
        if code:
            raise RpcError(code, "undeliverable")
        return {"target_session_id": params.get("target_session_id"), "wake_kind": "resumed"}


class TickTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="tick-"))
        self.two = [due("acme/app#11", "wake_owner", "owner"), due("acme/app#12", "wake_lead", "lead")]

    def run_once(self, actions, mode, client=None, now=NOW, lead=LEAD):
        client = client or FakeClient()
        summary = tick.run_once(client=client, reconcile=lambda: result(actions, lead), mode=mode, now=now, directory=self.dir)
        return summary, client

    def log_rows(self):
        path = self.dir / "due-log.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def test_record_mode_logs_and_never_dispatches(self):
        summary, client = self.run_once(self.two, "record")
        self.assertEqual(client.calls, [])
        self.assertEqual(len(self.log_rows()), 2)
        self.assertEqual((summary["due"], summary["fresh"], summary["rung"]), (2, 2, 0))
        self.assertTrue(all(r["outcome"] == "recorded" for r in self.log_rows()))

    def test_ring_mode_routes_owner_and_lead_and_dedupes(self):
        summary, client = self.run_once(self.two, "ring")
        self.assertEqual([c["target_session_id"] for c in client.calls], ["s11", "lead-1"])
        self.assertTrue(client.calls[0]["message"].startswith("批准执行对账：acme/app#11 wake_owner\n"))
        self.assertIn("owner-protocol.md", client.calls[0]["message"])
        self.assertEqual(summary["rung"], 2)
        again, client2 = self.run_once(self.two, "ring", now=NOW + 600)
        self.assertEqual(client2.calls, [])
        self.assertEqual(again["fresh"], 0)
        later, client3 = self.run_once(self.two, "ring", now=NOW + tick.DEDUPE_SEC + 1)
        self.assertEqual(len(client3.calls), 2, "24 小时后同一段等待还在，再敲一次")

    def test_record_then_ring_still_rings(self):
        self.run_once(self.two, "record")
        summary, client = self.run_once(self.two, "ring", now=NOW + 60)
        self.assertEqual(len(client.calls), 2, "只记不敲时记过的动作，切到敲门模式后照常敲")
        self.assertEqual(summary["rung"], 2)

    def test_broken_cache_is_treated_as_empty(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "doorbell.json").write_text("{not json", encoding="utf-8")
        summary, client = self.run_once(self.two, "ring")
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(summary["rung"], 2)
        json.loads((self.dir / "doorbell.json").read_text(encoding="utf-8"))

    def test_owner_unreachable_falls_back_to_lead(self):
        client = FakeClient({"s11": "ARCHIVED"})
        summary, _ = self.run_once([self.two[0]], "ring", client=client)
        self.assertEqual([c["target_session_id"] for c in client.calls], ["s11", "lead-1"])
        self.assertIn("执行会话送不到：ARCHIVED", client.calls[1]["message"])
        self.assertIn("wake_lead", client.calls[1]["message"].splitlines()[0])
        self.assertEqual(summary["rung"], 1)
        self.assertEqual(summary["lead_unreachable"], [])

    def test_lead_unreachable_is_reported(self):
        client = FakeClient({"lead-1": "NOT_FOUND"})
        summary, _ = self.run_once([self.two[1]], "ring", client=client)
        self.assertEqual(summary["lead_unreachable"], [{"root": ROOT_REF, "ref": "acme/app#12", "error": "NOT_FOUND"}])
        self.assertEqual(self.log_rows()[-1]["outcome"], "lead_unreachable")

    def test_lead_on_linux_gateway_is_not_dispatched(self):
        gateway = sorted(tick.LINUX_GATEWAYS)[0] + "::lead-9"
        summary, client = self.run_once([self.two[1]], "ring", lead=gateway)
        self.assertEqual(client.calls, [])
        self.assertEqual(summary["lead_unreachable"][0]["error"], "LINUX_GATEWAY")

    def test_transient_error_is_retried_next_round(self):
        client = FakeClient({"lead-1": "HOST_NOT_READY"})
        self.run_once([self.two[1]], "ring", client=client)
        summary, client2 = self.run_once([self.two[1]], "ring", now=NOW + 60)
        self.assertEqual(len(client2.calls), 1, "回执不明不记缓存，下一轮再敲")
        self.assertEqual(summary["rung"], 1)

    def test_nothing_due_stays_silent(self):
        summary, client = self.run_once([], "ring")
        self.assertEqual(client.calls, [])
        self.assertEqual(self.log_rows(), [])
        self.assertEqual(summary["due"], 0)

    def test_no_charter_runs_means_no_roots(self):
        client = FakeClient()
        summary = tick.run_once(client=client, reconcile=lambda: {"ok": True, "runs": []}, mode="ring", now=NOW, directory=self.dir)
        self.assertEqual((summary["roots"], client.calls), (0, []))

    def test_bad_mode_is_rejected(self):
        with self.assertRaises(tick.TickError):
            self.run_once([], "loud")


if __name__ == "__main__":
    unittest.main()
