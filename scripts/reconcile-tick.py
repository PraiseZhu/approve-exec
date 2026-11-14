#!/usr/bin/env python3
"""reconcile-tick.py：批准执行 v3 对账任务的入口（PraiseZhu/approve-exec#108）。

挂在 Cindy 定时任务的脚本模式下，不调用模型。每轮：
1. 运行 `node scripts/reconcile.mjs --roots-from-search`，拿到所有带运行章程的总 issue 的到期动作；
2. 用本地缓存去重（同一个 key 24 小时内只处理一次；缓存丢了最多多敲一次门）；
3. `record` 模式（默认）只把到期动作追加到 due-log.jsonl；`ring` 模式用 sessions.dispatch 叫醒该做事的会话。

不向 GitHub 写任何内容；进度状态全部由 reconcile.mjs 从 GitHub 现算，本脚本只存「已敲过门」的去重缓存和一份动作日志。
环境变量：APPROVE_EXEC_TICK_MODE=record|ring；APPROVE_EXEC_STATE_DIR（默认 ~/.claude/state/approve-exec）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))

DEDUPE_SEC = 24 * 3600
UNDELIVERABLE = {"ARCHIVED", "DELETED", "NOT_FOUND", "AGENT_NOT_READY"}
# 三台 Linux 主机只当网关，不给上面的会话发消息（全局规则「Linux 主机只当网关」）。
# 只有 lead 地址带设备 id，所以只在叫醒 lead 时检查。执行会话由 lead 在自己这台 Mac 上新建（send_to_session 不传 device），
# 网关只是它的模型供应商位置；派发事件里记的是本机会话 id（不含设备前缀），叫醒它不会把消息发到 Linux 上。
LINUX_GATEWAYS = {
    "6c2d712118196434b26659a137106a597805bcd38a6f75f9d434363f566a01d0",
    "8620a24bb37ab0fff5f06fe54601a7747583995243a3086ccc1b769facd8fcec",
    "e41ff4d26db3e7d31be3699fd88ef48525d7e96c7262a58f2e954556d4cbdc0a",
}
SECTION = {
    "wake_lead": "SKILL.md「被消息叫醒后」",
    "recheck": "SKILL.md「被消息叫醒后」的「对账：复核」",
    "request_merge": "SKILL.md「被消息叫醒后」的「对账：交合并请求」",
    "wake_owner": "references/owner-protocol.md「收到对账敲门」",
}


class TickError(RuntimeError):
    pass


def state_dir() -> Path:
    return Path(os.environ.get("APPROVE_EXEC_STATE_DIR") or Path.home() / ".claude" / "state" / "approve-exec")


def read_cache(path: Path) -> dict[str, float]:
    """去重缓存读不到或坏了都当成空的：最多多敲一次门，不让对账停摆。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {str(k): float(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def write_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temp.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temp, path)


def append_log(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def run_reconcile() -> dict[str, Any]:
    res = subprocess.run(
        ["node", str(ROOT / "scripts" / "reconcile.mjs"), "--roots-from-search"],
        capture_output=True, text=True, timeout=540,
    )
    if res.returncode != 0:
        raise TickError(f"reconcile.mjs 退出码 {res.returncode}: {res.stderr.strip()[:300]}")
    return json.loads(res.stdout)


def split_address(address: str | None) -> tuple[str | None, str | None]:
    if not address:
        return None, None
    if "::" in address:
        device, session = address.split("::", 1)
        return device, session
    return None, address


def compose(action: dict[str, Any]) -> str:
    return "\n".join([
        f"批准执行对账：{action['ref']} {action['action']}",
        str(action.get("reason") or ""),
        f"该做的一步见 {SECTION.get(action['action'], 'SKILL.md')}",
    ])


def dispatch(client: Any, session: str, message: str) -> str | None:
    """叫醒一个会话。送到了返回 None，送不到返回错误码。"""
    try:
        receipt = client.call("sessions.dispatch", {"message": message, "target_session_id": session})
    except Exception as exc:  # noqa: BLE001 — 按错误码分类
        code = getattr(exc, "code", "") or "UNKNOWN"
        return code
    if not isinstance(receipt, dict) or receipt.get("ok") is False:
        return str((receipt or {}).get("code") or "BAD_RECEIPT") if isinstance(receipt, dict) else "BAD_RECEIPT"
    return None


def run_once(*, client: Any, reconcile: Callable[[], dict[str, Any]] = run_reconcile, mode: str | None = None,
             now: float | None = None, directory: Path | None = None) -> dict[str, Any]:
    mode = mode or os.environ.get("APPROVE_EXEC_TICK_MODE") or "record"
    if mode not in {"record", "ring"}:
        raise TickError(f"APPROVE_EXEC_TICK_MODE 只能是 record 或 ring（当前：{mode}）")
    now = time.time() if now is None else now
    directory = directory or state_dir()
    cache_path = directory / "doorbell.json"
    log_path = directory / "due-log.jsonl"
    cache = {k: v for k, v in read_cache(cache_path).items() if now - v < DEDUPE_SEC}
    result = reconcile()
    summary = {"mode": mode, "roots": 0, "due": 0, "fresh": 0, "rung": 0, "logged": 0, "lead_unreachable": []}

    for run in result.get("runs", []):
        summary["roots"] += 1
        sessions = {c["ref"]: c.get("session") for c in run.get("children", [])}
        lead_device, lead_session = split_address(run.get("lead_session"))
        for action in run.get("due", []):
            summary["due"] += 1
            # 两种模式的去重键分开：只记不敲时记过的动作，切到敲门模式后照常敲。
            key = f"{mode}|{run['root']}|{action['key']}"
            if key in cache:
                continue
            summary["fresh"] += 1
            row = {"at": now, "root": run["root"], **action, "mode": mode}

            def log(extra: dict[str, Any]) -> None:
                append_log(log_path, {**row, **extra})
                summary["logged"] += 1

            if mode == "record":
                log({"outcome": "recorded"})
                cache[key] = now
                continue

            def ring_lead(message: str) -> str | None:
                if not lead_session:
                    return "NO_LEAD_SESSION"
                if lead_device in LINUX_GATEWAYS:
                    return "LINUX_GATEWAY"
                return dispatch(client, lead_session, message)

            error = None
            if action.get("target") == "owner":
                owner = sessions.get(action["ref"])
                error = dispatch(client, owner, compose(action)) if owner else "NO_OWNER_SESSION"
                if error is not None:
                    # 执行会话送不到：改成告诉 lead，由它核实后撤回重派。
                    lead_action = {**action, "action": "wake_lead", "reason": f"执行会话送不到：{error}。{action.get('reason', '')}"}
                    error = ring_lead(compose(lead_action))
            else:
                error = ring_lead(compose(action))

            if error is None:
                summary["rung"] += 1
                log({"outcome": "rung"})
                cache[key] = now
            elif error in UNDELIVERABLE or error in {"NO_LEAD_SESSION", "LINUX_GATEWAY"}:
                log({"outcome": "lead_unreachable", "error": error})
                summary["lead_unreachable"].append({"root": run["root"], "ref": action["ref"], "error": error})
                cache[key] = now
            else:
                # 回执不明（宿主没就绪等）：不记缓存，下一轮再敲。
                log({"outcome": "retry_next_round", "error": error})

    write_atomic(cache_path, cache)
    return summary


def main() -> None:
    try:
        if os.environ.get("CINDY_SCRIPT_PROTOCOL") != "1" and os.environ.get("XDT_MAKER_SCRIPT_PROTOCOL") != "1":
            raise TickError("必须在 Cindy 定时任务的脚本模式下运行（缺 CINDY_SCRIPT_PROTOCOL），拒绝空跑")
        from cindy_script import DuplexClient  # noqa: PLC0415 — 只在真跑时接管 stdout

        client = DuplexClient()
        client._ensure_started()
        mode = os.environ.get("APPROVE_EXEC_TICK_MODE") or "record"
        if mode == "ring":
            capabilities = client.call("host.capabilities", {})
            granted = capabilities.get("granted", []) if isinstance(capabilities, dict) else []
            if "sessions.dispatch" not in granted:
                raise TickError("宿主没有授予 sessions.dispatch，ring 模式无法叫醒会话")
        summary = run_once(client=client, mode=mode)
        client.emit_complete(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))
        if summary["lead_unreachable"]:
            sys.exit(1)
    except TickError as exc:
        print(f"[reconcile-tick] {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
