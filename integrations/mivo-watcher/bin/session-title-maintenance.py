"""One approved title migration, delivered once to an existing Mini session."""
from __future__ import annotations
import json
import os
import re
import sqlite3
import time
from pathlib import Path


def atomic_json(file: Path, value: dict) -> None:
    temporary = file.with_suffix(file.suffix + f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(file)


def verified_titles(request: dict) -> bool:
    database = Path(request["metadataDatabase"])
    if not database.is_absolute() or database.suffix != ".db":
        raise ValueError("an exact Host metadata database path is required")
    changes = request["changes"]
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        placeholders = ",".join("?" for _ in changes)
        rows = connection.execute(f"SELECT id, title FROM sessions WHERE id IN ({placeholders})",
                                  [item["sessionId"] for item in changes]).fetchall()
    return dict(rows) == {item["sessionId"]: item["title"] for item in changes}


def run_title_maintenance(home: Path, client) -> dict | None:
    request_file = home / "state" / "maintenance" / "session-titles.json"
    if not request_file.exists():
        return None
    lease = home / "state" / "lease"
    lease_value = f"{os.getpid()} title-maintenance\n"
    try:
        descriptor = os.open(lease, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        request = json.loads(request_file.read_text())
        return {"kind": "session-title-migration", "requestId": request.get("requestId"),
                "targetSessionId": request.get("targetSessionId", ""), "status": "runtime-lease-held"}
    with os.fdopen(descriptor, "w") as output:
        output.write(lease_value)
    try:
        return _run_title_maintenance(home, client)
    finally:
        if lease.exists() and lease.read_text() == lease_value:
            lease.unlink()


def _run_title_maintenance(home: Path, client) -> dict | None:
    request_file = home / "state" / "maintenance" / "session-titles.json"
    if not request_file.exists():
        return None
    request = json.loads(request_file.read_text())
    request_id = request.get("requestId", "")
    if request.get("kind") != "session-title-migration" or not re.fullmatch(r"[a-z0-9-]{1,80}", request_id):
        raise ValueError("invalid title maintenance request")
    changes = request.get("changes", [])
    if not isinstance(changes, list) or not 1 <= len(changes) <= 20 or not request.get("authorizationRef"):
        raise ValueError("title migration needs an authorized bounded change list")
    state = json.loads((home / "state" / "state.json").read_text())
    bindings = state.get("prs", {})
    ids = set()
    for change in changes:
        entry = bindings.get(change.get("nodeId"), {})
        session_id = change.get("sessionId")
        if not session_id or session_id in ids or entry.get("sessionId") != session_id:
            raise ValueError("title migration must preserve unique existing bindings")
        if not re.fullmatch(r"#\d+-[^丨\r\n:#]{2,20}丨[0-9]{4}", change.get("title", "")):
            raise ValueError("invalid canonical title")
        ids.add(session_id)
    target = request.get("targetSessionId")
    if target not in ids:
        raise ValueError("maintenance target must be an existing bound session")
    result_file = request_file.parent / f"{request_id}.result.json"
    if result_file.exists():
        result = json.loads(result_file.read_text())
        expected = {item["sessionId"]: item["title"] for item in changes}
        actual = {item.get("sessionId"): item.get("title") for item in result.get("changes", [])}
        if result.get("requestId") == request_id and result.get("status") == "complete" and actual == expected and verified_titles(request):
            return None
        return {"kind": request["kind"], "requestId": request_id, "targetSessionId": target, "status": "blocked", "reason": "Host rename not verified"}
    receipt_file = request_file.parent / f"{request_id}.dispatch.json"
    attempt = 1
    if receipt_file.exists():
        previous = json.loads(receipt_file.read_text())
        if previous.get("status") == "retryable" and previous.get("attempt", 1) >= 3:
            return {"kind": request["kind"], "requestId": request_id, "targetSessionId": target,
                    "status": "blocked", "reason": "title migration reached three confirmed nondelivery attempts"}
        if previous.get("status") != "retryable" or previous.get("attempt", 1) >= 3 or previous.get("retryAt", 0) > time.time():
            return {"kind": request["kind"], "requestId": request_id, "targetSessionId": target, "status": "awaiting-host-receipt"}
        attempt = previous["attempt"] + 1
    host_changes = [{"session_id": item["sessionId"], "title": item["title"],
                     "expected_current_title": item["previousTitle"]} for item in changes]
    message = "\n".join([
        "执行一次性 Mini 会话命名迁移。用户已明确授权：按你的判断帮我全部修复执行。",
        f"requestId={request_id}",
        "仅更改下列既有 session 的标题，保留 ID、队列、PR 工作、goal 与所有历史。不要修改产品代码、PR、CI、模型或其它会话。",
        "使用当前 Mini 宿主 cindy_helper 的 control/rename_sessions。先 discover，dry_run=true 核对精确变更，再将同批 changes 和返回的 confirmation_token 以 dry_run=false 执行。已有用户授权，无需再问；不得直接修改数据库。",
        "changes=" + json.dumps(host_changes, ensure_ascii=False),
        "如果自己当前 session 改名受限，可对自身使用 set_current_session_title；其它7个仍用批量 rename_sessions，不新建session。",
        "通过宿主只读工具读回全部8个ID的标题，确认无遗漏后才写回执。失败应写status=blocked及具体原因，不能把派发成功算改名成功。",
        f"用 apply_patch 写结果到 {result_file}，格式：",
        json.dumps({"kind": request["kind"], "requestId": request_id, "status": "complete", "hostVerified": True,
                    "changes": [{"sessionId": item["sessionId"], "title": item["title"]} for item in changes]}, ensure_ascii=False),
        "回执只保留必要元数据与验证结论，不复制会话正文，不发 GitHub 评论。完成后结束本轮。",
    ])
    lock = receipt_file.with_suffix(".lock")
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return {"kind": request["kind"], "requestId": request_id, "targetSessionId": target, "status": "dispatch-in-flight"}
    os.close(descriptor)
    try:
        # Recheck inside the exclusive claim; another scheduler run may have won.
        if receipt_file.exists():
            saved = json.loads(receipt_file.read_text())
            if saved.get("status") != "retryable" or saved.get("attempt", 1) >= attempt:
                return {"kind": request["kind"], "requestId": request_id, "targetSessionId": target, "status": "awaiting-host-receipt"}
        atomic_json(receipt_file, {"requestId": request_id, "status": "pending", "targetSessionId": target, "attempt": attempt})
        try:
            receipt = client.call("sessions.dispatch", {"target_session_id": target, "message": message})
        except Exception as error:
            reason = str(error)
            retryable = "HOST_NOT_READY" in reason or ("PRECONDITION_FAILED" in reason and (
                "refresh" in reason.lower() or re.search(r"(?:伙伴|宿主).*能力.*刷新", reason)))
            atomic_json(receipt_file, {"requestId": request_id, "status": "retryable" if retryable else "unknown",
                                      "targetSessionId": target, "attempt": attempt, "retryAt": time.time() + 300,
                                      "reason": reason[:400]})
            return {"kind": request["kind"], "requestId": request_id, "targetSessionId": target, "status": "dispatch-unconfirmed"}
        if receipt.get("target_session_id") != target:
            raise ValueError("title maintenance delivery returned a different session")
        atomic_json(receipt_file, {"requestId": request_id, "status": "delivered", "attempt": attempt, "receipt": receipt})
        return {"kind": request["kind"], "requestId": request_id, "status": "delivered", "targetSessionId": target}
    finally:
        lock.unlink()
