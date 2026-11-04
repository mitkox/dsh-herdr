#!/usr/bin/env python3
"""Empirical OSC 7501 (Program Status Protocol) grammar/validation probe for herdr-core 0.1.17.

Runs `hc` in an ISOLATED session (its own core, socket and XDG dirs) so it can
never touch your live herdr-core/herdr-app:

    HC_SESSION=proto1 XDG_STATE_HOME=/tmp/proto1/state XDG_CONFIG_HOME=/tmp/proto1/config \
    XDG_DATA_HOME=/tmp/proto1/data XDG_RUNTIME_DIR=/tmp/proto1/run hc server start

For each case it starts one throwaway terminal running emit_steps.py, which
writes the exact OSC bytes given to it, then waits for an on-screen marker (pty
writes are ordered, so the marker proves the core parsed the bytes), then reads
the terminal back with `hc get`. Evidence JSON goes to ../evidence/.

Every expected value below is a prediction from the Pinned parser source
(/tmp/herdr-core-src, ghostty commit 1e5cdb86) and the herdr-core status.rs
logic; this script is what proves or disproves them on the installed 0.1.17.

Usage: python3 probe_core.py [--keep]
"""
import base64
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
EVIDENCE = os.path.join(os.path.dirname(HERE), "evidence")
SESSION = os.environ.get("PROBE_SESSION", "proto1")
ROOT = f"/tmp/{SESSION}"
EMIT = os.path.join(HERE, "emit_steps.py")
ENV = dict(
    os.environ,
    HC_SESSION=SESSION,
    XDG_STATE_HOME=f"{ROOT}/state",
    XDG_CONFIG_HOME=f"{ROOT}/config",
    XDG_DATA_HOME=f"{ROOT}/data",
    XDG_RUNTIME_DIR=f"{ROOT}/run",
)
ESC, BEL, ST = b"\x1b", b"\x07", b"\x1b\\"
CASES = []


# ---------------------------------------------------------------- plumbing

def sh(args, timeout=60):
    return subprocess.run(args, capture_output=True, text=True, env=ENV, timeout=timeout)


def hc(*args, timeout=60):
    r = sh(["hc", *args], timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"hc {' '.join(args)} failed ({r.returncode}): {r.stderr.strip()}")
    return r.stdout


def hcj(*args, timeout=60):
    return json.loads(hc(*args, timeout=timeout))


def ensure_session():
    for sub in ("state", "config", "data", "run"):
        os.makedirs(f"{ROOT}/{sub}", exist_ok=True)
    os.chmod(f"{ROOT}/run", 0o700)
    status = sh(["hc", "server", "status"])
    if status.returncode != 0 or "version" not in status.stdout:
        start = sh(["hc", "server", "start"])
        if start.returncode != 0:
            raise RuntimeError(f"cannot start isolated core: {start.stderr}")
    # Clean slate: this session is ours, so every live terminal is a leftover probe.
    try:
        for term in hcj("ls").get("terminals", []):
            sh(["hc", "kill", term["address"]])
    except Exception:
        pass


def wait_screen(addr, marker, timeout=15.0):
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        last = sh(["hc", "read", "--lines", "0", addr]).stdout
        if marker in last:
            return last
        time.sleep(0.05)
    raise RuntimeError(f"marker {marker!r} never appeared on {addr}; screen was {last!r}")


def start_emitter(name, steps):
    """Start emit_steps.py with the given steps in a fresh background terminal."""
    path = f"{ROOT}/steps-{name}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(steps, f)
    out = hcj("run", "--bg", "--name", name, "python3", EMIT, path)
    return out["address"]


def steps_for(raw=None, writes=None, gap=0.15):
    maybe_terminators = None
    if raw is not None:
        return [{"b64": base64.b64encode(raw).decode(), "sleep": 0.02, "mark": "MARK"}]
    out = []
    for i, w in enumerate(writes):
        out.append({"b64": base64.b64encode(w).decode(), "sleep": gap, "mark": f"MARK{i}"})
    return out


def stop(addr):
    sh(["hc", "kill", addr])


def snap(addr):
    got = hcj("get", addr)
    return {
        "status": got.get("status"),
        "records": got.get("records", {}),
        "reported": got.get("reported", False),
        "turn": got.get("turn", 0),
        "status_ms": got.get("status_ms"),
        "state": got.get("state"),
        "_get": got,
    }


def run_case(case, index):
    name = f"c{index:03d}"[:32]
    # "raw" is a complete byte string; "body" is what goes after ESC ] 7501 ;;
    # "writes" is a list of complete byte strings (each parsed separately).
    raw = case.get("raw")
    if raw is None and "body" in case:
        raw = ESC + b"]7501;" + case["body"] + case.get("terminator", BEL)
    if raw is None and "writes" in case:
        raw = b"".join(case["writes"])
    if "steps_override" in case:
        steps = case["steps_override"]
        wait_marker = "READY"
    elif "writes" in case and len(case["writes"]) > 1:
        marks = case.get("marks", True)
        steps = [{"b64": base64.b64encode(w).decode(),
                  "mark": (f"MARK{i}" if marks else None),
                  "sleep": case.get("gap", 0.15)} for i, w in enumerate(case["writes"])]
        wait_marker = f"MARK{len(case['writes']) - 1}" if marks else "READY"
    else:
        steps = steps_for(raw=raw)
        wait_marker = "READY"
    addr = start_emitter(name, steps)
    try:
        wait_screen(addr, wait_marker)
        observed = snap(addr)
    finally:
        if not case.get("keep"):
            stop(addr)
    observed.pop("_get", None)
    failures = []
    changed = lambda v: v is not None  # noqa: E731
    exp = case.get("expect", {})
    if "status" in exp:
        if observed["status"] != exp["status"]:
            failures.append(f"status: want {exp['status']!r} got {observed['status']!r}")
    if "records" in exp:
        if observed["records"] != exp["records"]:
            failures.append(f"records: want {exp['records']!r} got {observed['records']!r}")
    if "reported" in exp and observed["reported"] != exp["reported"]:
        failures.append(f"reported: want {exp['reported']} got {observed['reported']}")
    if "turn" in exp and observed["turn"] != exp["turn"]:
        failures.append(f"turn: want {exp['turn']} got {observed['turn']}")
    if exp.get("status_ms") == "set" and observed["status_ms"] is None:
        failures.append("status_ms: want set, got null")
    if exp.get("status_ms") == "null" and observed["status_ms"] is not None:
        failures.append(f"status_ms: want null, got {observed['status_ms']}")
    if "check" in case:
        failures += case["check"](observed)
    return {
        "id": case["id"],
        "desc": case["desc"],
        "body_hex": (raw.hex() if len(raw) < 400 else f"<{len(raw)} bytes>") if raw else None,
        "body_repr": repr(raw[:300]) if raw else f"<{len(steps) if 'steps' in dir() else '?'} steps>",
        "expected": exp,
        "observed": observed,
        "pass": not failures,
        "failures": failures,
    }


# ---------------------------------------------------------------- case helpers

def c(id, desc, body=None, raw=None, writes=None, **expect):
    case = {"id": id, "desc": desc}
    if body is not None:
        case["body"] = body
    if raw is not None:
        case["raw"] = raw
    if writes is not None:
        case["writes"] = writes
    # Case-shaping keywords are not expectations.
    for key in ("terminator", "osc", "no_terminator", "keep", "marks", "gap"):
        if key in expect:
            case[key] = expect.pop(key)
    case["expect"] = expect
    CASES.append(case)


def b64text(s):
    return base64.b64encode(s if isinstance(s, bytes) else s.encode()).decode()


def b64bench(n, ch=b"A"):
    return base64.b64encode(ch * n).decode()


# ---------------------------------------------------------------- 1. states

c("state-idle", "state=idle is applied to the root record", body=b"state=idle",
  status={"state": "idle"}, reported=True, turn=0, status_ms="set")
c("state-working", "state=working is applied", body=b"state=working",
  status={"state": "working"}, reported=True, turn=0)
c("state-done", "state=done is applied", body=b"state=done",
  status={"state": "done"}, reported=True, turn=0)
c("state-blocked", "state=blocked is applied", body=b"state=blocked",
  status={"state": "blocked"}, reported=True, turn=0)
c("state-error", "state=error is applied", body=b"state=error",
  status={"state": "error"}, reported=True, turn=0)
c("state-clear-fresh", "state=clear with no records is accepted and leaves no status",
  body=b"state=clear", status=None, records={}, reported=True, turn=0)
c("state-unknown", "unknown state discards the whole report",
  body=b"state=sleeping", status=None, reported=False, turn=0)
c("state-missing", "report without state is discarded",
  body=b"app=cargo", status=None, reported=False)
c("state-uppercase", "state values are case-sensitive",
  body=b"state=IDLE", status=None, reported=False)
c("state-empty", "empty state is discarded", body=b"state=",
  status=None, reported=False)
c("state-empty-body", "an empty OSC 7501 body is discarded",
  body=b"", status=None, reported=False)
c("state-with-terminator-st", "ST (ESC \\\\) terminates a report too",
  body=b"state=idle", terminator=ST, status={"state": "idle"}, reported=True)
c("state-semicolon-payload", "a semicolon-separated payload is not the wire format",
  body=b"state=working;app=dsh", status=None, reported=False)
c("state-json-payload", "a JSON payload is not the wire format",
  body=b'{"state":"working"}', status=None, reported=False)
c("state-bare-word", "a bare state word without key= is not the wire format",
  body=b"working", status=None, reported=False)

# ---------------------------------------------------------------- 2. app

c("app-dsh", "app=dsh is stored verbatim", body=b"state=idle:app=dsh",
  status={"state": "idle", "app": "dsh"}, reported=True)
c("app-dsh-tui", "app=dsh-tui is stored verbatim (hyphen is a name byte)",
  body=b"state=idle:app=dsh-tui", status={"state": "idle", "app": "dsh-tui"})
c("app-space", "an app with a space violates the name set: skipped, report still applied",
  body=b"state=idle:app=DeepSeek Harness", status={"state": "idle"}, reported=True)
c("app-slash", "an app with / is skipped, report still applied",
  body=b"state=idle:app=a/b", status={"state": "idle"}, reported=True)
c("app-eq", "an app with = is skipped, report still applied",
  body=b"state=idle:app=a=b", status={"state": "idle"}, reported=True)
c("app-32-bytes", "app may be 32 bytes", body=b"state=idle:app=" + b"a" * 32,
  status={"state": "idle", "app": "a" * 32}, reported=True)
c("app-33-bytes", "33-byte app breaks a limit: whole report discarded",
  body=b"state=idle:app=" + b"a" * 33, status=None, reported=False)

# ---------------------------------------------------------------- 3. title/msg base64

c("title-hello", "title is base64 UTF-8, shown decoded", body=b"state=idle:title=" + b64text("Hello").encode(),
  status={"state": "idle", "title": "Hello"}, reported=True)
c("title-unicode", "decoded title may be Unicode", body=b"state=idle:title=" + b64text("安全").encode(),
  status={"state": "idle", "title": "安全"}, reported=True)
c("msg-question", "msg is base64; 'Approve?' must be encoded",
  body=b"state=blocked:msg=" + b64text("Approve?").encode(),
  status={"state": "blocked", "msg": "Approve?"}, reported=True)
c("msg-plain-hello", "plain msg=hello is not valid base64: whole report discarded",
  body=b"state=done:msg=hello", status=None, reported=False)
c("msg-plain-question", "msg=Approve? has a byte outside the value alphabet: pair skipped, no msg",
  body=b"state=blocked:msg=Approve?", status={"state": "blocked"}, reported=True)
c("title-plain-question", "title=Hello? has a byte outside the value alphabet: pair skipped, no title",
  body=b"state=idle:title=Hello?", status={"state": "idle"}, reported=True)
c("msg-space", "a space in a value skips that pair, report still applied",
  body=b"state=done:msg=a b", status={"state": "done"}, reported=True)
c("msg-paddingless", "base64 padding on msg is optional",
  body=b"state=done:msg=" + b64text("Plan").rstrip("=").encode(),
  status={"state": "done", "msg": "Plan"}, reported=True)
c("msg-control-char", "base64 text that decodes to a control character is discarded",
  body=b"state=done:msg=" + b64text(b"a\nb").encode(),
  status=None, reported=False)
c("msg-invalid-utf8", "base64 text that decodes to invalid UTF-8 is discarded",
  body=b"state=done:msg=" + b64text(b"\xff").encode(),
  status=None, reported=False)
c("title-msg-empty", "empty title/msg mean absent, report still applied",
  body=b"state=idle:title=:msg=", status={"state": "idle"}, reported=True)
c("progress-empty", "empty progress means absent, report still applied",
  body=b"state=working:progress=", status={"state": "working"}, reported=True)
c("kind-empty", "empty kind means absent, report still applied",
  body=b"state=blocked:kind=", status={"state": "blocked"}, reported=True)
c("title-192-bytes", "a 192-byte decoded title is the limit",
  body=b"state=idle:title=" + b64bench(192).encode(),
  status={"state": "idle", "title": "A" * 192}, reported=True)
c("title-193-bytes", "a 193-byte decoded title is over the limit: discarded whole",
  body=b"state=idle:title=" + b64bench(193).encode(),
  status=None, reported=False)
c("msg-2048-bytes", "a 2048-byte decoded msg is the limit",
  body=b"state=idle:msg=" + b64bench(2048).encode(),
  status={"state": "idle", "msg": "A" * 2048}, reported=True)
c("msg-2049-bytes", "a 2049-byte decoded msg is over the limit: discarded whole",
  body=b"state=idle:msg=" + b64bench(2049).encode(),
  status=None, reported=False)

# ---------------------------------------------------------------- 4. kind / progress

c("kind-blocked-permission", "kind=permission is stored with blocked",
  body=b"state=blocked:kind=permission",
  status={"state": "blocked", "kind": "permission"}, reported=True)
c("kind-blocked-question", "kind=question is stored with blocked",
  body=b"state=blocked:kind=question",
  status={"state": "blocked", "kind": "question"}, reported=True)
c("kind-blocked-auth", "kind=auth is stored with blocked",
  body=b"state=blocked:kind=auth",
  status={"state": "blocked", "kind": "auth"}, reported=True)
c("kind-on-working", "kind is ignored outside blocked",
  body=b"state=working:kind=auth", status={"state": "working"}, reported=True)
c("kind-on-done", "kind is ignored outside blocked",
  body=b"state=done:kind=auth", status={"state": "done"}, reported=True)
c("kind-unknown", "an unknown kind reads as absent, report still applied",
  body=b"state=blocked:kind=dance", status={"state": "blocked"}, reported=True)
c("progress-42", "progress is stored for working",
  body=b"state=working:progress=42",
  status={"state": "working", "progress": 42}, reported=True)
c("progress-0", "progress=0 is a value, not absent",
  body=b"state=working:progress=0",
  status={"state": "working", "progress": 0}, reported=True)
c("progress-100", "progress=100 is stored",
  body=b"state=working:progress=100",
  status={"state": "working", "progress": 100}, reported=True)
c("progress-101", "progress over 100 reads as absent, report still applied",
  body=b"state=working:progress=101", status={"state": "working"}, reported=True)
c("progress-007", "leading zeroes are decimal, not octal",
  body=b"state=working:progress=007",
  status={"state": "working", "progress": 7}, reported=True)
c("progress-negative", "negative progress reads as absent",
  body=b"state=working:progress=-1", status={"state": "working"}, reported=True)
c("progress-float", "fractional progress reads as absent",
  body=b"state=working:progress=4.5", status={"state": "working"}, reported=True)
c("progress-on-idle", "progress is ignored outside working/blocked",
  body=b"state=idle:progress=50", status={"state": "idle"}, reported=True)
c("progress-on-done", "progress is ignored outside working/blocked",
  body=b"state=done:progress=50", status={"state": "done"}, reported=True)
c("progress-on-error", "progress is ignored outside working/blocked",
  body=b"state=error:progress=50", status={"state": "error"}, reported=True)
c("progress-blocked", "progress is stored for blocked",
  body=b"state=blocked:progress=50",
  status={"state": "blocked", "progress": 50}, reported=True)

# ---------------------------------------------------------------- 5. keys/pairs

c("key-unknown-skipped", "unknown keys are ignored, report applied",
  body=b"state=idle:future=yes", status={"state": "idle"}, reported=True)
c("key-16-bytes", "a 16-byte key (known or not) is accepted",
  body=b"state=idle:" + b"a" * 16 + b"=1", status={"state": "idle"}, reported=True)
c("key-17-bytes", "a 17-byte key breaks a limit: discarded whole",
  body=b"state=idle:" + b"a" * 17 + b"=1", status=None, reported=False)
c("pair-no-equals", "a pair without = is skipped, report applied",
  body=b"junk:state=working", status={"state": "working"}, reported=True)
c("pair-empty-key", "a pair with an empty key is skipped, report applied",
  body=b"=x:state=working", status={"state": "working"}, reported=True)
c("whitespace-trimmed", "whitespace around keys and values is removed",
  body=b" state = working :\tapp = cargo \t",
  status={"state": "working", "app": "cargo"}, reported=True)
c("last-wins", "a repeated key keeps its last value",
  body=b"state=idle:app=a:state=done:app=b",
  status={"state": "done", "app": "b"}, reported=True)
c("two-reports-one-write", "two OSC 7501 reports in one write are both applied in order",
  raw=ESC + b"]7501;state=working" + BEL + ESC + b"]7501;state=done" + BEL,
  status={"state": "done"}, reported=True, turn=1)
c("report-then-text", "text after a report does not disturb it",
  raw=ESC + b"]7501;state=working" + BEL + b"hello",
  status={"state": "working"}, reported=True)

# split across two writes (parser continuation)
c("split-across-writes", "a report split across two writes is reassembled (no marker between chunks!)",
  writes=[ESC + b"]7501;state=wo", b"rking" + BEL], marks=False,
  status={"state": "working"}, reported=True)

# ---------------------------------------------------------------- 6. ids and records

c("id-child", "an id addresses a child record; the root status stays absent",
  body=b"state=working:id=build",
  status=None, records={"build": {"state": "working"}}, reported=True, turn=0, status_ms="null")
c("id-child-app", "a child record stores its own app",
  body=b"state=blocked:id=build/test:app=child",
  status=None, records={"build/test": {"state": "blocked", "app": "child"}}, reported=True)
c("id-parent-not-required", "a child id may name a parent that was never reported",
  body=b"state=working:id=deploy/us-east",
  status=None, records={"deploy/us-east": {"state": "working"}}, reported=True)
c("id-empty", "an empty id is an invalid id: discards the whole report (0.1.17)",
  body=b"state=idle:id=", status=None, reported=False)
c("id-invalid-slashes", "an invalid id (a//b) discards the report",
  body=b"state=idle:id=a//b", status=None, reported=False)
c("id-invalid-leading-slash", "an invalid id (/a) discards the report",
  body=b"state=idle:id=/a", status=None, reported=False)
c("id-invalid-trailing-slash", "an invalid id (a/) discards the report",
  body=b"state=idle:id=a/", status=None, reported=False)
c("id-invalid-char-at", "0.1.17: an id byte outside the value alphabet (@) is skipped => the report hits the ROOT record",
  body=b"state=idle:id=a@b", status={"state": "idle"}, records={}, reported=True)
c("id-invalid-char-space", "0.1.17: an id with a space is skipped => the report hits the ROOT record",
  body=b"state=done:id=a b", status={"state": "done"}, records={}, reported=True)
c("id-invalid-char-comma", "a comma is inside the value alphabet, so the id reaches validation: discarded",
  body=b"state=idle:id=a,b", status=None, reported=False)
c("id-segment-32", "a 32-byte id segment is allowed",
  body=b"state=idle:id=" + b"a" * 32,
  status=None, records={"a" * 32: {"state": "idle"}}, reported=True)
c("id-segment-33", "a 33-byte id segment is over the limit: discarded",
  body=b"state=idle:id=" + b"a" * 33, status=None, reported=False)
c("id-depth-8", "8 id levels are allowed",
  body=b"state=idle:id=" + b"/".join([b"a"] * 8),
  status=None, records={"/".join(["a"] * 8): {"state": "idle"}}, reported=True)
c("id-depth-9", "9 id levels are over the limit: discarded",
  body=b"state=idle:id=" + b"/".join([b"a"] * 9), status=None, reported=False)
c("id-total-131", "an id longer than 128 bytes is discarded",
  body=b"state=idle:id=" + b"/".join([b"a" * 32] * 4), status=None, reported=False)
c("clear-child", "state=clear:id=X removes X and its children, not similar ids",
  writes=[
      ESC + b"]7501;state=working:app=dsh" + BEL,
      ESC + b"]7501;state=working:id=build" + BEL,
      ESC + b"]7501;state=working:id=build/test" + BEL,
      ESC + b"]7501;state=working:id=buildx" + BEL,
      ESC + b"]7501;state=working:id=deploy" + BEL,
      ESC + b"]7501;state=clear:id=build" + BEL,
  ],
  status={"state": "working", "app": "dsh"},
  records={"buildx": {"state": "working"}, "deploy": {"state": "working"}},
  reported=True, turn=0)
c("clear-root-with-records", "state=clear with no id removes the root and every record",
  writes=[
      ESC + b"]7501;state=working:id=build" + BEL,
      ESC + b"]7501;state=done:id=build/test" + BEL,
      ESC + b"]7501;state=clear" + BEL,
  ],
  status=None, records={}, reported=True, turn=0)
c("clear-invalid-id-keeps-records", "an invalid clear id never falls back to the root record",
  writes=[
      ESC + b"]7501;state=working:app=dsh" + BEL,
      ESC + b"]7501;state=working:id=build" + BEL,
      ESC + b"]7501;state=clear:id=a//b" + BEL,
  ],
  status={"state": "working", "app": "dsh"},
  records={"build": {"state": "working"}}, reported=True)
c("child-does-not-end-turn", "a child record leaving working does not raise the turn",
  writes=[
      ESC + b"]7501;state=working" + BEL,
      ESC + b"]7501;state=working:id=build" + BEL,
      ESC + b"]7501;state=done:id=build" + BEL,
  ],
  status={"state": "working"}, records={"build": {"state": "done"}}, turn=0, reported=True)

# ---------------------------------------------------------------- 7. limits

c("body-4087-bytes", "a 4087-byte body (the parser's max) is accepted",
  body=b"state=idle:" + b"x" * 4076, status={"state": "idle"}, reported=True)
c("body-4088-bytes", "a 4088-byte body is rejected",
  body=b"state=idle:" + b"x" * 4077, status=None, reported=False)
c("body-4090-bytes", "a body well over the max is rejected",
  body=b"state=idle:" + b"x" * 4079, status=None, reported=False)


def records_cap_check(observed):
    """status.rs: evict `records.keys().next()` (BTreeMap-first) when len >= MAX_RECORDS-1; steady state 255."""
    recs = observed["records"]
    fails = []
    if len(recs) != 255:
        fails.append(f"want 255 records (MAX_RECORDS-1 steady state), got {len(recs)}")
    if "r999" not in recs:
        fails.append("want the newest record r999 present")
    if "r000" in recs or "r001" in recs:
        fails.append("want the two lexicographically first records r000/r001 evicted (not LRU)")
    return fails


cap_steps = [{"b64": base64.b64encode(ESC + b"]7501;state=idle:id=r%03d" % i + BEL).decode(),
              "sleep": 0.0, "mark": f"M{i}"} for i in range(256)]
cap_steps.append({"b64": base64.b64encode(ESC + b"]7501;state=idle:id=r999" + BEL).decode(),
                  "sleep": 0.0, "mark": "MR999"})
CASES.append({
    "id": "records-cap-256",
    "desc": "child-record cap: BTreeMap-first eviction when len >= MAX_RECORDS-1 (steady state 255)",
    "steps_override": cap_steps,
    "expect": {"reported": True},
    "check": records_cap_check,
})


# ---------------------------------------------------------------- 8. transitions / turn / status_ms / clear / exit

def transitions():
    """Drive fake_dsh_agent.py --auto and capture hc get after each marker."""
    addr = hcj("run", "--bg", "--name", "e2e", "python3", os.path.join(HERE, "fake_dsh_agent.py"), "--auto")["address"]
    steps, expected = [], [
        ("A-IDLE", {"state": "idle", "app": "dsh-tui", "title": "DSH · main", "msg": "waiting for a task"}, 0),
        ("B-WORKING", {"state": "working", "app": "dsh-tui", "title": "DSH · main", "msg": "running a turn"}, 0),
        ("C-BLOCKED", {"state": "blocked", "kind": "permission", "app": "dsh-tui",
                       "title": "DSH · main", "msg": "Approve? run: rm -rf build"}, 1),
        ("D-DONE", {"state": "done", "app": "dsh-tui", "title": "DSH · main", "msg": "turn finished: 3 edits"}, 1),
        ("E-IDLE", {"state": "idle", "app": "dsh-tui", "title": "DSH · main", "msg": "ready for the next task"}, 1),
    ]
    failures = []
    try:
        for marker, want_status, want_turn in expected:
            wait_screen(addr, marker)
            observed = snap(addr)
            steps.append({"marker": marker, "observed": observed})
            if observed["status"] != want_status:
                failures.append(f"{marker}: status want {want_status!r} got {observed['status']!r}")
            if observed["turn"] != want_turn:
                failures.append(f"{marker}: turn want {want_turn} got {observed['turn']}")
    finally:
        stop(addr)
    return {
        "id": "e2e-fake-dsh-agent",
        "desc": "fake dsh-tui agent end to end: idle -> working -> blocked(permission) -> done -> idle",
        "steps": steps,
        "pass": not failures,
        "failures": failures,
    }


def turn_semantics():
    """Every way of leaving working raises the turn; a repeated word or child does not."""
    ok = True
    failures = []
    checks = []
    for i, (desc, writers, want) in enumerate([
        ("working->done", [b"state=working", b"state=done"], 1),
        ("working->idle", [b"state=working", b"state=idle"], 1),
        ("working->blocked", [b"state=working", b"state=blocked"], 1),
        ("working->error", [b"state=working", b"state=error"], 1),
        ("working->clear", [b"state=working", b"state=clear"], 1),
        ("idle->done (never worked)", [b"state=idle", b"state=done"], 0),
        ("working->working", [b"state=working", b"state=working"], 0),
        ("blocked->done (never worked)", [b"state=blocked", b"state=done"], 0),
    ]):
        name = f"turn{i}"
        writes = [ESC + b"]7501;" + w + BEL for w in writers]
        addr = start_emitter(name, steps_for(writes=writes, gap=0.6))
        try:
            wait_screen(addr, f"MARK{len(writes) - 1}")
            observed = snap(addr)
        finally:
            stop(addr)
        good = observed["turn"] == want
        ok &= good
        checks.append({"case": desc, "turn_expected": want, "turn_observed": observed["turn"],
                       "status": observed["status"], "pass": good})
        if not good:
            failures.append(f"{desc}: turn want {want} got {observed['turn']}")
    return {"id": "turn-semantics", "desc": "turn raises exactly when the root record leaves working",
            "checks": checks, "pass": ok, "failures": failures}


def status_ms_semantics():
    """status_ms moves only when the root word changes."""
    writes = [
        ESC + b"]7501;state=working" + BEL,
        ESC + b"]7501;state=working:id=sub" + BEL,      # child record: must not stamp
        ESC + b"]7501;state=working" + BEL,              # same word: must not stamp
        ESC + b"]7501;state=idle" + BEL,                 # new word: must stamp
    ]
    addr = start_emitter("tsm", steps_for(writes=writes, gap=0.6))
    seen = []
    failures = []
    try:
        for i in range(len(writes)):
            wait_screen(addr, f"MARK{i}")
            got = snap(addr)
            seen.append({"step": i, "status": got["status"], "status_ms": got["status_ms"]})
        delta = [(a, b) for a, b in zip(seen, seen[1:])]
        if not (seen[0]["status_ms"] is not None and seen[1]["status_ms"] == seen[0]["status_ms"]):
            failures.append("child record or repeated word changed status_ms")
        if not (seen[2]["status_ms"] == seen[0]["status_ms"]):
            failures.append("same word again changed status_ms")
        if not (seen[3]["status_ms"] is not None and seen[3]["status_ms"] != seen[2]["status_ms"]):
            failures.append("new word did not change status_ms")
    finally:
        stop(addr)
    return {"id": "status-ms-semantics", "desc": "status_ms changes only when the root word changes",
            "steps": seen, "delta_pairs": delta, "pass": not failures, "failures": failures}


def reported_sticky_and_exit():
    """reported stays true after clear; process exit resets status but keeps reported/turn."""
    out = {}
    # reported after a report then clear
    addr = start_emitter("rep", steps_for(writes=[ESC + b"]7501;state=working" + BEL,
                                          ESC + b"]7501;state=clear" + BEL], gap=0.25))
    try:
        wait_screen(addr, "MARK1")
        out["clear_after_report"] = snap(addr)
    finally:
        stop(addr)
    # program reports working then exits; what does the terminal record say after reset?
    addr = hcj("run", "--bg", "--name", "exitp", "bash", "-c",
               'printf "\\033]7501;state=working\\007"; sleep 0.4; exit 0')["address"]
    deadline = time.monotonic() + 5
    got = None
    while time.monotonic() < deadline:
        got = hcj("get", addr)
        if got.get("state") == "finished":
            break
        time.sleep(0.1)
    out["after_exit"] = {k: got.get(k) for k in ("state", "status", "records", "reported", "turn", "status_ms", "exit_code")}
    sh(["hc", "rm", addr])
    failures = []
    if out["clear_after_report"]["status"] is not None or not out["clear_after_report"]["reported"]:
        failures.append("clear after report: want status null and reported true")
    if out["clear_after_report"]["turn"] != 1:
        failures.append("clear after report: want turn 1")
    if out["after_exit"]["status"] is not None:
        failures.append("after exit: want status null")
    return {"id": "reported-turn-reset", "desc": "reported is sticky; exit resets status but not the turn",
            "observed": out, "pass": not failures, "failures": failures}


# ---------------------------------------------------------------- main

def main():
    ensure_session()
    version = sh(["hc", "--version"]).stdout.strip()
    results = []
    t0 = time.time()
    for i, case in enumerate(CASES):
        try:
            results.append(run_case(case, i))
        except Exception as e:  # noqa: BLE001 - a probe failure is data
            import traceback
            results.append({"id": case["id"], "desc": case.get("desc", ""), "pass": False,
                            "failures": [f"probe harness error: {e}", traceback.format_exc()[-1500:]]})
        print(f"{'PASS' if results[-1]['pass'] else 'FAIL'}  {results[-1]['id']:<26} {results[-1].get('desc','')}",
              file=sys.stderr)
        for why in results[-1].get("failures", []):
            print(f"      {why}", file=sys.stderr)
    extra = []
    for fn in (transitions, turn_semantics, status_ms_semantics, reported_sticky_and_exit):
        try:
            extra.append(fn())
        except Exception as e:  # noqa: BLE001
            extra.append({"id": fn.__name__, "pass": False, "failures": [f"probe harness error: {e}"]})
        print(f"{'PASS' if extra[-1]['pass'] else 'FAIL'}  {extra[-1]['id']}", file=sys.stderr)
        for why in extra[-1].get("failures", []):
            print(f"      {why}", file=sys.stderr)
    os.makedirs(EVIDENCE, exist_ok=True)
    out = {
        "probe": "probe_core.py",
        "hc_version": version,
        "session": SESSION,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "elapsed_s": round(time.time() - t0, 1),
        "passed": sum(1 for r in results if r["pass"]) + sum(1 for r in extra if r["pass"]),
        "failed": sum(1 for r in results if not r["pass"]) + sum(1 for r in extra if not r["pass"]),
        "cases": results,
        "additional": extra,
    }
    path = os.path.join(EVIDENCE, "probe-core.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"\nwrote {path}: {out['passed']} passed, {out['failed']} failed", file=sys.stderr)
    return 0 if out["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
