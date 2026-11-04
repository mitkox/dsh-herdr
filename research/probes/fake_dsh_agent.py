#!/usr/bin/env python3
"""A fake "DSH-like" agent that speaks OSC 7501, for herdr-core/herdr-app tests.

It reports itself as app=dsh-tui (the app's built-in "DeepSeek Harness" entry)
with a base64 title/msg, exactly the way a real DSH integration would.

Modes:
  --auto     Emit a fixed script with on-screen markers so a driver can capture
             `hc get` after each step: idle -> working -> blocked -> done -> idle.
  (default)  Interactive, for hc templates: report idle first (this is what the
             template's default `ready` waits for), then read the task message
             from stdin, report working -> blocked(permission) -> working -> done
             -> idle as input arrives.

Base64 encode title/msg with: printf %s 'text' | base64
"""
import base64
import os
import select
import sys
import time

APP = "dsh-tui"


def report(fields: dict, terminator: bytes = b"\x07") -> None:
    """Write one OSC 7501 report. title/msg are base64-encoded here."""
    pairs = []
    for key, value in fields.items():
        if key in ("title", "msg"):
            value = base64.b64encode(value.encode()).decode()
        pairs.append(f"{key}={value}")
    os.write(1, b"\x1b]7501;" + ":".join(pairs).encode() + terminator)


def mark(text: str) -> None:
    os.write(1, ("\r\n" + text + "\r\n").encode())


def auto() -> None:
    # Report first, then the marker: writes to the pty are ordered, so once the
    # marker is on screen the core has already parsed and applied the report.
    report({"state": "idle", "app": APP, "title": "DSH · main", "msg": "waiting for a task"})
    mark("A-IDLE")
    time.sleep(0.5)
    report({"state": "working", "app": APP, "title": "DSH · main", "msg": "running a turn"})
    mark("B-WORKING")
    time.sleep(0.5)
    report({"state": "blocked", "kind": "permission", "app": APP,
            "title": "DSH · main", "msg": "Approve? run: rm -rf build"})
    mark("C-BLOCKED")
    time.sleep(0.5)
    report({"state": "done", "app": APP, "title": "DSH · main", "msg": "turn finished: 3 edits"})
    mark("D-DONE")
    time.sleep(0.5)
    report({"state": "idle", "app": APP, "title": "DSH · main", "msg": "ready for the next task"})
    mark("E-IDLE")
    time.sleep(900)


def read_message(timeout: float = 30.0) -> bytes:
    """Read one submitted message (up to a newline) from our pty."""
    data = b""
    deadline = time.monotonic() + timeout
    while b"\n" not in data and time.monotonic() < deadline:
        ready, _, _ = select.select([0], [], [], 0.2)
        if ready:
            chunk = os.read(0, 4096)
            if not chunk:
                break
            data += chunk
    return data


def drain() -> None:
    """Throw away whatever is already buffered on stdin (the template's first paste)."""
    while True:
        ready, _, _ = select.select([0], [], [], 0)
        if not ready:
            return
        if not os.read(0, 4096):
            return


def interactive() -> None:
    # First report: this is what a template's default `ready` waits for.
    report({"state": "idle", "app": APP, "title": "DSH · main", "msg": "ready"})
    mark("A-READY")
    task = read_message()
    mark("B-TASK:" + task.decode("utf-8", "replace").replace("\r", "").replace("\n", "\\n"))
    report({"state": "working", "app": APP, "title": "DSH · main",
            "msg": "running: " + task.decode("utf-8", "replace").strip()[:80]})
    mark("C-WORKING")
    time.sleep(0.5)
    report({"state": "blocked", "kind": "permission", "app": APP,
            "title": "DSH · main", "msg": "Approve? edit src/x.rs"})
    mark("D-BLOCKED")
    time.sleep(0.5)
    drain()
    approval = read_message()
    mark("E-APPROVAL:" + approval.decode("utf-8", "replace").replace("\r", "").replace("\n", "\\n"))
    report({"state": "working", "app": APP, "title": "DSH · main", "msg": "applying"})
    mark("F-WORKING")
    time.sleep(0.5)
    report({"state": "done", "app": APP, "title": "DSH · main", "msg": "turn finished"})
    mark("G-DONE")
    time.sleep(0.5)
    report({"state": "idle", "app": APP, "title": "DSH · main", "msg": "ready for the next task"})
    mark("H-IDLE")
    time.sleep(900)


if __name__ == "__main__":
    if "--auto" in sys.argv[1:]:
        auto()
    else:
        interactive()
