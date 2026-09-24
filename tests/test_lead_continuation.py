import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "lead-continuation.py"
spec = importlib.util.spec_from_file_location("lead_continuation", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeClient:
    def __init__(self, receipt):
        self.receipt = receipt
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, params))
        return self.receipt


class ErrorClient(FakeClient):
    def call(self, method, params):
        self.calls.append((method, params))
        raise module.RpcError("PRECONDITION_FAILED", "伙伴能力正在刷新，请稍后再发送")


class ContinuationTests(unittest.TestCase):
    def setup(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.ledger = root / "ledger.json"
        self.config = root / "continuation.json"
        self.ledger.write_text(json.dumps({"version": 1, "status": "running", "updated_at": "old", "events": [{"type": "pr_ready", "at": "t1", "detail": {"group_id": "g1"}}], "waves": [{"groups": [{"group_id": "g1", "state": "pr-open"}]}]}))
        self.config.write_text(json.dumps({"lead_session_id": "lead-1", "ledger_paths": [str(self.ledger)], "stalled_after_sec": 10}))

    def tearDown(self):
        self.tmp.cleanup()

    def test_change_dispatches_once_and_fingerprint_ignores_time(self):
        self.setup()
        client = FakeClient({"target_session_id": "lead-1", "status": "woken"})
        first = module.run_once(self.config, client=client, now=100)
        second = module.run_once(self.config, client=client, now=101)
        self.assertTrue(first["dispatched"])
        self.assertFalse(second["dispatched"])
        self.assertEqual(len(client.calls), 1)
        self.ledger.write_text(self.ledger.read_text().replace('"old"', '"new"').replace('"t1"', '"t2"'))
        third = module.run_once(self.config, client=client, now=102)
        self.assertFalse(third["dispatched"])
        self.assertEqual(len(client.calls), 1)

    def test_unknown_receipt_is_pending_and_not_reissued(self):
        self.setup()
        client = FakeClient({"target_session_id": "other"})
        first = module.run_once(self.config, client=client, now=100)
        second = module.run_once(self.config, client=client, now=101)
        self.assertEqual(first["status"], "pending-receipt")
        self.assertEqual(second["status"], "pending-receipt")
        self.assertEqual(len(client.calls), 1)

    def test_known_host_refresh_rejection_retries_after_five_minutes(self):
        self.setup()
        cfg = json.loads(self.config.read_text())
        cfg["stalled_after_sec"] = 1800
        self.config.write_text(json.dumps(cfg))
        client = ErrorClient(None)
        first = module.run_once(self.config, client=client, now=100)
        self.assertEqual(first["status"], "retryable-rejected")
        self.assertFalse(module.run_once(self.config, client=client, now=399)["dispatched"])
        second = module.run_once(self.config, client=client, now=400)
        self.assertEqual(second["status"], "retryable-rejected")
        self.assertEqual(len(client.calls), 2)

    def test_known_host_refresh_rejection_blocks_after_three_retries(self):
        self.setup()
        client = ErrorClient(None)
        module.run_once(self.config, client=client, now=100)
        state = Path(str(self.config) + ".state.json")
        for now in (400, 700):
            payload = json.loads(state.read_text()); payload["pending"] = payload["pending"]; state.write_text(json.dumps(payload))
            module.run_once(self.config, client=client, now=now)
        blocked = module.run_once(self.config, client=client, now=1000)
        self.assertEqual(blocked["status"], "blocked")
        self.assertEqual(module.run_once(self.config, client=client, now=1001)["status"], "blocked")
        self.assertEqual(len(client.calls), 3)

    def test_legacy_explicit_refusal_recovers_without_clearing_unknown_receipts(self):
        self.setup()
        state = Path(str(self.config) + ".state.json")
        intent = {"target_session_id": "lead-1", "created_at": 100, "fingerprint": "original"}
        state.write_text(json.dumps({"status": "pending-receipt", "pending": intent,
            "dispatch_error": "PRECONDITION_FAILED: [PRECONDITION_FAILED] 伙伴能力正在刷新，请稍后再发送"}))
        client = FakeClient({"target_session_id": "lead-1"})
        waiting = module.run_once(self.config, client=client, now=399)
        self.assertEqual(waiting["status"], "retryable-rejected")
        self.assertEqual(client.calls, [])
        self.assertTrue(module.run_once(self.config, client=client, now=400)["dispatched"])
        self.assertEqual(len(client.calls), 1)
        for error in ("TRANSPORT_CLOSED: host closed the script channel", "PRECONDITION_FAILED: another gate"):
            state.write_text(json.dumps({"status": "pending-receipt", "pending": intent, "dispatch_error": error}))
            self.assertEqual(module.run_once(self.config, client=client, now=1000)["status"], "pending-receipt")
        self.assertEqual(len(client.calls), 1)

    def test_stalled_attempts_block_after_three(self):
        self.setup()
        client = FakeClient({"target_session_id": "lead-1"})
        module.run_once(self.config, client=client, now=100)
        # Make each receipt acknowledged and clear pending to model a host round.
        state = Path(str(self.config) + ".state.json")
        for index, now in enumerate((111, 122, 133), start=1):
            payload = json.loads(state.read_text())
            payload.pop("pending", None)
            state.write_text(json.dumps(payload))
            result = module.run_once(self.config, client=client, now=now)
            self.assertTrue(result["dispatched"])
        payload = json.loads(state.read_text())
        payload.pop("pending", None)
        state.write_text(json.dumps(payload))
        blocked = module.run_once(self.config, client=client, now=144)
        self.assertEqual(blocked["status"], "blocked")
        still_blocked = module.run_once(self.config, client=client, now=145)
        self.assertEqual(still_blocked["status"], "blocked")
        self.assertEqual(len(client.calls), 4)

    def test_stalled_dispatch_respects_cooldown(self):
        self.setup()
        client = FakeClient({"target_session_id": "lead-1"})
        module.run_once(self.config, client=client, now=100)
        state = Path(str(self.config) + ".state.json")
        payload = json.loads(state.read_text()); payload.pop("pending", None); state.write_text(json.dumps(payload))
        self.assertFalse(module.run_once(self.config, client=client, now=105)["dispatched"])
        self.assertTrue(module.run_once(self.config, client=client, now=111)["dispatched"])
        self.assertEqual(len(client.calls), 2)

    def test_terminal_archived_is_complete_without_dispatch(self):
        self.setup()
        self.ledger.write_text(json.dumps({"version": 1, "events": [], "waves": [{"groups": [{"group_id": "g1", "state": "archived"}]}]}))
        client = FakeClient({"target_session_id": "lead-1"})
        result = module.run_once(self.config, client=client, now=100)
        self.assertEqual(result["status"], "complete")
        self.assertFalse(result["dispatched"])
        self.assertEqual(client.calls, [])

    def test_failed_state_is_blocked_not_complete(self):
        self.setup()
        self.ledger.write_text(json.dumps({"version": 1, "events": [], "waves": [{"groups": [{"group_id": "g1", "state": "failed"}]}]}))
        result = module.run_once(self.config, client=FakeClient({"target_session_id": "lead-1"}), now=100)
        self.assertEqual(result["status"], "blocked")

    def test_status_path_requires_all_prs_archived(self):
        self.setup()
        self.ledger.write_text(json.dumps({"version": 1, "waves": [{"groups": [{"group_id": "g1", "state": "archived"}, {"group_id": "g2", "state": "archived"}]}]}))
        status_path = Path(self.tmp.name) / "status.json"
        status_path.write_text(json.dumps({"prs": {"a": {"pr_id": "g1", "delivery_status": "archived", "owner_turn_completed": True}, "b": {"pr_id": "g2", "delivery_status": "running", "successor_dispatch_ready": True}}}))
        self.config.write_text(json.dumps({"lead_session_id": "lead-1", "ledger_paths": [str(self.ledger)], "status_path": str(status_path), "stalled_after_sec": 10}))
        client = FakeClient({"target_session_id": "lead-1"})
        first = module.run_once(self.config, client=client, now=100)
        self.assertNotEqual(first["status"], "complete")
        status_path.write_text(json.dumps({"prs": {"a": {"pr_id": "g1", "delivery_status": "archived", "owner_turn_completed": True}, "b": {"pr_id": "g2", "delivery_status": "archived", "push_verified": True, "owner_turn_completed": True}}}))
        second = module.run_once(self.config, client=client, now=101)
        self.assertEqual(second["status"], "complete")

    def test_supplemental_receipts_close_historical_review_ledger(self):
        self.setup()
        root = Path(self.tmp.name)
        cleanup = root / "cleanup.json"
        archive = root / "archive.json"
        tool = root / "archive-tool.json"
        self.ledger.write_text(json.dumps({"version": 1, "waves": [{"groups": [{"group_id": "g1", "state": "review"}] + [{"group_id": f"g{i}", "state": "archived"} for i in range(2, 13)]}]}))
        cleanup.write_text(json.dumps({
            "schema": module.SUPPLEMENTAL_CLEANUP_SCHEMA, "ready": True,
            "status": "local_cleaned", "remote_deleted": False, "moved": [{"type": "directory"}], "ledger_version": 1, "assignment_seq": 0,
            "group_id": "g1", "owner_session_id": "owner-1", "repo": "repo/x",
            "pr_number": 563, "local_sha": "a" * 40, "remote_sha": "a" * 40,
            "sources": {"ledger": {"path": str(self.ledger), "sha256": module._sha256(self.ledger)}},
        }))
        archive.write_text(json.dumps({"session_id": "owner-1", "archived": True, "ledger_version": 1, "assignment_seq": 0}))
        tool.write_text(json.dumps({"ok": True, "status": "archived", "changed": [{"session_id": "owner-1", "status": "archived"}]}))
        prs = {"g1": {"pr_id": "g1", "session_id": "owner-1", "owner_archived": True, "local_worktree_removed": True, "local_branch_removed": True, "remote_deleted": False,
                       "cleanup_receipt": str(cleanup), "archive_receipt": str(archive),
                       "archive_tool_result": str(tool)}}
        for index in range(2, 13):
            prs[f"g{index}"] = {"pr_id": f"g{index}", "delivery_status": "archived"}
        status = root / "status.json"
        status.write_text(json.dumps({"prs": prs}))
        self.config.write_text(json.dumps({"lead_session_id": "lead-1", "ledger_paths": [str(self.ledger)], "status_path": str(status), "stalled_after_sec": 10}))
        result = module.run_once(self.config, client=FakeClient({"target_session_id": "lead-1"}), now=100)
        self.assertEqual(result["status"], "complete")

    def test_owner_archived_without_bound_receipts_is_not_complete(self):
        self.setup()
        status = Path(self.tmp.name) / "status.json"
        status.write_text(json.dumps({"prs": {"g1": {"pr_id": "g1", "owner_archived": True}}}))
        self.config.write_text(json.dumps({"lead_session_id": "lead-1", "ledger_paths": [str(self.ledger)], "status_path": str(status), "stalled_after_sec": 10}))
        result = module.run_once(self.config, client=FakeClient({"target_session_id": "lead-1"}), now=100)
        self.assertNotEqual(result["status"], "complete")

    def test_archive_receipt_session_mismatch_is_not_complete(self):
        self.setup()
        root = Path(self.tmp.name)
        cleanup = root / "cleanup.json"; archive = root / "archive.json"; tool = root / "tool.json"
        cleanup.write_text(json.dumps({"schema": module.SUPPLEMENTAL_CLEANUP_SCHEMA, "ready": True, "status": "local_cleaned", "remote_deleted": False, "moved": [{"type": "directory"}], "ledger_version": 1, "assignment_seq": 0, "group_id": "g1", "owner_session_id": "owner-1", "local_sha": "a" * 40, "remote_sha": "a" * 40, "sources": {"ledger": {"path": str(self.ledger), "sha256": module._sha256(self.ledger)}}}))
        archive.write_text(json.dumps({"session_id": "other", "archived": True, "ledger_version": 1, "assignment_seq": 0}))
        tool.write_text(json.dumps({"ok": True, "status": "archived", "changed": [{"session_id": "owner-1", "status": "archived"}]}))
        status = root / "status.json"
        status.write_text(json.dumps({"prs": {"g1": {"pr_id": "g1", "session_id": "owner-1", "owner_archived": True, "local_worktree_removed": True, "local_branch_removed": True, "remote_deleted": False, "cleanup_receipt": str(cleanup), "archive_receipt": str(archive), "archive_tool_result": str(tool)}}}))
        self.config.write_text(json.dumps({"lead_session_id": "lead-1", "ledger_paths": [str(self.ledger)], "status_path": str(status), "stalled_after_sec": 10}))
        result = module.run_once(self.config, client=FakeClient({"target_session_id": "lead-1"}), now=100)
        self.assertNotEqual(result["status"], "complete")

    def test_normal_progress_change_updates_progress_without_waking_lead(self):
        self.setup()
        client = FakeClient({"target_session_id": "lead-1"})
        first = module.run_once(self.config, client=client, now=100)
        self.assertTrue(first["dispatched"])
        state = Path(str(self.config) + ".state.json")
        payload = json.loads(state.read_text()); payload.pop("pending", None); state.write_text(json.dumps(payload))
        self.ledger.write_text(self.ledger.read_text().replace('"pr-open"', '"local_validated"'))
        second = module.run_once(self.config, client=client, now=101)
        self.assertFalse(second["dispatched"])
        self.assertEqual(len(client.calls), 1)

    def test_failed_pr_does_not_stop_other_active_pr(self):
        self.setup()
        status = Path(self.tmp.name) / "status.json"
        status.write_text(json.dumps({"prs": {"failed": {"pr_id": "failed", "delivery_status": "failed"}, "active": {"pr_id": "active", "delivery_status": "executing"}}}))
        self.config.write_text(json.dumps({"lead_session_id": "lead-1", "ledger_paths": [str(self.ledger)], "status_path": str(status), "stalled_after_sec": 10}))
        terminal, failed = module._terminal([json.loads(self.ledger.read_text())], json.loads(status.read_text()), [self.ledger])
        self.assertFalse(terminal)
        self.assertFalse(failed)

    def test_failed_first_ledger_does_not_hide_later_active_ledger(self):
        self.setup()
        second = Path(self.tmp.name) / "ledger-2.json"
        second.write_text(json.dumps({"version": 1, "waves": [{"groups": [{"group_id": "g2", "state": "pr-open"}]}]}))
        failed = {"version": 1, "waves": [{"groups": [{"group_id": "g1", "state": "failed"}]}]}
        self.ledger.write_text(json.dumps(failed))
        terminal, is_failed = module._terminal([failed, json.loads(second.read_text())], None, [self.ledger, second])
        self.assertFalse(terminal)
        self.assertFalse(is_failed)

    def test_blocked_group_is_a_business_signal(self):
        self.setup()
        self.ledger.write_text(json.dumps({"version": 1, "waves": [{"groups": [{"group_id": "g1", "state": "blocked"}]}]}))
        self.assertIn({"group_id": "g1", "state": "blocked"}, module._business_view([json.loads(self.ledger.read_text())], None)["ledgers"][0]["groups"])

    def test_stale_dead_lease_is_recovered(self):
        self.setup()
        lock = Path(str(self.config) + ".lock")
        lock.write_text(json.dumps({"pid": 999999, "started": 1}))
        result = module.run_once(self.config, client=FakeClient({"target_session_id": "lead-1"}), now=100)
        self.assertTrue(result["dispatched"])
        self.assertFalse(lock.exists())

    def test_main_completes_real_jsonl_protocol_roundtrip(self):
        self.setup()
        frames = "\n".join([
            json.dumps({"protocol": "cindy-script/1", "type": "start", "context": {}}),
            json.dumps({"protocol": "cindy-script/1", "type": "call_result", "id": "py-1", "ok": True, "result": {"methods": ["sessions.dispatch"], "granted": ["sessions.dispatch"]}}),
            json.dumps({"protocol": "cindy-script/1", "type": "call_result", "id": "py-2", "ok": True, "result": {"target_session_id": "lead-1", "status": "woken"}}),
        ]) + "\n"
        env = {**os.environ, "CINDY_SCRIPT_PROTOCOL": "1"}
        completed = subprocess.run(["python3", str(SCRIPT), "--config", str(self.config)], input=frames, text=True, capture_output=True, env=env, cwd=str(SCRIPT.parent / "pr-watch"), check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        output = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
        self.assertEqual(output[-1]["type"], "complete")
        self.assertEqual(output[-1]["primarySessionId"], "lead-1")

    def test_main_rejects_methods_without_grant(self):
        self.setup()
        frames = "\n".join([
            json.dumps({"protocol": "cindy-script/1", "type": "start", "context": {}}),
            json.dumps({"protocol": "cindy-script/1", "type": "call_result", "id": "py-1", "ok": True, "result": {"methods": ["sessions.dispatch"], "granted": []}}),
        ]) + "\n"
        env = {**os.environ, "CINDY_SCRIPT_PROTOCOL": "1"}
        completed = subprocess.run(["python3", str(SCRIPT), "--config", str(self.config)], input=frames, text=True, capture_output=True, env=env, cwd=str(SCRIPT.parent / "pr-watch"), check=False)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("未授予 sessions.dispatch", completed.stderr)


class MissingLeadTests(unittest.TestCase):
    """回归 2026-09-25 mivo-unlimited-import：lead session 不存在时状态静默卡在 pending-receipt。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.ledger = root / "ledger.json"
        self.config = root / "continuation.json"
        self.ledger.write_text(json.dumps({"version": 1, "events": [{"type": "decision_required", "at": "t1", "detail": {"group_id": "PR3", "decision_id": "expand"}}], "waves": [{"groups": [{"group_id": "PR3", "state": "executing"}]}]}))
        self.config.write_text(json.dumps({"lead_session_id": "gone-lead", "ledger_paths": [str(self.ledger)], "stalled_after_sec": 10}))

    def tearDown(self):
        self.tmp.cleanup()

    def test_decision_event_wakes_lead(self):
        client = FakeClient({"target_session_id": "gone-lead", "status": "woken"})
        result = module.run_once(self.config, client=client, now=100)
        self.assertTrue(result["dispatched"])
        self.assertIn("decision_required", client.calls[0][1]["message"])

    def test_missing_lead_blocks_loudly_and_rebind_redispatches(self):
        class Missing(FakeClient):
            def call(self, method, params):
                self.calls.append((method, params))
                raise module.RpcError("NOT_FOUND", "session gone-lead not found")
        missing = Missing(None)
        first = module.run_once(self.config, client=missing, now=100)
        self.assertEqual(first["status"], "blocked")
        self.assertTrue(first["lead_missing"])
        again = module.run_once(self.config, client=missing, now=400)
        self.assertTrue(again["lead_missing"])
        self.assertEqual(len(missing.calls), 1)
        self.config.write_text(json.dumps({"lead_session_id": "new-lead", "ledger_paths": [str(self.ledger)], "stalled_after_sec": 10}))
        client = FakeClient({"target_session_id": "new-lead", "status": "woken"})
        rebound = module.run_once(self.config, client=client, now=500)
        self.assertTrue(rebound["dispatched"])
        self.assertEqual(client.calls[0][1]["target_session_id"], "new-lead")


if __name__ == "__main__":
    unittest.main()
