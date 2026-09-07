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
ACTIVE_SOURCE = Path("/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/approve-exec")
# Cindy 调度不注入 PYTHONPATH；客户端与本脚本同目录（Cindy 文档：拷走 protocol.py / maker_client.py）。


def _load_watch_config() -> dict:
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    mini = (cfg.get("hosts") or {}).get("mini") or {}
    provider = mini.get("provider_id")
    if not isinstance(provider, str) or not provider:
        raise SystemExit("config/mini-watch.json hosts.mini.provider_id 缺失")
    hostname = mini.get("hostname")
    if not isinstance(hostname, str) or not hostname:
        raise SystemExit("config/mini-watch.json hosts.mini.hostname 缺失")
    if cfg.get("auto_merge") is True:
        raise SystemExit("auto_merge=true 尚未实现；本轮只读且必须为 false")
    return cfg


def _default_watch_paths(cfg: dict) -> tuple[str, str]:
    mini = (cfg.get("hosts") or {}).get("mini") or {}
    state_dir = mini.get("state_dir")
    if not isinstance(state_dir, str) or not state_dir:
        raise SystemExit("config/mini-watch.json hosts.mini.state_dir 缺失")
    snapshot_path = ACTIVE_SOURCE / "deploy" / "wrappers" / "gh-snapshot.mjs"
    snapshot_cmd = f"node {snapshot_path} {{owner}} {{repo}} {{pr}}"
    return state_dir, snapshot_cmd


def _resolve_watch_paths(cfg: dict) -> tuple[str, str]:
    default_state_dir, default_snapshot_cmd = _default_watch_paths(cfg)
    return (
        os.environ.get("AE_WATCH_STATE_DIR") or default_state_dir,
        os.environ.get("AE_WATCH_SNAPSHOT_CMD") or default_snapshot_cmd,
    )


def _assert_mini_hostname(cfg: dict, uname_fn=None) -> None:
    expected = cfg["hosts"]["mini"]["hostname"]
    actual = (uname_fn or os.uname)().nodename
    if actual != expected:
        raise SystemExit(f"Mini hostname 不匹配：期望 {expected}，当前 {actual}，拒绝启动扫描")


def _run_node(args: list[str]) -> str:
    return subprocess.check_output(["node", str(NODE), *args], text=True)


def _scan(state_dir: str, snapshot_cmd: str) -> dict:
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


def _prepare_pending(state_dir: str, plan: dict) -> dict:
    pending = {
        "action": plan["action"],
        "owner": plan["owner"],
        "repo": plan["repo"],
        "pr": plan["pr"],
        "head_sha": plan["head_sha"],
        "signal_id": plan["lead_signal"]["signal_id"],
        "title": plan["title"],
        "next_cursors": plan.get("next_cursors"),
    }
    raw = _run_node([
        "prepare-dispatch",
        "--state-dir", state_dir,
        "--owner", plan["owner"],
        "--repo", plan["repo"],
        "--pr", str(plan["pr"]),
        "--pending", json.dumps(pending, ensure_ascii=False, separators=(",", ":")),
    ])
    return json.loads(raw)


def _record_dispatch(state_dir: str, plan: dict, receipt: dict) -> dict:
    raw = _run_node([
        "record-dispatch",
        "--state-dir", state_dir,
        "--owner", plan["owner"],
        "--repo", plan["repo"],
        "--pr", str(plan["pr"]),
        "--dispatch-id", plan["dispatch_id"],
        "--receipt", json.dumps(receipt, ensure_ascii=False, separators=(",", ":")),
    ])
    return json.loads(raw)


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
    raw = _run_node([
        "build-dispatch",
        "--plan", json.dumps(plan, ensure_ascii=False, separators=(",", ":")),
    ])
    return json.loads(raw)


def _claim_create(state_dir: str, plan: dict) -> dict:
    raw = _run_node([
        "claim-create",
        "--state-dir", state_dir,
        "--owner", plan["owner"],
        "--repo", plan["repo"],
        "--pr", str(plan["pr"]),
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


def apply_watch_round(dispatch_fn, *, state_dir: str, snapshot_cmd: str, scan=None, bind_fn=_bind, persist_fn=_persist_cursors, unregister_fn=_unregister, claim_fn=_claim_create, release_fn=_release_create, prepare_fn=_prepare_pending, record_fn=_record_dispatch) -> dict:
    if not state_dir:
        raise SystemExit("AE_WATCH_STATE_DIR 未设置")
    scan = scan if scan is not None else _scan(state_dir, snapshot_cmd)
    applied = []
    errors = list(scan.get("errors", []))
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
            prepared = prepare_fn(state_dir, live)
            if not prepared.get("prepared"):
                raise RuntimeError("pending_dispatch 已存在，拒绝重复派发")
            live["dispatch_id"] = prepared["pending"]["dispatch_id"]
            result = dispatch_fn(_dispatch_params(live)) or {}
            receipt = record_fn(state_dir, live, result)
            if not receipt.get("bound"):
                raise RuntimeError(
                    f"宿主回执 status={receipt.get('status')} 未返回 session_id，已保留 pending_dispatch，未推进游标"
                )
            live.pop("_create_claim_id", None)
            applied.append({**live, "session_id": receipt.get("session_id") or live.get("session_id"), "ack_pending": True, "host_status": receipt.get("status")})
        except Exception as exc:
            errors.append({"owner": plan.get("owner"), "repo": plan.get("repo"), "pr": plan.get("pr"), "error": str(exc)})
    for term in scan.get("terminals", []):
        try:
            unregister_fn(state_dir, term)
        except Exception as exc:
            errors.append({"owner": term.get("owner"), "repo": term.get("repo"), "pr": term.get("pr"), "phase": "unregister", "error": str(exc)})
    return {
        "scanned": scan.get("scanned", 0),
        "dispatches": applied,
        "errors": errors,
        "terminals": scan.get("terminals", []),
        "cloud_ready": scan.get("cloud_ready", []),
    }


def main(uname_fn=None) -> None:
    if os.environ.get("CINDY_SCRIPT_PROTOCOL") != "1" and os.environ.get("XDT_MAKER_SCRIPT_PROTOCOL") != "1":
        raise SystemExit("必须在 Cindy script 调度下运行（缺 CINDY_SCRIPT_PROTOCOL），拒绝空跑")
    cfg = _load_watch_config()
    _assert_mini_hostname(cfg, uname_fn)
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

    _client._ensure_started()
    schedule_id = _client.context.get("scheduleId")
    if not isinstance(schedule_id, str) or not schedule_id:
        raise SystemExit("当前 script start 帧缺 scheduleId，不能出接管回执")
    state_dir, snapshot_cmd = _resolve_watch_paths(cfg)
    scan = _scan(state_dir, snapshot_cmd)
    out = apply_watch_round(dispatch, state_dir=state_dir, snapshot_cmd=snapshot_cmd, scan=scan)
    failed = {(item.get("owner"), item.get("repo"), item.get("pr")) for item in out["errors"]}
    scan["observed"] = [item for item in scan.get("observed", []) if (item["owner"], item["repo"], item["pr"]) not in failed]
    _ack_takeover(scan, state_dir, schedule_id)
    last_id = None
    if out["dispatches"]:
        last_id = out["dispatches"][-1].get("session_id")
    emit_complete(
        f"已投递 {len(out['dispatches'])} 个 PR；云端可合并 {len(out['cloud_ready'])} 个（不自动合并）；结束盯梢 {len(out['terminals'])} 个；阻塞 {json.dumps(out['errors'], ensure_ascii=False)}",
        last_id,
    )


if __name__ == "__main__":
    main()
