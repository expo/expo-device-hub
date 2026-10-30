#!/usr/bin/env python3
"""Host-only resident guard tests. Compiles in a private directory, never in dist."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import select
import shutil
import statistics
import struct
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--baseline-dir", type=Path, required=True, help="Read-only EAS egress-guard source")
parser.add_argument("--evidence", type=Path, required=True, help="New external directory for logs/results")
parser.add_argument("--skip-benchmark", action="store_true")
parser.add_argument("--rounds", type=int, default=21)
args = parser.parse_args()
if platform.system() != "Darwin" or args.rounds < 7:
    parser.error("macOS required; benchmark needs at least seven paired rounds")
source = Path(__file__).resolve().parent.parent
repository = source.parents[5]
args.evidence = args.evidence.resolve()
if args.evidence.is_relative_to(repository):
    parser.error("evidence must be outside the repository")
args.evidence.mkdir(parents=True, exist_ok=False)
work_scope = tempfile.TemporaryDirectory(prefix="serve-sim-egress-", dir="/tmp")
work = Path(work_scope.name)
log = (work / "tests.log").open("w", buffering=1)
results = {"label": "macOS host mechanism only", "platform": platform.platform(), "cases": []}


def run(command, env=None, expected=0):
    command = list(map(str, command))
    value = subprocess.run(command, cwd=work, env=env, text=True, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, timeout=30)
    log.write(repr(command) + "\n" + value.stdout + "\nexit=" + str(value.returncode) + "\n")
    if value.returncode != expected:
        raise RuntimeError(value.stdout or repr(command))
    return value.stdout


def fixture(path, contents=None, mode=0o600):
    if path.exists() or path.is_symlink():
        path.unlink()
    if contents is not None:
        path.write_bytes(contents)
        path.chmod(mode)


def check(name):
    results["cases"].append({"name": name, "pass": True})


try:
    results["sources"] = {str(path.relative_to(source)): hashlib.sha256(path.read_bytes()).hexdigest()
                         for path in source.rglob("*") if path.is_file() and path.suffix in (".c", ".h", ".py", ".sh")}
    results["baseline_sources"] = {name: hashlib.sha256((args.baseline_dir / name).read_bytes()).hexdigest()
                                   for name in ("guard.c", "policy.c", "policy.h")}
    flags = ["clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wconversion", "-Wshadow"]
    results["compiler"] = run(["clang", "--version"]).splitlines()[0]
    baseline = work / "baseline"
    baseline.mkdir(exist_ok=True)
    for name in ["guard.c", "policy.c", "policy.h"]:
        shutil.copyfile(args.baseline_dir / name, baseline / name)
    run(flags + ["-dynamiclib", baseline / "guard.c", baseline / "policy.c", "-o", work / "today.dylib"])
    page = work / "behavior.page"
    initial = struct.pack("=QQQ", 0x5353454755415244, 5, 1) + bytes(4096 - 24)
    fixture(page, initial)
    base = os.environ.copy()
    base.pop("DYLD_INSERT_LIBRARIES", None)
    base.pop("EAS_EGRESS_GUARD_LOG", None)
    for name, extra in [("guard", []), ("guard-test", ["-DSERVE_SIM_EGRESS_TEST_REMOTE_LOOPBACK"])]:
        run(flags + ["-dynamiclib", "-DSERVE_SIM_EGRESS_HOST_TEST"] + extra + [source / "egress-guard.c", source / "policy.c", "-o", work / (name + ".dylib")])
    run(flags + [source / "control.c", source / "policy.c", "-o", work / "control"])
    control = work / "control"
    run(flags + ["-dynamiclib", "-DSERVE_SIM_PEER_COUNTER", source / "tests/send-count.c", "-o", work / "send-count.dylib"])
    run(flags + [source / "tests/send-count.c", "-o", work / "send-count"])
    counter_page = work / "counter.page"
    run([control, "create", counter_page, "block"])
    counter_env = dict(base, DYLD_INSERT_LIBRARIES=str(work / "guard.dylib") + ":" + str(work / "send-count.dylib"),
                       SERVE_SIM_EGRESS_POLICY_FILE=str(counter_page))
    results["peer_checks_per_call"] = json.loads(run([work / "send-count"], counter_env))
    assert results["peer_checks_per_call"] == {"send": 0, "sendto": 0, "send_nocancel": 0}
    check("connected sends do not inspect existing peers")
    run(flags + [source / "check.c", "-o", work / "startup-check"])
    observed = json.loads(run([work / "startup-check", work / "guard.dylib", counter_page], counter_env))
    identity = counter_page.stat()
    assert observed == {"policy": "block", "publishedGeneration": 1,
                        "pageIdentity": f"{identity.st_dev}:{identity.st_ino}"}
    run([work / "startup-check", work / "guard.dylib", counter_page], base, expected=1)
    run([work / "startup-check", work / "guard-test.dylib", counter_page], counter_env, expected=1)
    run([work / "startup-check", work / "guard.dylib", page], counter_env, expected=1)
    check("native self-check requires initialized pinned image and exact mapped page")
    run(flags + [source / "tests/cancellation-test.c", "-o", work / "cancellation"])
    for cancellation_mode in ("cancel", "nocancel"):
        run([work / "cancellation", cancellation_mode], base)
        for policy_mode in ("block", "passthrough"):
            run([control, "set", counter_page, policy_mode])
            run([work / "cancellation", cancellation_mode], counter_env)
    check("allowed send and send$NOCANCEL retain libc pending-cancellation behavior")
    fixture(page)
    run([control, "create", page, "passthrough"])
    env = dict(base, DYLD_INSERT_LIBRARIES=str(work / "guard-test.dylib"), SERVE_SIM_EGRESS_POLICY_FILE=str(page))
    run(flags + [source / "tests/edge-test.c", "-o", work / "edges"])
    run([work / "edges", page], env)
    check("existing TCP peers remain allowed; new UDP attempts, AF_UNSPEC connectx and pointer faults remain checked")
    run(flags + [source / "tests/short-address-test.c", "-o", work / "short-addresses"])
    run([control, "set", page, "block"])
    run([work / "short-addresses", "denied"], env)
    loopback_env = dict(env, DYLD_INSERT_LIBRARIES=str(work / "guard.dylib"))
    run([work / "short-addresses", "loopback"], loopback_env)
    check("short mapped-IPv6 TCP is classified, permitted loopback works and IPv4 short shapes remain kernel-rejected")
    run(flags + [source / "tests/controller-test.c", "-o", work / "controller-peer"])
    run([control, "set", page, "passthrough"])
    peer = subprocess.Popen([str(work / "controller-peer")], cwd=work, env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        def peer_line():
            if not select.select([peer.stdout], [], [], 10)[0]:
                raise RuntimeError("Guarded peer did not answer")
            line = peer.stdout.readline().strip()
            log.write("controller peer: " + line + "\n")
            return line

        assert peer_line() == "ready"
        previous_generation = None
        for mode in ["passthrough", "block", "passthrough", "block"]:
            publication = json.loads(run([control, "set", page, mode]))
            if previous_generation is not None:
                assert publication["publishedGeneration"] == previous_generation + 1
            previous_generation = publication["publishedGeneration"]
            peer.stdin.write(mode + "\n")
            peer.stdin.flush()
            assert peer_line() == "ok " + mode
    finally:
        peer.stdin.close()
        try:
            peer.wait(timeout=5)
        except subprocess.TimeoutExpired:
            peer.kill()
            peer.wait()
        peer.stdout.close()
        log.write("controller exit=" + str(peer.returncode) + "\n")
    assert peer.returncode == 0
    check("real controller changes new TCP/UDP attempts while existing sockets continue")
    for name, contents, permissions in [("missing", None, 0o600), ("short", bytes(8), 0o600),
                                        ("magic", bytes(4096), 0o600), ("permissions", initial, 0o644)]:
        invalid = work / (name + ".page")
        fixture(invalid, contents, permissions)
        env["SERVE_SIM_EGRESS_POLICY_FILE"] = str(invalid)
        run([work / "controller-peer", "invalid"], env)
        run([control, "status", invalid], expected=1)
        check(name + " control state blocks covered remote calls; files/Unix continue")
    link = work / "linked.page"
    fixture(link)
    link.symlink_to(page)
    env["SERVE_SIM_EGRESS_POLICY_FILE"] = str(link)
    run([work / "controller-peer", "invalid"], env)
    run([control, "status", link], expected=1)
    run([control, "create", page], expected=2)
    run([control, "create", page, "block"], expected=1)
    check("symlinks, implicit warmup choice, and replacement of existing page refused")
    concurrent_page = work / "writers.page"
    fixture(concurrent_page)
    run([control, "create", concurrent_page, "block"])
    inode = concurrent_page.stat().st_ino
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        values = list(pool.map(lambda n: json.loads(run([control, "set", concurrent_page,
                              "block" if n % 2 else "passthrough"])), range(64)))
    assert sorted(x["publishedGeneration"] for x in values) == list(range(2, 66))
    assert all(x["warmupPolicy"] == "block" for x in values)
    assert concurrent_page.stat().st_ino == inode
    check("64 concurrent publications have unique generations and retain inode and explicit warmup choice")

    if not args.skip_benchmark:
        run(flags + [source / "tests/benchmark.c", "-o", work / "benchmark"])
        envs = {"none": base, "today": dict(base, DYLD_INSERT_LIBRARIES=str(work / "today.dylib"), EAS_EGRESS_GUARD_MODE="block")}
        for mode in ["passthrough", "block"]:
            policy = work / (mode + ".page")
            fixture(policy)
            run([control, "create", policy, mode])
            envs[mode] = dict(base, DYLD_INSERT_LIBRARIES=str(work / "guard.dylib"), SERVE_SIM_EGRESS_POLICY_FILE=str(policy))
        randomizer = random.Random(20261026)
        samples, summary = {}, {}
        for case, iterations in [("file_write", 100000), ("file_writev", 100000), ("null_write", 300000), ("udp_send", 40000), ("udp_sendto", 40000)]:
            values = {mode: [] for mode in envs}
            for n in range(args.rounds + 2):
                order = list(envs)
                randomizer.shuffle(order)
                for mode in order:
                    ns = float(run([work / "benchmark", case, iterations, work / "benchmark-file"], envs[mode]))
                    if n >= 2:
                        values[mode].append(ns)
            samples[case] = values
            comparisons = {}
            for variant, baseline_name in [("passthrough", "none"), ("block", "today")]:
                differences = [x - y for x, y in zip(values[variant], values[baseline_name])]
                bootstrap = sorted(statistics.median(randomizer.choices(differences, k=args.rounds)) for _ in range(10000))
                comparisons[variant + "_minus_" + baseline_name] = {
                    "paired_median_delta_ns": statistics.median(differences),
                    "bootstrap_95_ci_ns": [bootstrap[249], bootstrap[9749]],
                    "stop_gate": bootstrap[249] > 0,
                }
            summary[case] = {"median_ns": {mode: statistics.median(v) for mode, v in values.items()}, "comparisons": comparisons}
            print(case, summary[case], flush=True)
        results["benchmark_ns_per_call"] = samples
        results["benchmark_summary"] = summary
    results["status"] = "PASS_BEHAVIOR_ONLY"
except Exception as error:
    results["status"] = "FAIL"
    results["error"] = repr(error)
    raise
finally:
    try:
        log.close()
        shutil.copyfile(work / "tests.log", args.evidence / "tests.log")
        (args.evidence / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    finally:
        work_scope.cleanup()
print(json.dumps(results, indent=2))
