#!/usr/bin/env python3
"""issue-watch.py — 批准执行 issue 入口的零 token 续跑脚本（cindy-script/1，PraiseZhu/approve-exec#69）。

每轮只读台账与 GitHub，发现下面四种情况时用 sessions.dispatch 叫醒 lead；同一情况只叫一次：
- accept：owner 写了 awaiting_acceptance checkpoint（按 checkpoint 序号去重）
- blocked：子 issue 停在 blocked_user（按停下的那一次去重）
- unlock：pending 子 issue 的依赖都已关闭（completed），可以派了
- stalled：在途子 issue 的台账活动和 PR head 都超过 stalled_after_sec 没变，且 PR 不在等 CI
全部子 issue 收工（archived / closed）后不再叫醒，状态写 complete。

配置 JSON：{"schema": "issue-watch-v1", "lead_session_id": "…", "ledger_paths": ["…"], "stalled_after_sec": 1800}
状态写在配置旁边的 <配置文件名>.state.json。
CLI：python3 scripts/issue-watch.py --config <issue-watch.json>（只在 Cindy script 调度下运行）。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from cindy_script import DuplexClient  # noqa: E402

SCHEMA = "issue-watch-v1"
IN_PROGRESS = {"dispatched", "revising", "accepted"}
DONE = {"archived", "closed"}
LABELS = {"accept": "待验收", "blocked": "需要用户", "unlock": "可派", "stalled": "停滞"}
NEXT_STEP = {
    "accept": "跑 accept-check --stage acceptance，再 issue-run verdict，把 owner_message 发回 owner 会话",
    "blocked": "把原因汇总告诉用户；用户处理完后 issue-run unblock，再通知 owner 会话",
    "unlock": "跑 issue-run next，对可派的子 issue 走 prepare → send_to_session → bind",
    "stalled": "查 owner 会话还在不在、卡在哪；需要时 send_to_session 催一次，或按 SKILL.md 改判",
}


class ConfigError(ValueError):
    pass


def read_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ConfigError(f"{label} 读不到: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{label} 不是合法 JSON: {exc}") from exc


def write_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def load_config(path: Path) -> dict[str, Any]:
    cfg = read_json(path, "配置")
    if not isinstance(cfg, dict) or cfg.get("schema") != SCHEMA:
        raise ConfigError(f"配置 schema 必须是 {SCHEMA}")
    if not isinstance(cfg.get("lead_session_id"), str) or not cfg["lead_session_id"]:
        raise ConfigError("配置缺 lead_session_id")
    paths = cfg.get("ledger_paths")
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) and os.path.isabs(p) for p in paths):
        raise ConfigError("ledger_paths 必须是非空的绝对路径数组")
    stalled = cfg.get("stalled_after_sec", 1800)
    if not isinstance(stalled, int) or stalled <= 0:
        raise ConfigError("stalled_after_sec 必须是正整数")
    return {**cfg, "stalled_after_sec": stalled}


@contextmanager
def file_lock(path: Path):
    """O_EXCL 锁；持有进程已死时回收。拿不到锁就跳过本轮。"""
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        try:
            os.kill(int(json.loads(path.read_text()).get("pid")), 0)
            yield False
            return
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            path.unlink(missing_ok=True)
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                yield False
                return
    try:
        os.write(fd, json.dumps({"pid": os.getpid(), "started": time.time()}).encode())
        yield True
    finally:
        os.close(fd)
        path.unlink(missing_ok=True)


# github


class GitHub:
    """只读 GitHub：issue 状态、PR head、PR 是否在等 CI。测试里换成假实现。"""

    def _run(self, args: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)

    def _json(self, args: list[str]) -> Any:
        res = self._run(args)
        if res.returncode != 0:
            raise RuntimeError(f"gh {' '.join(args)} 失败: {res.stderr.strip()[:200]}")
        return json.loads(res.stdout)

    def issue_done(self, ref: str) -> bool:
        repo, number = ref.split("#")
        issue = self._json(["api", f"repos/{repo}/issues/{number}"])
        return issue.get("state") == "closed" and issue.get("state_reason") != "not_planned"

    def pr_head(self, repo: str, number: int) -> str | None:
        return (self._json(["api", f"repos/{repo}/pulls/{number}"]).get("head") or {}).get("sha")

    def ci_pending(self, repo: str, number: int) -> bool:
        # gh pr checks 有进行中的检查时退出码 8，这里只看输出里有没有 pending。
        res = self._run(["pr", "checks", str(number), "--repo", repo, "--json", "bucket"])
        try:
            return any(c.get("bucket") == "pending" for c in json.loads(res.stdout or "[]"))
        except json.JSONDecodeError:
            return False


# signals


def epoch(iso: str | None) -> float:
    if not iso:
        return 0.0
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def collect(ledger: dict[str, Any], gh: Any, now: float, stalled_after: int, heads: dict[str, Any]) -> list[dict[str, Any]]:
    """一份台账 → 本轮的信号列表；heads 记每个 PR head 第一次被看到的时间（原地更新）。"""
    signals: list[dict[str, Any]] = []
    for item in ledger.get("items", {}).values():
        ref, state = item["ref"], item["state"]
        cp = item.get("checkpoint") or {}
        if state == "awaiting_acceptance":
            signals.append({"key": f"accept:{ref}:{item.get('checkpoint_seq')}", "kind": "accept", "ref": ref,
                            "detail": f"PR #{cp.get('pr')} head {cp.get('head')}"})
        elif state == "blocked_user":
            blocked = item.get("blocked") or {}
            signals.append({"key": f"blocked:{ref}:{blocked.get('seq')}:{blocked.get('at')}", "kind": "blocked", "ref": ref,
                            "detail": blocked.get("reason") or "原因未写"})
        elif state == "pending":
            deps = item.get("hard_deps") or []
            if all(gh.issue_done(d) for d in deps):
                signals.append({"key": f"unlock:{ref}", "kind": "unlock", "ref": ref,
                                "detail": f"依赖 {'、'.join(deps)} 已合入" if deps else "没有依赖，还没派"})
        elif state in IN_PROGRESS:
            marker = epoch(item.get("last_activity_at"))
            pr = cp.get("pr")
            if pr:
                head = gh.pr_head(item["repo"], pr)
                seen = heads.get(ref)
                if not seen or seen.get("head") != head:
                    seen = {"head": head, "since": now}
                    heads[ref] = seen
                marker = max(marker, float(seen["since"]))
            if now - marker >= stalled_after and not (pr and gh.ci_pending(item["repo"], pr)):
                signals.append({"key": f"stalled:{ref}:{int(marker)}", "kind": "stalled", "ref": ref,
                                "detail": f"状态 {state}，{int((now - marker) // 60)} 分钟没有进展"})
    return signals


def compose(signals: list[dict[str, Any]], roots: dict[str, str]) -> str:
    lines = ["批准执行续跑唤醒（issue-watch）。按 approve-exec SKILL.md ⓪ 的步骤处理，已做过的步骤不要重做。"]
    for ledger_path, root in roots.items():
        lines.append(f"总 issue {root}；台账 {ledger_path}")
    for s in signals:
        lines.append(f"- [{LABELS[s['kind']]}] {s['ref']}：{s['detail']}。{NEXT_STEP[s['kind']]}。")
    return "\n".join(lines)


def run_once(config_path: str | Path, *, client: Any, gh: Any, now: float | None = None) -> dict[str, Any]:
    config_file = Path(config_path)
    cfg = load_config(config_file)
    now = time.time() if now is None else now
    state_path = config_file.with_name(f"{config_file.name}.state.json")
    with file_lock(config_file.with_name(f"{config_file.name}.lock")) as acquired:
        if not acquired:
            return {"status": "locked", "dispatched": False}
        state = read_json(state_path, "状态") if state_path.exists() else {}
        notified: dict[str, float] = dict(state.get("notified") or {})
        heads: dict[str, Any] = dict(state.get("heads") or {})
        ledgers = [(p, read_json(Path(p), f"台账 {p}")) for p in cfg["ledger_paths"]]
        if all(all(i.get("state") in DONE for i in l.get("items", {}).values()) for _, l in ledgers):
            result = {"status": "complete", "dispatched": False}
            write_atomic(state_path, {**state, "status": "complete", "checked_at": now})
            return result
        signals: list[dict[str, Any]] = []
        for _, ledger in ledgers:
            signals.extend(collect(ledger, gh, now, cfg["stalled_after_sec"], heads))
        fresh = [s for s in signals if s["key"] not in notified]
        base = {"notified": notified, "heads": heads, "checked_at": now}
        if not fresh:
            write_atomic(state_path, {**base, "status": "monitoring"})
            return {"status": "monitoring", "dispatched": False, "signals": 0}
        message = compose(fresh, {p: l.get("root", {}).get("ref", "?") for p, l in ledgers})
        try:
            receipt = client.call("sessions.dispatch", {"message": message, "target_session_id": cfg["lead_session_id"]})
        except Exception as exc:  # noqa: BLE001 — 按错误码分类，其余都当回执未知
            code = getattr(exc, "code", "")
            if code == "NOT_FOUND":
                write_atomic(state_path, {**base, "status": "blocked", "lead_missing": True, "error": str(exc)})
                return {"status": "blocked", "lead_missing": True, "dispatched": False}
            status = "retryable-rejected" if code in {"HOST_NOT_READY", "PRECONDITION_FAILED"} else "pending-receipt"
            # 没标记已通知：下一轮重发（至多重复一次唤醒，不会漏掉）。
            write_atomic(state_path, {**base, "status": status, "error": str(exc)})
            return {"status": status, "dispatched": False}
        if not isinstance(receipt, dict) or receipt.get("target_session_id") != cfg["lead_session_id"]:
            write_atomic(state_path, {**base, "status": "pending-receipt", "receipt": receipt})
            return {"status": "pending-receipt", "dispatched": False}
        for s in fresh:
            notified[s["key"]] = now
        write_atomic(state_path, {**base, "notified": notified, "status": "dispatched", "receipt": receipt})
        return {"status": "dispatched", "dispatched": True, "signals": [s["key"] for s in fresh]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        if os.environ.get("CINDY_SCRIPT_PROTOCOL") != "1" and os.environ.get("XDT_MAKER_SCRIPT_PROTOCOL") != "1":
            raise ConfigError("必须在 Cindy script 调度下运行（缺 CINDY_SCRIPT_PROTOCOL），拒绝空跑")
        client = DuplexClient()
        client._ensure_started()
        capabilities = client.call("host.capabilities", {})
        granted = capabilities.get("granted", []) if isinstance(capabilities, dict) else []
        if "sessions.dispatch" not in granted:
            raise ConfigError("宿主没有授予 sessions.dispatch，无法叫醒 lead")
        cfg = load_config(Path(args.config))
        result = run_once(args.config, client=client, gh=GitHub())
        client.emit_complete(json.dumps(result, ensure_ascii=False, separators=(",", ":")), cfg["lead_session_id"])
        if result.get("lead_missing"):
            raise RuntimeError(f"绑定的 lead 会话 {cfg['lead_session_id']} 不存在：改配置里的 lead_session_id 后下一轮自动重发")
    except Exception as exc:  # noqa: BLE001 — 让本轮调度显式失败
        print(f"issue-watch: {exc}", file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
