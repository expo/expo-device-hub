#!/usr/bin/env python3
"""Attach a bounded experiment to our own disposable emulator process."""
import argparse
import json
import pathlib
import time
import frida

p = argparse.ArgumentParser()
p.add_argument("pid", type=int)
p.add_argument("--seconds", type=float, default=35)
p.add_argument("--script", default="inject.js")
p.add_argument("--fps", type=int, default=60)
p.add_argument("--frames", type=int, default=1800)
p.add_argument("--output", default="/home/expo/gpu-frame-poc/capture.h264")
p.add_argument("--library", default="/home/expo/gpu-frame-poc/libgpu_capture.so")
a = p.parse_args()
session = frida.attach(a.pid)
config={"fps":a.fps,"frames":a.frames,"output":a.output,"library":a.library}
script = session.create_script("const POC_CONFIG="+json.dumps(config)+";\n"+pathlib.Path(a.script).read_text())
errors = []
def on_message(message, data):
    print(json.dumps(message), flush=True)
    if message.get("type") == "error":
        errors.append(message)
script.on("message", on_message)
try:
    script.load()
    time.sleep(a.seconds)
    if errors:
        raise RuntimeError("Injection failed; see the script error above")
    print(json.dumps(script.exports_sync.stop()), flush=True)
finally:
    session.detach()
