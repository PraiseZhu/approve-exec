#!/usr/bin/env python3
"""Cindy script-mode 盯梢：探测零 token；create 后必须把 session_id 写回名册。"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
NODE = HERE / "session-watch.mjs"
CONFIG = ROOT / "config" / "mini-watch.json"
# Cindy 调度不注入 PYTHONPATH；客户端与本脚本同目录（Cindy 文档：拷走 protocol.py / maker_client.py）。


def _load_watch_config() -> dict:
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    mini = (cfg.get("hosts") or {}).get("mini") or {}
    provider = mini.get("provider_id")
    if not isinstance(provider, str) or not provider:
        raise SystemExit("config/mini-watch.json hosts.mini.provider_id 缺失")
    if cfg.get("auto_merge") is True:
        raise SystemExit("auto_merge=true 尚未实现；本轮只读且必须为 false")
    return cfg


def _run_node(args: list[str]) -> str:
    return subprocess.check_output(["node", str(NODE), *args], text=True)


def _scan() -> dict:
    state_dir = os.environ.get("AE_WATCH_STATE_DIR", "")
    snapshot_cmd = os.environ.get("AE_WATCH_SNAPSHOT_CMD", "")
    if not state_dir or not snapshot_cmd:
        raise SystemExit("AE_WATCH_STATE_DIR / AE_WATCH_SNAPSHOT_CMD 未设置")
    raw = _run_node(["--state-dir", state_dir, "--snapshot-cmd", snapshot_cmd])
    return json.loads(raw)


def _bind(state_dir: str, plan: dict, session_id: str) -> None:
    _run_node([
        "bind",
        "--state-dir", state_dir,
        "--owner", plan["owner"],
        "--repo", plan["repo"],
        "--pr", str(plan["pr"]),
        "--session-id", session_id,
        "--claim-id", plan["_create_claim_id"],
    ])


def _persist_cursors(state_dir: str, plan: dict) -> None:
    cursors = plan.get("next_cursors")
    if not cursors:
        return
    _run_node([
        "persist-cursors",
        "--state-dir", state_dir,
        "--owner", plan["owner"],
        "--repo", plan["repo"],
        "--pr", str(plan["pr"]),
        "--cursors", json.dumps(cursors, separators=(",", ":")),
    ])


def _unregister(state_dir: str, term: dict) -> None:
    _run_node([
        "unregister",
        "--state-dir", state_dir,
        "--owner", term["owner"],
        "--repo", term["repo"],
        "--pr", str(term["pr"]),
        "--reason", "terminal",
    ])


def _dispatch_params(plan: dict) -> dict:
    params = {
        "message": plan.get("message") or plan.get("title", ""),
        "title": plan.get("title", ""),
    }
    if plan.get("session_id"):
        params["target_session_id"] = plan["session_id"]
    return params


def _claim_create(state_dir: str, plan: dict) -> dict:
    raw = _run_node([
        "claim-create",
        "--state-dir", state_dir,
        "--owner", plan["owner"],
        "--repo", plan["repo"],
        "--pr", str(plan["pr"]),
        # claim is persisted by a short-lived Node helper; bind the lease to
        # this long-lived Python scheduler process instead of that child pid.
        "--owner-pid", str(os.getpid()),
    ])
    return json.loads(raw)


def _release_create(state_dir: str, plan: dict, claim_id: str | None = None) -> None:
    args = [
        "release-create",
        "--state-dir", state_dir,
        "--owner", plan["owner"],
        "--repo", plan["repo"],
        "--pr", str(plan["pr"]),
    ]
    if claim_id:
        args.extend(["--claim-id", claim_id])
    _run_node(args)


def _ack_takeover(scan: dict, state_dir: str, schedule_id: str) -> None:
    for item in scan.get("observed", []):
        subprocess.check_output([
            "node", str(HERE / "takeover.mjs"), "ack", "--state-dir", state_dir,
            "--owner", item["owner"], "--repo", item["repo"], "--pr", str(item["pr"]),
            "--schedule-id", schedule_id,
        ], text=True)


def apply_watch_round(dispatch_fn, *, scan=None, bind_fn=_bind, persist_fn=_persist_cursors, unregister_fn=_unregister, claim_fn=_claim_create, release_fn=_release_create) -> dict:
    """真实协议一轮：create 必须拿到 session_id 并写回；无信号不派。"""
    state_dir = os.environ.get("AE_WATCH_STATE_DIR", "")
    if not state_dir:
        raise SystemExit("AE_WATCH_STATE_DIR 未设置")
    scan = scan if scan is not None else _scan()
    applied = []
    errors = []
    for plan in scan.get("dispatches", []):
        try:
            live = dict(plan)
            if live.get("action") == "create":
                claim = claim_fn(state_dir, live)
                if not claim.get("claimed"):
                    live["action"] = "jump"
                    live["session_id"] = claim.get("session_id")
                else:
                    live["_create_claim_id"] = (claim.get("claim_id")
                                                  or claim.get("state", {}).get("create_claim", {}).get("claim_id"))
            claim_id = live.get("_create_claim_id") if live.get("action") == "create" else None
            try:
                result = dispatch_fn(_dispatch_params(live)) or {}
            except Exception:
                # A lost response may hide a successful external create. Keep claim.
                raise
            session_id = result.get("target_session_id")
            if live.get("action") == "create":
                if not session_id:
                    raise RuntimeError(
                        f"create {live.get('owner')}/{live.get('repo')}#{live.get('pr')} 未返回 target_session_id，拒绝空跑"
                    )
                bind_fn(state_dir, live, session_id)
            persist_fn(state_dir, live)
            live.pop("_create_claim_id", None)
            applied.append({**live, "session_id": session_id or live.get("session_id")})
        except Exception as exc:
            errors.append({"owner": plan.get("owner"), "repo": plan.get("repo"), "pr": plan.get("pr"), "error": str(exc)})
            # Keep an ambiguous create claimed; continue unrelated PRs.
    for term in scan.get("terminals", []):
        unregister_fn(state_dir, term)
    return {
        "scanned": scan.get("scanned", 0),
        "dispatches": applied,
        "errors": errors,
        "terminals": scan.get("terminals", []),
    }


def main() -> None:
    if os.environ.get("CINDY_SCRIPT_PROTOCOL") != "1" and os.environ.get("XDT_MAKER_SCRIPT_PROTOCOL") != "1":
        raise SystemExit("必须在 Cindy script 调度下运行（缺 CINDY_SCRIPT_PROTOCOL），拒绝空跑")
    _load_watch_config()
    sys.path.insert(0, str(HERE))
    try:
        from maker_client import emit_complete, sessions_dispatch, _client
    except ImportError as exc:
        raise SystemExit(f"cindy-script 协议客户端缺失，拒绝空跑: {exc}") from exc

    def dispatch(params: dict) -> dict:
        return sessions_dispatch(
            params["message"],
            title=params.get("title"),
            target_session_id=params.get("target_session_id"),
        ) or {}

    # Consume the actual host start frame before scanning; no Core changes.
    _client._ensure_started()
    schedule_id = _client.context.get("scheduleId")
    if not isinstance(schedule_id, str) or not schedule_id:
        raise SystemExit("当前 script start 帧缺 scheduleId，不能出接管回执")
    scan = _scan()
    out = apply_watch_round(dispatch, scan=scan)
    failed = {(item["owner"], item["repo"], item["pr"]) for item in out["errors"]}
    scan["observed"] = [item for item in scan.get("observed", []) if (item["owner"], item["repo"], item["pr"]) not in failed]
    _ack_takeover(scan, os.environ["AE_WATCH_STATE_DIR"], schedule_id)
    last_id = None
    if out["dispatches"]:
        last_id = out["dispatches"][-1].get("session_id")
    emit_complete(
        f"dispatches={len(out['dispatches'])} terminals={len(out['terminals'])} errors={json.dumps(out['errors'], ensure_ascii=False)}",
        last_id,
    )


if __name__ == "__main__":
    main()
