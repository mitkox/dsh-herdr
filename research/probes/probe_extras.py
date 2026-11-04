#!/usr/bin/env python3
"""Extra empirical probes for herdr-core: hc events, hc wait, the OSC 7501
feature-detection query, process-exit reset, and hc templates.

Runs against the same ISOLATED session as probe_core.py (HC_SESSION=proto1 +
scratch XDG dirs). Evidence JSON: ../evidence/probe-extras.json.

Usage: python3 probe_extras.py
"""
import json
import os
import select
import subprocess
import sys
import time

import probe_core as pc

HERE = os.path.dirname(os.path.abspath(__file__))
EVIDENCE = os.path.join(os.path.dirname(HERE), "evidence")
TEMPLATES = f"{pc.ROOT}/config/herdr-core/templates"
FAKE = os.path.join(HERE, "fake_dsh_agent.py")


def capture_events(addr, seconds=3.0):
    """Run `hc events --terminal ADDR` and collect its JSON lines."""
    proc = subprocess.Popen(["hc", "events", "--terminal", addr], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=pc.ENV)
    deadline = time.monotonic() + seconds
    lines = []
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([proc.stdout], [], [], 0.1)
            if ready:
                line = proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if line:
                    lines.append(json.loads(line))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
    return lines


def probe_events():
    """Start the fake agent and subscribe: observe the snapshot + status/turn events."""
    addr = pc.hcj("run", "--bg", "--name", "ev", "python3", FAKE, "--auto")["address"]
    try:
        pc.wait_screen(addr, "A-IDLE")
        events = capture_events(addr, seconds=3.5)
    finally:
        pc.stop(addr)
    # The subscription starts with a plain snapshot line, then JSON-RPC
    # envelopes: {"jsonrpc":"2.0","method":"event","params":{...}}.
    def unwrap(e):
        if e.get("method") == "event" and isinstance(e.get("params"), dict):
            return e["params"]
        return e

    events = [unwrap(e) for e in events]
    snapshot = next((e for e in events if "terminals" in e), None)
    facts = [e for e in events if "type" in e]
    kinds = sorted({e["type"] for e in facts})
    status_events = [e for e in facts if e["type"] == "status"][:3]
    turn_events = [e for e in facts if e["type"] == "turn"][:3]
    failures = []
    if snapshot is None:
        failures.append("no snapshot line with terminals")
    if "status" not in kinds:
        failures.append(f"no status events; saw {kinds}")
    if "turn" not in kinds:
        failures.append(f"no turn events; saw {kinds}")
    return {"id": "hc-events", "desc": "hc events: snapshot line, then status/turn fact lines",
            "snapshot_sample": snapshot, "event_types": kinds,
            "status_events": status_events, "turn_events": turn_events,
            "all_events_sample": facts[:8], "pass": not failures, "failures": failures}


def probe_wait():
    """A terminal reports working, then idle 1.2s later; `hc wait` must block then return."""
    writes = [pc.ESC + b"]7501;state=working:app=dsh-tui" + pc.BEL,
              pc.ESC + b"]7501;state=idle:app=dsh-tui" + pc.BEL]
    addr = pc.start_emitter("wt2", [{"b64": pc.base64.b64encode(writes[0]).decode(), "mark": "W", "sleep": 1.2},
                                    {"b64": pc.base64.b64encode(writes[1]).decode(), "mark": "I", "sleep": 900}])
    started = time.monotonic()
    try:
        pc.wait_screen(addr, "W")
        proc = subprocess.run(["hc", "wait", "--json", addr], capture_output=True, text=True,
                              env=pc.ENV, timeout=30)
        elapsed = time.monotonic() - started
        got = pc.snap(addr)
    finally:
        pc.stop(addr)
    failures = []
    try:
        result = json.loads(proc.stdout)
    except Exception:  # noqa: BLE001
        result = None
        failures.append(f"hc wait stdout is not JSON: {proc.stdout!r} {proc.stderr!r}")
    if proc.returncode != 0:
        failures.append(f"hc wait exit code {proc.returncode}")
    if elapsed < 0.9:
        failures.append(f"hc wait returned too fast ({elapsed:.2f}s) for a 1.2s turn")
    if got["status"] != {"state": "idle", "app": "dsh-tui"}:
        failures.append(f"terminal should be idle after the wait: {got['status']!r}")
    return {"id": "hc-wait", "desc": "hc wait blocks until the root record stops working",
            "wait_command": f"hc wait --json {addr}", "stdout": proc.stdout.strip(),
            "result": result, "elapsed_s": round(elapsed, 2),
            "terminal_after": got["status"], "turn_after": got["turn"],
            "pass": not failures, "failures": failures}


def probe_query():
    """Does the installed core answer the OSC 7501 `?` feature-detection query?"""
    code = (
        "import os,select,time,tty;"
        "tty.setraw(0);"  # a real TUI agent is in raw mode; canonical mode would buffer the reply
        "os.write(1,b'\\x1b]7501;?\\x07');"
        "r,_,_=select.select([0],[],[],2.0);"
        "d=os.read(0,512) if r else b'';"
        "os.write(1,b'\\r\\nQUERY-REPLY:'+d.hex().encode()+b'\\r\\n');"
        "time.sleep(300)"
    )
    addr = pc.hcj("run", "--bg", "--name", "q", "python3", "-c", code)["address"]
    try:
        deadline = time.monotonic() + 8
        screen = ""
        while time.monotonic() < deadline:
            screen = pc.sh(["hc", "read", "--lines", "0", addr]).stdout
            if "QUERY-REPLY:" in screen:
                break
            time.sleep(0.1)
        line = next((l for l in screen.splitlines() if "QUERY-REPLY:" in l), "")
        hexpart = line.split("QUERY-REPLY:", 1)[1].strip()
        reply = bytes.fromhex(hexpart) if hexpart else b""
    finally:
        pc.stop(addr)
    expected = (b"\x1b]7501;?:states=idle,working,done,blocked,error:"
                b"kinds=permission,question,auth\x07")
    failures = []
    if not reply:
        failures.append("no reply to OSC 7501 `?` (query unsupported or removed)")
    return {"id": "query", "desc": "OSC 7501 `?` feature-detection reply",
            "query_hex": (pc.ESC + b"]7501;?" + pc.BEL).hex(),
            "reply_hex": reply.hex(), "reply_ascii": reply.decode("ascii", "replace"),
            "expected_hex": expected.hex(), "matches_expected": reply == expected,
            "pass": not failures, "failures": failures}


def probe_templates():
    """Template readiness waits for the first OSC 7501 report; a headless one-shot exits first."""
    os.makedirs(TEMPLATES, exist_ok=True)
    out = {"templates_dir": TEMPLATES}
    # 1) Interactive fake agent: default readiness (wait for first status report).
    with open(os.path.join(TEMPLATES, "fake-dsh.md"), "w", encoding="utf-8") as f:
        f.write("---\n"
                "description: Fake DSH agent for OSC 7501 readiness probes\n"
                f"command: python3 {FAKE}\n"
                "---\n"
                "You are a fake DSH agent used only by a research probe.\n")
    out["templates_listing"] = pc.hc("templates")
    result = json.loads(pc.hc("run", "--bg", "--name", "tpl", "--json", "fake-dsh", "add a README"))
    out["interactive_run"] = result
    addr = result["address"]
    try:
        deadline = time.monotonic() + 15
        screen = ""
        while time.monotonic() < deadline:
            screen = pc.sh(["hc", "read", "--lines", "0", addr]).stdout
            if "B-TASK:" in screen:
                break
            time.sleep(0.1)
        pc.wait_screen(addr, "C-WORKING", timeout=15)
        got_working = pc.snap(addr)
        pc.wait_screen(addr, "D-BLOCKED", timeout=15)
        got_blocked = pc.snap(addr)
        out["interactive_screen"] = screen
        out["interactive_status_working"] = got_working
        out["interactive_status_blocked"] = got_blocked
        # Approve: any text acts as the approval in the fake agent.
        pc.hc("send", "--force", addr, "yes")
        pc.wait_screen(addr, "F-WORKING", timeout=15)
        out["interactive_status_after_approval"] = pc.snap(addr)
        pc.wait_screen(addr, "H-IDLE", timeout=15)
        out["interactive_status_final"] = pc.snap(addr)
        first = result.get("first_message")
        out["interactive_first_message"] = first
    finally:
        pc.stop(addr)

    # 2) Headless one-shot: reports done and exits immediately; readiness is satisfied
    #    by the report but there is nobody left to receive the task.
    with open(os.path.join(TEMPLATES, "oneshot.md"), "w", encoding="utf-8") as f:
        f.write("---\n"
                "description: One-shot program that reports done and exits\n"
                'command: python3 -c "import os; os.write(1, b\'\\x1b]7501;state=done:app=dsh-tui\\x07\'); "\n'
                "---\n"
                "Instructions the one-shot can never receive.\n")
    oneshot = json.loads(pc.hc("run", "--bg", "--name", "oneshot", "--json", "oneshot", "task"))
    out["oneshot_run"] = oneshot
    addr = oneshot["address"]
    time.sleep(1.0)
    out["oneshot_get"] = {k: pc.hcj("get", addr).get(k) for k in ("state", "status", "reported", "turn", "first_message")}
    pc.sh(["hc", "rm", addr])

    failures = []
    first = out["interactive_first_message"]
    if not (isinstance(first, dict) and first.get("sent") is True):
        failures.append(f"interactive template first_message not sent: {first!r}")
    if out["interactive_status_working"]["status"].get("state") != "working":
        failures.append(f"interactive template agent not working: {out['interactive_status_working']['status']!r}")
    blocked = out["interactive_status_blocked"]["status"] or {}
    if blocked.get("kind") != "permission":
        failures.append(f"interactive template agent not blocked/permission: {out['interactive_status_blocked']['status']!r}")
    final = out.get("interactive_status_final", {}).get("status") or {}
    if final.get("state") != "idle":
        failures.append(f"interactive template agent should end idle: {final!r}")
    one = out["oneshot_run"].get("first_message") or {}
    if one.get("sent") is not False:
        failures.append(f"headless one-shot first_message should be unsent, got {one!r}")
    return {"id": "templates", "desc": "template readiness: waits for first OSC 7501; one-shot cannot receive the task",
            "observed": out, "pass": not failures, "failures": failures}


def main():
    pc.ensure_session()
    out = {"probe": "probe_extras.py", "hc_version": pc.sh(["hc", "--version"]).stdout.strip(),
           "session": pc.SESSION, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "results": []}
    for fn in (probe_events, probe_wait, probe_query, probe_templates):
        try:
            res = fn()
        except Exception as e:  # noqa: BLE001
            import traceback
            res = {"id": fn.__name__, "pass": False,
                   "failures": [f"probe harness error: {e}", traceback.format_exc()[-1500:]]}
        out["results"].append(res)
        print(f"{'PASS' if res['pass'] else 'FAIL'}  {res['id']}", file=sys.stderr)
        for why in res.get("failures", []):
            print(f"      {why}", file=sys.stderr)
    os.makedirs(EVIDENCE, exist_ok=True)
    path = os.path.join(EVIDENCE, "probe-extras.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    passed = sum(1 for r in out["results"] if r["pass"])
    print(f"\nwrote {path}: {passed} passed, {len(out['results']) - passed} failed", file=sys.stderr)
    return 0 if passed == len(out["results"]) else 1


if __name__ == "__main__":
    sys.exit(main())
