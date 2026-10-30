#!/usr/bin/env python3
"""Dedicated-Simulator mechanism check. Never uses an existing device or shared dist."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import sys
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--runtime', required=True)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parent.parent
repository = source.parents[5]
evidence = args.evidence.resolve()
if evidence.is_relative_to(repository):
    parser.error('Evidence must be outside git')
evidence.mkdir(parents=True, exist_ok=False)
source_head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repository, text=True).strip()
work = Path(tempfile.mkdtemp(prefix='serve-sim-egress-native-', dir='/tmp'))
env = {key: value for key, value in os.environ.items()
       if not key.startswith('SIMCTL_CHILD_') and key not in
       ('DYLD_INSERT_LIBRARIES', 'SERVE_SIM_EGRESS_POLICY_FILE', 'SERVE_SIM_CAPABILITIES_CONFIG')}
device = None
creation_attempted = False
client = None
stderr = None
results = {'sourceHead': source_head,
           'work': str(work), 'runtime': args.runtime, 'scope': 'Simulator mechanism only', 'commands': []}

def run(command, timeout=120, extra=None, allow_already_shutdown=False):
    child = subprocess.Popen(command, env=env | (extra or {}), stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, error_output = child.communicate(timeout=timeout)
    except BaseException:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        stdout, error_output = child.communicate(timeout=10)
        results['commands'].append({'command': list(map(str, command)), 'exit': child.returncode,
                                    'stdout': stdout, 'stderr': error_output, 'interrupted': True})
        raise
    results['commands'].append({'command': list(map(str, command)), 'exit': child.returncode,
                                'stdout': stdout, 'stderr': error_output})
    already_shutdown = allow_already_shutdown and 'Unable to shutdown device in current state: Shutdown' in error_output
    if child.returncode and not already_shutdown:
        raise RuntimeError(f'{command[0]} failed: {error_output[-3000:]}')
    return stdout.strip()


def canceled(_signal, _frame):
    raise KeyboardInterrupt('Native check canceled')


for cancel_signal in (signal.SIGTERM, signal.SIGHUP):
    signal.signal(cancel_signal, canceled)

def milestone():
    if not select.select([client.stdout], [], [], 30)[0]:
        raise RuntimeError('Simulator fixture timed out')
    line = client.stdout.readline()
    if not line:
        raise RuntimeError('Simulator fixture exited before its milestone')
    value = json.loads(line)
    results.setdefault('milestones', []).append(value)
    print(json.dumps(value), flush=True)
    return value

try:
    for name in ('ServeSimEgressGuard', 'ServeSimCapabilityLoader'):
        shutil.copytree(source.parent / name, work / name)
    output = work / 'out'
    run(['bash', str(work / 'ServeSimCapabilityLoader/build.sh'), str(output)])
    run(['bash', str(work / 'ServeSimEgressGuard/build.sh'), str(output)])
    sdk = run(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'])
    fixture = output / 'simulator-check'
    run(['xcrun', '--sdk', 'iphonesimulator', 'clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
         '-Wconversion', '-Wshadow', '-arch', 'arm64', '-mios-simulator-version-min=15.0', '-isysroot', sdk,
         str(work / 'ServeSimEgressGuard/tests/simulator-test.c'), '-o', str(fixture)])
    results['xcode'] = run(['xcodebuild', '-version'])
    results['sdk'] = sdk
    results['host'] = run(['sw_vers'])
    results['artifacts'] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                            for path in output.iterdir() if path.is_file()}
    results['sources'] = {str(path.relative_to(work)): hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in work.rglob('*') if path.is_file() and output not in path.parents}
    page = work / 'policy'
    control = output / 'serve-sim-egress-control'
    loader = output / 'libServeSimCapabilityLoader.dylib'
    guard = output / 'libServeSimEgressGuard.dylib'
    config = work / 'capabilities.conf'
    config.write_text(f'startup\tprocess\t{guard}\tSERVE_SIM_EGRESS_POLICY_FILE={page}\t0\n')
    run([str(control), 'create', str(page), 'passthrough'])
    creation_attempted = True
    results['creationName'] = 'gwdp-resident-egress-native-' + work.name[-6:]
    device = run(['xcrun', 'simctl', 'create', results['creationName'],
                  'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', args.runtime])
    results['device'] = device
    (evidence / 'ownership.json').write_text(json.dumps({'device': device, 'work': str(work)}, indent=2))
    run(['xcrun', 'simctl', 'boot', device], extra={
        'SIMCTL_CHILD_DYLD_INSERT_LIBRARIES': f'{loader}:{guard}',
        'SIMCTL_CHILD_SERVE_SIM_CAPABILITIES_CONFIG': str(config)})
    run(['xcrun', 'simctl', 'bootstatus', device], timeout=180)
    results['bootIdentity'] = json.loads(run([str(output / 'serve-sim-egress-boot-identity'), device]))
    if not results['bootIdentity']:
        raise RuntimeError('Booted device has no native identity')
    print(json.dumps({'readyForDevicePanel': device, 'work': str(work)}), flush=True)
    if not select.select([sys.stdin], [], [], 60)[0]:
        raise RuntimeError('Device-panel checkpoint timed out')
    if input().strip() != 'continue':
        raise RuntimeError('Device-panel checkpoint canceled')
    # Diagnostic census only: process births/exits can race this snapshot. Never
    # turn mapped images into an all-process policy-observation or drain ACK.
    def process_table():
        table = {}
        for line in run(['ps', '-axo', 'uid=,pid=,ppid=,comm=']).splitlines():
            parts = line.split(None, 3)
            if len(parts) == 4 and int(parts[0]) == os.getuid():
                table[int(parts[1])] = (int(parts[2]), parts[3])
        return table

    boot = results['bootIdentity']
    table = process_table()
    targets = {boot['pid']}
    while True:
        expanded = targets | {pid for pid, entry in table.items() if entry[0] in targets}
        if expanded == targets:
            break
        targets = expanded
    census = []
    for pid in sorted(targets):
        record = {'pid': pid, 'snapshot': table.get(pid)}
        try:
            if pid not in table or process_table().get(pid) != table[pid]:
                raise RuntimeError('Process changed before mapping readback')
            mapping = run(['/usr/bin/vmmap', '-w', str(pid)], timeout=15)
            (evidence / f'vmmap-{pid}.log').write_text(mapping)
            record['guardMapped'] = str(guard) in mapping
            record['loaderMapped'] = str(loader) in mapping
            record['pageMapped'] = str(page) in mapping
            record['sameProcessAfter'] = process_table().get(pid) == table[pid]
        except Exception as error:
            record['error'] = repr(error)
        census.append(record)
    results['mappingCensus'] = census
    results['mappingCensusScope'] = 'same-UID descendants snapshot; no policy observation or drain acknowledgement'
    if json.loads(run([str(output / 'serve-sim-egress-boot-identity'), device])) != boot:
        raise RuntimeError('Simulator boot changed during census')
    print(json.dumps({'censusProcesses': len(census), 'unverifiedMappings': sum(
        not all(record.get(key) for key in ('guardMapped', 'loaderMapped', 'pageMapped', 'sameProcessAfter'))
        for record in census)}), flush=True)
    stderr = (evidence / 'fixture.stderr').open('w')
    client = subprocess.Popen(['xcrun', 'simctl', 'spawn', device, str(fixture), str(loader), str(guard), str(page)],
                              env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)
    assert milestone()['phase'] == 'passthrough'
    results['blockPublication'] = json.loads(run([str(control), 'set', str(page), 'block']))
    client.stdin.write('b'); client.stdin.flush()
    assert milestone()['phase'] == 'block'
    results['passPublication'] = json.loads(run([str(control), 'set', str(page), 'passthrough']))
    client.stdin.write('p'); client.stdin.flush()
    assert milestone()['phase'] == 'passthrough-again'
    if client.wait(timeout=10):
        raise RuntimeError('Simulator fixture failed')
    results['status'] = 'PASS_MECHANISM_ONLY'
except BaseException as error:
    results['status'] = 'FAILED'
    results['error'] = repr(error)
    print(repr(error), flush=True)
finally:
    if client and client.poll() is None:
        try:
            client.kill()
            client.wait(timeout=10)
        except BaseException as error:
            # Device shutdown must still run if the host wrapper cannot be reaped.
            results['clientCleanupError'] = repr(error)
            results['status'] = 'FAILED_CLEANUP'
    if stderr:
        stderr.close()
    safe = device is None and not creation_attempted
    if device is None and creation_attempted:
        results['cleanupError'] = 'Device creation status uncertain; retain private outputs for inspection'
        results['status'] = 'FAILED_CLEANUP'
    if device:
        try:
            run(['xcrun', 'simctl', 'shutdown', device], timeout=60, allow_already_shutdown=True)
            identity = json.loads(run([str(output / 'serve-sim-egress-boot-identity'), device]))
            if identity is not None:
                raise RuntimeError('Shutdown left a boot identity; assets retained')
            run(['xcrun', 'simctl', 'delete', device])
            safe = True
        except BaseException as error:
            results['cleanupError'] = repr(error)
            results['status'] = 'FAILED_CLEANUP'
    results['privateOutputsRemoved'] = False
    # Persist the command evidence before attempting filesystem cleanup, including
    # when deletion is interrupted. Update it afterward with the actual outcome.
    (evidence / 'results.json').write_text(json.dumps(results, indent=2))
    if safe:
        try:
            shutil.rmtree(work)
            results['privateOutputsRemoved'] = True
        except BaseException as error:
            results['cleanupError'] = repr(error)
            results['status'] = 'FAILED_CLEANUP'
    (evidence / 'results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps({'status': results.get('status'), 'privateOutputsRemoved': results['privateOutputsRemoved'], 'evidence': str(evidence)}), flush=True)
raise SystemExit(0 if results.get('status') == 'PASS_MECHANISM_ONLY' else 1)
