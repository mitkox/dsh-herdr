#!/usr/bin/env python3
"""Write raw bytes to our terminal (a pty) step by step, then hold the terminal open.

herdr-core parses OSC 7501 out of the byte stream a program writes. To probe
that parser we start this program in an isolated hc terminal, hand it a JSON
file of steps, and it writes each step's bytes verbatim, then prints an
on-screen marker (so the driver can tell the write has reached the core),
then sleeps, then prints READY, then holds the terminal open.

Usage: emit_steps.py steps.json

steps.json: list of objects:
  {"b64": "<base64 of the exact bytes to write>", "sleep": <seconds after the write>,
   "mark": "<text printed after the write+sleep>"}

The driver polls `hc read --lines 0 <terminal>` for the marker to synchronise,
because writes to a pty are ordered: once the marker is on the screen, the
preceding bytes were parsed and applied (or rejected) by the core.

Stdlib only. This is a research probe, not production code.
"""
import base64
import json
import os
import sys
import time


def main() -> int:
    steps = json.load(open(sys.argv[1], encoding="utf-8"))
    for step in steps:
        if step.get("b64"):
            os.write(1, base64.b64decode(step["b64"]))
        mark = step.get("mark")
        if mark:
            os.write(1, ("\r\n" + mark + "\r\n").encode())
        # The sleep comes AFTER the marker so a driver that sees it can read the
        # status before the next write lands (marker order proves the write landed).
        time.sleep(float(step.get("sleep", 0.15)))
    os.write(1, b"\r\nREADY\r\n")
    time.sleep(900)
    return 0


if __name__ == "__main__":
    sys.exit(main())
