#!/usr/bin/env python3
"""Lead continuation consumer.

Reads explicitly configured approve-exec ledgers (and an optional status.json),
then wakes the existing lead session only when a business fingerprint changes or
the configured stall window expires in v1. Explicit v2 routes bound owners and
reads only configured session identity/status/busy metadata from SQLite read-only.
Neither version reads session transcripts or discovers additional tasks.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PR_WATCH = HERE / "pr-watch"
sys.path.insert(0, str(PR_WATCH))
sys.path.insert(0, str(HERE))
from protocol import DuplexClient, RpcError  # type: ignore  # noqa: E402

VOLATILE_KEYS = {"updated_at", "created_at", "last_seen_at", "observed_at", "at", "timestamp", "mtime", "mtime_ms"}
SIGNAL_TYPES = {"pr_ready", "goal_report", "final_acceptance", "decision_required", "blocked", "local_cleaned", "session_archived", "owner_done", "next_wave", "successor_dispatch_ready"}
ARCHIVED_STATES = {"archived", "owner_archived"}
FAILED_STATES = {"failed", "error"}
SUPPLEMENTAL_CLEANUP_SCHEMA = "approve-exec-supplemental-cleanup-receipt-v1"


def _wake_delivery_status(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    lowered = value.lower()
    return value if any(token in lowered for token in ("blocked", "decision", "ready", "cleanup", "archived", "failed", "error")) else None


def _wake_state(value: Any) -> str | None:
    return value if isinstance(value, str) and value in {"blocked", "failed", "error", "archived", "owner_archived"} else None


def _retryable_rejection(exc: BaseException) -> bool:
    code = getattr(exc, "code", "")
    message = getattr(exc, "message", str(exc))
    if code == "HOST_NOT_READY":
        return True
    return code == "PRECONDITION_FAILED" and "伙伴能力正在刷新，请稍后再发送" in message


def _lead_missing(exc: BaseException) -> bool:
    code = getattr(exc, "code", "")
    message = getattr(exc, "message", str(exc))
    return code == "NOT_FOUND" and "session" in message.lower()


def _die(message: str) -> None:
    raise ValueError(message)


def _read_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        _die(f"{label} unreadable: {exc}")
    except json.JSONDecodeError as exc:
        _die(f"{label} invalid JSON: {exc}")


def _stable(value: Any) -> Any:
    if isinstance(value, list):
        return [_stable(item) for item in value]
    if isinstance(value, dict):
        return {key: _stable(item) for key, item in sorted(value.items()) if key not in VOLATILE_KEYS}
    return value


def _business_view(ledgers: list[Any], status: Any | None) -> dict[str, Any]:
    compact_ledgers = []
    for ledger in ledgers:
        events = [{"type": event.get("type"), "detail": _stable(event.get("detail", {}))} for event in _events(ledger) if event.get("type") in SIGNAL_TYPES]
        groups = []
        for wave in ledger.get("waves", []) if isinstance(ledger, dict) else []:
            for group in wave.get("groups", []) if isinstance(wave, dict) and isinstance(wave.get("groups"), list) else []:
                if isinstance(group, dict) and group.get("state") in ARCHIVED_STATES | FAILED_STATES | {"blocked", "local-cleaned"}:
                    groups.append({"group_id": group.get("group_id"), "state": group.get("state")})
        compact_ledgers.append({"signals": events, "groups": groups})
    compact_status = None
    if isinstance(status, dict):
        prs = status.get("prs")
        if isinstance(prs, dict):
            compact_status = {"prs": [{"pr_id": value.get("pr_id") or key, "status": _wake_state(value.get("status")), "state": _wake_state(value.get("state")), "delivery_status": _wake_delivery_status(value.get("delivery_status")), "successor_dispatch_ready": value.get("successor_dispatch_ready"), "owner_archived": value.get("owner_archived"), "cleanup_status": value.get("cleanup_status"), "cleanup_receipt": value.get("cleanup_receipt"), "archive_receipt": value.get("archive_receipt"), "archive_tool_result": value.get("archive_tool_result"), "decision": value.get("decision")} for key, value in sorted(prs.items()) if isinstance(value, dict)]}
        elif isinstance(prs, list):
            compact_status = {"prs": [{"pr_id": value.get("pr_id") or value.get("id") or value.get("nodeId"), "status": _wake_state(value.get("status")), "state": _wake_state(value.get("state")), "delivery_status": _wake_delivery_status(value.get("delivery_status")), "successor_dispatch_ready": value.get("successor_dispatch_ready"), "owner_archived": value.get("owner_archived"), "cleanup_status": value.get("cleanup_status"), "cleanup_receipt": value.get("cleanup_receipt"), "archive_receipt": value.get("archive_receipt"), "archive_tool_result": value.get("archive_tool_result"), "decision": value.get("decision")} for value in prs if isinstance(value, dict)]}
    return {"ledgers": compact_ledgers, "status": compact_status}


def _progress_fingerprint(ledgers: list[Any], status: Any | None) -> str:
    """Tracks owner progress for stall timing; it never directly wakes lead."""
    payload = _stable({"ledgers": ledgers, "status": status})
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _status_values(status: Any | None) -> list[dict[str, Any]]:
    prs = status.get("prs") if isinstance(status, dict) else None
    values = list(prs.values()) if isinstance(prs, dict) else prs if isinstance(prs, list) else []
    return [item for item in values if isinstance(item, dict)]


def _supplemental_archive_verified(item: dict[str, Any], ledger_paths: list[Path]) -> bool:
    """Verify lifecycle receipts before accepting owner_archived as terminal.

    The official ledger may intentionally retain a historical review/fail state;
    supplemental receipts can close that exception only when their identities and
    source hashes still bind to the configured ledger.
    """
    cleanup_raw = item.get("cleanup_receipt")
    archive_raw = item.get("archive_receipt")
    tool_raw = item.get("archive_tool_result")
    if not all(isinstance(value, str) and Path(value).is_absolute() for value in (cleanup_raw, archive_raw, tool_raw)):
        return False
    try:
        cleanup_path, archive_path, tool_path = (Path(value) for value in (cleanup_raw, archive_raw, tool_raw))
        cleanup = _read_json(cleanup_path, "cleanup receipt")
        archive = _read_json(archive_path, "archive receipt")
        tool = _read_json(tool_path, "archive tool result")
        if not isinstance(cleanup, dict) or cleanup.get("schema") != SUPPLEMENTAL_CLEANUP_SCHEMA or cleanup.get("ready") is not True:
            return False
        if cleanup.get("status") != "local_cleaned" or cleanup.get("remote_deleted") is not False or not isinstance(cleanup.get("moved"), list) or not cleanup.get("moved"):
            return False
        if item.get("local_worktree_removed") is not True or item.get("local_branch_removed") is not True or item.get("remote_deleted") is not False:
            return False
        if cleanup.get("group_id") != item.get("pr_id") or cleanup.get("owner_session_id") != item.get("session_id"):
            return False
        if cleanup.get("repo") and item.get("repo") and cleanup.get("repo") != item.get("repo"):
            return False
        if cleanup.get("pr_number") is not None and item.get("pr_number") is not None and cleanup.get("pr_number") != item.get("pr_number"):
            return False
        remote_sha = cleanup.get("remote_sha")
        if not isinstance(remote_sha, str) or remote_sha != cleanup.get("local_sha"):
            return False
        if item.get("remote_sha") and item.get("remote_sha") != remote_sha:
            return False
        source = cleanup.get("sources", {}).get("ledger") if isinstance(cleanup.get("sources"), dict) else None
        if not isinstance(source, dict) or not isinstance(source.get("path"), str) or not isinstance(source.get("sha256"), str):
            return False
        source_path = Path(source["path"]).resolve()
        configured = {path.resolve() for path in ledger_paths}
        if source_path not in configured or not source_path.is_file() or _sha256(source_path) != source["sha256"]:
            return False
        if not isinstance(archive, dict) or archive.get("session_id") != item.get("session_id") or archive.get("archived") is not True:
            return False
        if archive.get("ledger_version") != cleanup.get("ledger_version") or archive.get("assignment_seq") != cleanup.get("assignment_seq"):
            return False
        ledger_data = _read_json(source_path, "source ledger")
        if isinstance(ledger_data, dict) and archive.get("ledger_version") != ledger_data.get("version"):
            return False
        if not isinstance(tool, dict) or tool.get("ok") is not True or tool.get("status") != "archived":
            return False
        changed = tool.get("changed")
        if not isinstance(changed, list):
            return False
        matches = [entry for entry in changed if isinstance(entry, dict) and entry.get("session_id") == item.get("session_id") and entry.get("status") == "archived"]
        return bool(matches) and (not cleanup.get("worktree") or matches[0].get("working_dir") == cleanup.get("worktree"))
    except (OSError, ValueError, TypeError, KeyError):
        return False


def _official_ledger_archived(item: dict[str, Any], ledgers: list[Any]) -> bool:
    wanted = item.get("pr_id")
    for ledger in ledgers:
        if not isinstance(ledger, dict):
            continue
        for wave in ledger.get("waves", []) if isinstance(ledger.get("waves"), list) else []:
            for group in wave.get("groups", []) if isinstance(wave, dict) and isinstance(wave.get("groups"), list) else []:
                if isinstance(group, dict) and group.get("group_id") == wanted and group.get("state") == "archived":
                    return True
    return False


def _status_item_archived(item: dict[str, Any], ledger_paths: list[Path], ledgers: list[Any] | None = None) -> bool:
    if item.get("owner_archived") is True and _supplemental_archive_verified(item, ledger_paths):
        return True
    return bool(ledgers) and _official_ledger_archived(item, ledgers or []) and (item.get("status") == "archived" or item.get("state") == "archived" or item.get("delivery_status") == "archived")


def fingerprint(ledgers: list[Any], status: Any | None = None) -> str:
    payload = _business_view(ledgers, status)
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _config(path: str | Path) -> tuple[Path, dict[str, Any]]:
    config_path = Path(path).expanduser().resolve()
    cfg = _read_json(config_path, "continuation config")
    if not isinstance(cfg, dict): _die("continuation config must be an object")
    if cfg.get("schemaVersion") == 2:
        from owner_continuation import validate_config
        return config_path, validate_config(cfg)
    lead = cfg.get("lead_session_id")
    if not isinstance(lead, str) or not lead.strip(): _die("lead_session_id is required")
    paths = cfg.get("ledger_paths")
    if not isinstance(paths, list) or not paths or any(not isinstance(item, str) or not Path(item).is_absolute() for item in paths):
        _die("ledger_paths must be a non-empty list of absolute paths")
    stall = cfg.get("stalled_after_sec", 1800)
    if not isinstance(stall, (int, float)) or stall <= 0: _die("stalled_after_sec must be positive")
    status = cfg.get("status_path")
    if status is not None and (not isinstance(status, str) or not Path(status).is_absolute()): _die("status_path must be absolute")
    return config_path, {"lead_session_id": lead, "ledger_paths": [Path(item) for item in paths], "status_path": Path(status) if status else None, "stalled_after_sec": float(stall)}


def _state_paths(config_path: Path) -> tuple[Path, Path]:
    return config_path.with_suffix(config_path.suffix + ".state.json"), config_path.with_suffix(config_path.suffix + ".lock")


def _write_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


@contextmanager
def _lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        old = b""
        try:
            old = path.read_bytes()
            pid = json.loads(old.decode()).get("pid")
            os.kill(int(pid), 0)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            try:
                if path.read_bytes() == old:
                    path.unlink()
                    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                else:
                    yield False
                    return
            except (FileNotFoundError, UnboundLocalError):
                yield False
                return
            except FileExistsError:
                yield False
                return
        else:
            yield False
            return
    try:
        os.write(fd, json.dumps({"pid": os.getpid(), "started": time.time()}).encode())
        yield True
    finally:
        os.close(fd)
        try: path.unlink()
        except FileNotFoundError: pass


def _events(ledger: Any) -> list[dict[str, Any]]:
    return [event for event in (ledger.get("events", []) if isinstance(ledger, dict) else []) if isinstance(event, dict)]


def _signals(ledgers: list[Any]) -> list[dict[str, Any]]:
    signals: list[dict[str, Any]] = []
    for index, ledger in enumerate(ledgers):
        for event in _events(ledger):
            if event.get("type") in SIGNAL_TYPES:
                signals.append({"ledger": index, "type": event.get("type"), "detail": _stable(event.get("detail", {}))})
        groups = ledger.get("waves", []) if isinstance(ledger, dict) else []
        for wave in groups if isinstance(groups, list) else []:
            for group in wave.get("groups", []) if isinstance(wave, dict) and isinstance(wave.get("groups"), list) else []:
                if isinstance(group, dict) and group.get("state") in {"blocked", "local_validated", "pr-open", "local-cleaned", "archived"}:
                    signals.append({"ledger": index, "type": f"owner_state:{group.get('state')}", "detail": {"group_id": group.get("group_id")}})
    return signals


def _terminal(ledgers: list[Any], status: Any | None = None, ledger_paths: list[Path] | None = None) -> tuple[bool, bool]:
    seen = False
    active = False
    ledger_failed = False
    status_values = _status_values(status)
    status_done_ids = {item.get("pr_id") for item in status_values if _status_item_archived(item, ledger_paths or [], ledgers)}
    for ledger in ledgers:
        if not isinstance(ledger, dict): return False, False
        groups = [group for wave in ledger.get("waves", []) if isinstance(wave, dict) for group in wave.get("groups", []) if isinstance(group, dict)]
        if groups:
            seen = True
            effective_groups = [group for group in groups if group.get("group_id") not in status_done_ids]
            if any(group.get("state") in FAILED_STATES for group in effective_groups):
                if any(group.get("state") not in ARCHIVED_STATES | FAILED_STATES for group in effective_groups): active = True
                else: ledger_failed = True
            if any(group.get("state") not in ARCHIVED_STATES | FAILED_STATES for group in effective_groups): active = True
        elif ledger.get("status") in FAILED_STATES or ledger.get("phase") in FAILED_STATES:
            ledger_failed = True
        elif ledger.get("status") not in ARCHIVED_STATES and ledger.get("phase") not in ARCHIVED_STATES:
            return False, False
    if status is not None:
        raw_prs = status.get("prs") if isinstance(status, dict) else None
        raw_values = list(raw_prs.values()) if isinstance(raw_prs, dict) else raw_prs if isinstance(raw_prs, list) else []
        if any(not isinstance(item, dict) for item in raw_values): return False, False
        values = status_values
        if not values: return False, False
        archived = [_status_item_archived(item, ledger_paths or [], ledgers) for item in values]
        if any(item.get("status") in FAILED_STATES or item.get("state") in FAILED_STATES or item.get("delivery_status") in FAILED_STATES for item in values):
            if any(not archived[index] and item.get("status") not in FAILED_STATES and item.get("state") not in FAILED_STATES and item.get("delivery_status") not in FAILED_STATES for index, item in enumerate(values)): active = True
            else: ledger_failed = True
        if any(not done and item.get("status") not in FAILED_STATES and item.get("state") not in FAILED_STATES and item.get("delivery_status") not in FAILED_STATES for done, item in zip(archived, values)): return False, False
        if any(not done for done in archived):
            return False, False
    if ledger_failed and not active:
        return False, True
    return (seen and not active), False


def _message(cfg: dict[str, Any], signals: list[dict[str, Any]], fp: str, reason: str) -> str:
    paths = "\n".join(f"- {path}" for path in cfg["ledger_paths"])
    status = f"\n- status: {cfg['status_path']}" if cfg.get("status_path") else ""
    return ("Lead continuation wake-up. Continue the already authorized approve-exec package autonomously; "
            "make decisions and keep advancing the whole package until every configured PR is archived or a real decision is required. "
            "Do not ask for authorization already granted; do not stop after reporting.\n"
            f"reason={reason}; fingerprint={fp}; lead_session_id={cfg['lead_session_id']}\n"
            "Recover from these configured structured ledger/status paths; execution remains within the original approved package boundaries (never raw sessions/DB):\n"
            f"{paths}{status}\nSignals:\n{json.dumps(signals[-20:], ensure_ascii=False, separators=(',', ':'))}")


def run_once(config_path: str | Path, *, client: Any | None = None, now: float | None = None) -> dict[str, Any]:
    config_file, cfg = _config(config_path)
    now = time.time() if now is None else now
    if cfg.get("schemaVersion") == 2:
        from owner_continuation import run
        state_path, lock_path = _state_paths(config_file)
        with _lock(lock_path) as acquired:
            if not acquired: return {"status": "locked", "dispatched": False}
            previous = _read_json(state_path, "continuation state") if state_path.exists() else {}
            def legacy_archive(owner):
                status = _read_json(Path(owner['legacy_status_path']), 'legacy status')
                items = [item for item in _status_values(status) if item.get('pr_id') == owner['group_id'] and item.get('session_id') == owner['session_id']]
                return len(items) == 1 and _status_item_archived(items[0], [Path(owner['ledger_path'])])
            return run(cfg, previous, rpc=client or DuplexClient(), now=now, write=lambda value: _write_atomic(state_path, value), legacy_archive_fn=legacy_archive)
    ledgers = [_read_json(path, f"ledger {path}") for path in cfg["ledger_paths"]]
    if cfg.get("status_path"):
        if not cfg["status_path"].exists(): _die("status_path is configured but missing")
        status = _read_json(cfg["status_path"], "status")
    else:
        status = None
    fp = fingerprint(ledgers, status)
    progress_fp = _progress_fingerprint(ledgers, status)
    signals = _signals(ledgers)
    state_path, lock_path = _state_paths(config_file)
    with _lock(lock_path) as acquired:
        if not acquired:
            return {"status": "locked", "fingerprint": fp, "dispatched": False}
        previous = _read_json(state_path, "continuation state") if state_path.exists() else {}
        terminal, failed = _terminal(ledgers, status, cfg["ledger_paths"])
        if failed:
            result = {"version": 1, "status": "blocked", "fingerprint": fp, "reason": "ledger/status contains failed terminal state", "dispatched": False}
            _write_atomic(state_path, result)
            return result
        if terminal:
            result = {"version": 1, "status": "complete", "fingerprint": fp, "last_progress_at": now, "dispatched": False}
            _write_atomic(state_path, result)
            return result
        if previous.get("lead_missing") and (previous.get("pending") or {}).get("target_session_id") != cfg["lead_session_id"]:
            # 配置已改绑到新 lead：丢弃发往旧 lead 的待送，按业务变化重发一次
            previous = {k: v for k, v in previous.items() if k not in {"pending", "lead_missing", "fingerprint", "status"}}
        changed = previous.get("fingerprint") != fp
        pending = previous.get("pending")
        # Older consumers stored this explicit pre-dispatch refusal as unknown.
        legacy_refresh_errors = {
            "PRECONDITION_FAILED: 伙伴能力正在刷新，请稍后再发送",
            "PRECONDITION_FAILED: [PRECONDITION_FAILED] 伙伴能力正在刷新，请稍后再发送",
        }
        if (isinstance(pending, dict) and pending.get("target_session_id") == cfg["lead_session_id"]
                and previous.get("status") == "pending-receipt"
                and previous.get("dispatch_error") in legacy_refresh_errors):
            previous = {**previous, "status": "retryable-rejected", "retryable_attempts": 1,
                        "last_dispatch_at": pending.get("created_at", now),
                        "dispatch_error_code": "PRECONDITION_FAILED"}
            _write_atomic(state_path, previous)
        if pending and previous.get("status") == "blocked":
            return {**previous, "dispatched": False}
        retryable = pending and previous.get("status") == "retryable-rejected"
        if pending and not retryable:
            return {**previous, "status": "pending-receipt", "fingerprint": fp, "dispatched": False}
        progress_changed = previous.get("progress_fingerprint") != progress_fp
        last_progress = float(previous.get("last_progress_at", now if progress_changed else now))
        if progress_changed:
            last_progress = now
        attempts = 0 if progress_changed else int(previous.get("stalled_attempts", 0)) if previous.get("fingerprint") == fp else 0
        reason = "business-change" if changed else "stalled"
        last_dispatch = float(previous.get("last_dispatch_at", 0))
        retryable_attempts = int(previous.get("retryable_attempts", 0))
        if retryable:
            if retryable_attempts >= 3:
                result = {**previous, "status": "blocked", "reason": "retryable host precondition rejected 3 times", "progress_fingerprint": progress_fp, "dispatched": False}
                _write_atomic(state_path, result)
                return result
            if now - last_dispatch < 300:
                return {**previous, "fingerprint": fp, "progress_fingerprint": progress_fp, "dispatched": False}
        if previous.get("status") == "blocked" and not changed and not progress_changed:
            result = {**previous, "version": 1, "fingerprint": fp, "progress_fingerprint": progress_fp, "dispatched": False}
            _write_atomic(state_path, result)
            return result
        stalled_due = now - last_progress >= cfg["stalled_after_sec"] and now - last_dispatch >= cfg["stalled_after_sec"]
        due = bool(retryable) or changed or stalled_due
        if not due:
            result = {**previous, "version": 1, "status": "monitoring", "fingerprint": fp, "progress_fingerprint": progress_fp, "last_progress_at": last_progress, "dispatched": False}
            _write_atomic(state_path, result)
            return result
        if not retryable and not changed and attempts >= 3:
            result = {"version": 1, "status": "blocked", "fingerprint": fp, "progress_fingerprint": progress_fp, "last_progress_at": last_progress, "last_dispatch_at": last_dispatch, "stalled_attempts": attempts, "reason": "no business progress after 3 continuation attempts", "dispatched": False}
            _write_atomic(state_path, result)
            return result
        message = _message(cfg, signals, fp, reason)
        intent = pending if retryable else {"fingerprint": fp, "reason": reason, "target_session_id": cfg["lead_session_id"], "created_at": now}
        before = {"version": 1, "status": "dispatching", "fingerprint": fp, "progress_fingerprint": progress_fp, "last_progress_at": now if progress_changed else last_progress, "last_dispatch_at": last_dispatch, "stalled_attempts": 0 if changed or progress_changed else attempts + 1, "pending": intent}
        _write_atomic(state_path, before)
        rpc = client or DuplexClient()
        try:
            receipt = rpc.call("sessions.dispatch", {"message": message, "target_session_id": cfg["lead_session_id"]})
        except Exception as exc:
            if _retryable_rejection(exc):
                result = {**before, "status": "retryable-rejected", "retryable_attempts": retryable_attempts + 1, "last_dispatch_at": now, "dispatch_error_code": exc.code, "dispatch_error": str(exc), "dispatched": False}
                _write_atomic(state_path, result)
                return result
            if _lead_missing(exc):
                # 目标 session 不存在是确定的派前拒绝，不是回执未知；静默挂 pending-receipt 会让 owner 的决策永远没人看
                result = {**before, "status": "blocked", "reason": "lead session not found", "lead_missing": True, "dispatch_error_code": getattr(exc, "code", ""), "dispatch_error": str(exc), "dispatched": False}
                _write_atomic(state_path, result)
                return result
            result = {**before, "status": "pending-receipt", "dispatch_error": str(exc), "dispatched": False}
            _write_atomic(state_path, result)
            return result
        if not isinstance(receipt, dict) or receipt.get("target_session_id") != cfg["lead_session_id"]:
            result = {**before, "status": "pending-receipt", "receipt": {"identity": "unknown"}, "dispatched": False}
            _write_atomic(state_path, result)
            return result
        result = {"version": 1, "status": "dispatched", "fingerprint": fp, "progress_fingerprint": progress_fp, "last_progress_at": now if progress_changed else last_progress, "last_dispatch_at": now, "stalled_attempts": 0 if changed or progress_changed else attempts + 1, "receipt": receipt, "dispatched": True}
        _write_atomic(state_path, result)
        return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        if os.environ.get("CINDY_SCRIPT_PROTOCOL") != "1" and os.environ.get("XDT_MAKER_SCRIPT_PROTOCOL") != "1":
            _die("必须在 Cindy script 调度下运行（缺 CINDY_SCRIPT_PROTOCOL），拒绝空跑")
        client = DuplexClient()
        client._ensure_started()
        capabilities = client.call("host.capabilities", {})
        methods = capabilities.get("methods", []) if isinstance(capabilities, dict) else []
        granted = capabilities.get("granted", []) if isinstance(capabilities, dict) else []
        if "sessions.dispatch" not in granted:
            _die("host 未授予 sessions.dispatch，拒绝唤醒")
        _, cfg = _config(args.config)
        result = run_once(args.config, client=client)
        summary = {"status": result.get("status"), "fingerprint": result.get("fingerprint"), "dispatched": result.get("dispatched", False)}
        if cfg.get("schemaVersion") == 2: summary["outcomes"] = result.get("outcomes", {})
        client.emit_complete(json.dumps(summary, ensure_ascii=False, separators=(",", ":")), cfg["lead_session_id"])
        if result.get("lead_missing"):
            # 让调度这一轮显式失败，别人才看得见绑定的 lead 已不存在
            raise RuntimeError(f"绑定的 lead session {cfg['lead_session_id']} 不存在；owner 的决策/Ready 信号无法送达，改配置里的 lead_session_id 后下一轮自动重发")
    except Exception as exc:
        print(f"lead-continuation: {exc}", file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
