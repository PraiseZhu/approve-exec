#!/usr/bin/env python3
"""Cindy script-mode Mivo watcher dry-run. Does not create sessions by default."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROTOCOL_CANDIDATES = [
    HERE / "protocol.py",
    Path("/Users/praise/AI-Agent/Claude/capabilities/source/approve-exec-src/scripts/pr-watch/protocol.py"),
]


def watcher_home() -> Path:
    """Resolve the watcher beside this wrapper in source and deployed layouts."""
    explicit = os.environ.get("MIVO_WATCHER_HOME")
    if explicit:
        candidate = Path(explicit).expanduser()
        if (candidate / "bin" / "mivo-watcher.mjs").exists():
            return candidate
        if (candidate / "mivo-watcher.mjs").exists():
            return candidate
        # Keep an explicit override useful for first deployment/state creation.
        return candidate
    return HERE.parent if HERE.name == "bin" else HERE


def watcher_path() -> Path:
    root = watcher_home()
    direct = root / "mivo-watcher.mjs"
    nested = root / "bin" / "mivo-watcher.mjs"
    if direct.exists():
        return direct
    return nested


def node_path() -> str:
    configured = os.environ.get("MIVO_NODE_BIN")
    if configured:
        return configured
    discovered = shutil.which("node")
    if discovered:
        return discovered
    raise RuntimeError("node executable not found; set MIVO_NODE_BIN")


def _import_client():
    for candidate in PROTOCOL_CANDIDATES:
        if candidate.exists():
            sys.path.insert(0, str(candidate.parent))
            break
    from protocol import DuplexClient  # type: ignore
    return DuplexClient()


def _summary(scan: dict) -> dict:
    """Keep completion evidence bounded and exclude feedback bodies."""
    def scrub(value):
        if isinstance(value, dict):
            return {
                key: scrub(item)
                for key, item in value.items()
                if key not in {"feedback", "body", "message"}
            }
        if isinstance(value, list):
            return [scrub(item) for item in value]
        return value

    complete = scrub({
        "mode": scan.get("mode"),
        "dispatch": bool(scan.get("dispatch")),
        "launchAgentLoaded": False,
        "viewer": scan.get("viewer"),
        "repo": scan.get("repo"),
        "prs": scan.get("prs", []),
        "events": scan.get("events", []),
        "statePath": scan.get("statePath"),
    })
    encoded = json.dumps(complete, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 7800:
        # Preserve protocol evidence while bounding arbitrary PR metadata.
        complete["prs"] = []
        complete["truncated"] = True
    return complete


def _drain(stream, sink):
    try:
        for chunk in iter(stream.readline, ""):
            sink.append(chunk)
    finally:
        stream.close()


def _run_watcher(env: dict[str, str], watcher: Path, node: str, client, live: bool) -> dict:
    process = subprocess.Popen(
        [node, str(watcher)],
        env=env,
        text=True,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=1,
    )
    assert process.stdout is not None and process.stdin is not None and process.stderr is not None
    stderr_chunks: list[str] = []
    stderr_thread = threading.Thread(target=_drain, args=(process.stderr, stderr_chunks), daemon=True)
    stderr_thread.start()
    scan = None
    try:
        for line in process.stdout:
            if not line.strip():
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError(f"watcher produced non-protocol output: {line.strip()}") from error
            if not isinstance(frame, dict):
                raise RuntimeError("watcher produced a non-object protocol frame")
            if frame.get("type") == "dispatch":
                if not live:
                    raise RuntimeError("watcher requested dispatch while live mode is disabled")
                if not isinstance(frame.get("id"), str) or not frame["id"]:
                    raise RuntimeError("watcher dispatch frame missing id")
                if not isinstance(frame.get("params"), dict):
                    raise RuntimeError("watcher dispatch frame missing params")
                try:
                    receipt = client.call("sessions.dispatch", frame["params"])
                    response = {"type": "receipt", "id": frame.get("id"), "receipt": receipt}
                except Exception as error:  # unblock Node with an explicit rejection
                    response = {"type": "receipt", "id": frame.get("id"), "error": str(error)}
                process.stdin.write(json.dumps(response, ensure_ascii=False) + "\n")
                process.stdin.flush()
            elif "mode" in frame and "prs" in frame:
                scan = frame
                break
            else:
                raise RuntimeError("watcher protocol frame missing scan result")
    finally:
        try:
            process.stdin.close()
        except OSError:
            pass
        process.stdout.close()
    process.wait()
    stderr_thread.join(timeout=5)
    error_text = "".join(stderr_chunks).strip()
    if len(error_text.encode("utf-8")) > 7800:
        error_text = error_text[:7600] + "\n...[stderr truncated]"
    if process.returncode:
        raise RuntimeError(error_text or f"watcher exited {process.returncode}")
    if scan is None:
        raise RuntimeError(error_text or "watcher produced no scan result")
    return scan


def main() -> None:
    if os.environ.get("CINDY_SCRIPT_PROTOCOL") != "1" and os.environ.get("XDT_MAKER_SCRIPT_PROTOCOL") != "1":
        raise SystemExit("必须在 Cindy script 调度下运行，拒绝空跑")
    client = _import_client()
    if hasattr(client, "_ensure_started"):
        client._ensure_started()
    capabilities = client.call("host.capabilities", {})
    granted = capabilities.get("granted") if isinstance(capabilities, dict) else []
    if "sessions.dispatch" not in (granted or []):
        raise SystemExit("sessions.dispatch not granted")

    watcher = watcher_path()
    if not watcher.exists():
        raise SystemExit(f"watcher script not found: {watcher}")
    node = node_path()
    home = watcher_home()
    env = os.environ.copy()
    env["MIVO_WATCHER_HOME"] = str(home)
    # Live dispatch is fail-closed: the scheduler must explicitly opt in after
    # granting sessions.dispatch. Capability discovery alone never enables it.
    live = os.environ.get("MIVO_WATCHER_LIVE") == "1"
    maintenance_path = HERE / "session-title-maintenance.py"
    pending = None
    if live and maintenance_path.exists():
        spec = importlib.util.spec_from_file_location("session_title_maintenance", maintenance_path)
        maintenance = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(maintenance)
        pending = maintenance.run_title_maintenance(home, client)
        if pending:
            env["MIVO_MAINTENANCE_SESSION"] = pending["targetSessionId"]
    env["MIVO_WATCHER_ENABLED"] = "1" if live else "0"
    env["MIVO_WATCHER_DISPATCH"] = "1" if live else "0"
    if live:
        env["MIVO_CINDY_BRIDGE"] = "1"
    scan = _run_watcher(env, watcher, node, client, live)
    summary = _summary(scan)
    if pending:
        summary["maintenance"] = pending
    client.emit_complete(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
