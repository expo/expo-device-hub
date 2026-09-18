#!/usr/bin/env python3
"""Disposable standalone gfxstream + real cross-process Frida injection demo."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parents[1]
WORK = Path(os.environ.get("DEMO_WORK_DIR", PACKAGE / "artifacts/gfxstream-hook")).resolve()


def run(args, **kwargs):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), check=True, **kwargs)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def stop(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def demonstrate(build, inputs):
    evidence = WORK / "evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    result_path = evidence / "result.json"
    result_path.unlink(missing_ok=True)
    env = dict(os.environ, LIBGL_ALWAYS_SOFTWARE="1", GALLIUM_DRIVER="llvmpipe")
    host = injector = display = None
    try:
        with (evidence / "xvfb.log").open("w") as display_log:
            display = subprocess.Popen(
                ["Xvfb", "-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp"],
                stdout=subprocess.PIPE, stderr=display_log, text=True,
            )
            if not select.select([display.stdout], [], [], 15)[0]:
                raise RuntimeError("Xvfb did not report a display; see evidence/xvfb.log")
            number = display.stdout.readline().strip()
            if not number.isdecimal():
                raise RuntimeError("Xvfb startup failed; see evidence/xvfb.log")
            env["DISPLAY"] = ":" + number
            host_path = build / "bin/gfxstream-demo-host"
            hook_path = build / "bin/libgfxstream-demo-hook.so"
            inject_path = build / "bin/gfxstream-demo-inject"
            host_log_path = evidence / "host.log"
            with host_log_path.open("w") as host_log:
                host = subprocess.Popen([str(host_path), "--seconds", "15"],
                                        stdout=host_log, stderr=subprocess.STDOUT, env=env)
                deadline = time.monotonic() + 40
                while "HOST_READY" not in host_log_path.read_text():
                    if host.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("gfxstream host did not become ready:\n" + host_log_path.read_text())
                    time.sleep(0.1)
                print(host_log_path.read_text(), flush=True)
                maps_path = Path(f"/proc/{host.pid}/maps")
                before = maps_path.read_text()
                if str(hook_path) in before:
                    raise RuntimeError("Demo agent was already loaded before injection")
                (evidence / "maps-before-injection.txt").write_text(before)
                injection_log_path = evidence / "injection.log"
                with injection_log_path.open("w") as injection_log:
                    command = [str(inject_path), str(host.pid), "--seconds", "6",
                               "--count-posts", "--library", str(hook_path)]
                    print("+", " ".join(command), flush=True)
                    injector = subprocess.Popen(command, stdout=injection_log,
                                                stderr=subprocess.STDOUT, env=env)
                    deadline = time.monotonic() + 40
                    during = None
                    while injector.poll() is None:
                        if during is None and "READY gfxstream-hook" in injection_log_path.read_text():
                            during = maps_path.read_text()
                            (evidence / "maps-during-hook.txt").write_text(during)
                        if time.monotonic() > deadline:
                            raise RuntimeError("Injection timed out")
                        time.sleep(0.1)
                injection_log = injection_log_path.read_text()
                print(injection_log, flush=True)
                if injector.returncode:
                    raise RuntimeError("Injector failed; see evidence/injection.log")
                if during is None:
                    raise RuntimeError("Did not observe the live hook")
                if str(hook_path) not in during:
                    raise RuntimeError("Demo agent is absent from the target's live mappings")
                completed = [json.loads(line[5:]) for line in injection_log.splitlines()
                             if line.startswith("DONE ")]
                if not completed or completed[-1]["count"] <= 0:
                    raise RuntimeError("No actual gfxstream postImpl calls were observed")
                backend_path = Path(completed[-1]["module"])
                if not backend_path.resolve().is_relative_to(build.resolve()):
                    raise RuntimeError("Hooked a renderer outside this standalone build")
                mapped_files = sorted({line.split(maxsplit=5)[5].strip()
                                       for line in during.splitlines()
                                       if len(line.split(maxsplit=5)) == 6 and line.split(maxsplit=5)[5].startswith("/")})
                forbidden = [path for path in mapped_files
                             if any(token in Path(path).name.lower() for token in
                                    ("qemu", "android-emu", "libavcodec", "libavutil", "libavformat", "libx264"))]
                if forbidden:
                    raise RuntimeError("Unexpected emulator/FFmpeg mappings: " + repr(forbidden))
                host.wait(timeout=20)
                if host.returncode:
                    raise RuntimeError("Host did not exit cleanly:\n" + host_log_path.read_text())
                outputs = {name: {"path": str(path), "sha256": sha256(path)}
                           for name, path in (("host", host_path), ("hook", hook_path),
                                              ("injector", inject_path), ("gfxstream", backend_path))}
                for name, item in outputs.items():
                    text = subprocess.check_output(["readelf", "-d", item["path"]], text=True)
                    (evidence / f"{name}-dynamic.txt").write_text(text)
                result = {"passed": True, "architecture": platform.machine(),
                          "hook": completed[-1], "inputs": inputs, "outputs": outputs,
                          "agentAbsentBeforeInjection": True, "agentMappedDuringHook": True,
                          "mappedFiles": mapped_files, "unexpectedMappings": forbidden,
                          "claim": "Real Frida injection hooks standalone gfxstream without QEMU or Android Emulator.",
                          "limitation": "This does not decide the licensing scope of a different emulator integration."}
                result_path.write_text(json.dumps(result, indent=2) + "\n")
                print(f"PASS: observed {completed[-1]['count']} real postImpl calls. Evidence: {result_path}", flush=True)
    finally:
        stop(injector)
        stop(host)
        stop(display)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=["all", "build", "run"], default="all")
    args = parser.parse_args()
    if platform.system() != "Linux":
        parser.error("Run on Linux or use ./run-demo.sh --docker")
    WORK.mkdir(parents=True, exist_ok=True)
    build = WORK / ("build-" + platform.machine())
    if args.phase != "run":
        run([sys.executable, HERE / "fetch-inputs.py"])
    inputs = json.loads((WORK / "inputs.json").read_text())
    if args.phase != "run":
        gfxstream_build = build / "gfxstream"
        run(["cmake", "-S", inputs["gfxstreamSourceDir"], "-B", gfxstream_build, "-G", "Ninja",
             "-DBUILD_STANDALONE=ON", "-DCONFIG_AEMU=OFF", "-DDEPENDENCY_RESOLUTION=SYSTEM",
             "-DENABLE_VKCEREAL_TESTS=OFF", "-DWITH_BENCHMARK=OFF", "-DCMAKE_BUILD_TYPE=Release",
             "-DCMAKE_CXX_FLAGS_RELEASE=-O1 -g0 -DNDEBUG", "-DCMAKE_C_FLAGS_RELEASE=-O1 -g0 -DNDEBUG"])
        run(["cmake", "--build", gfxstream_build, "--parallel", os.environ.get("DEMO_JOBS", "2"),
             "--target", "gfxstream_backend"])
        run(["cmake", "-S", HERE, "-B", build, "-G", "Ninja",
             "-DGFXSTREAM_SOURCE_DIR=" + inputs["gfxstreamSourceDir"],
             "-DGFXSTREAM_BUILD_DIR=" + str(gfxstream_build),
             "-DFRIDA_CORE_DEVKIT_DIR=" + inputs["fridaCoreDevkitDir"],
             "-DFRIDA_GUM_DEVKIT_DIR=" + inputs["fridaGumDevkitDir"]])
        run(["cmake", "--build", build, "--parallel", os.environ.get("DEMO_JOBS", "2"),
             "--target", "gfxstream-demo-host", "gfxstream-demo-hook", "gfxstream-demo-inject"])
    if args.phase != "build":
        demonstrate(build, inputs)


if __name__ == "__main__":
    main()
