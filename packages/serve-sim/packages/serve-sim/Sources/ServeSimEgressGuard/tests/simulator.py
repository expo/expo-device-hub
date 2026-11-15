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
import socket
import threading
import time

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

class HostListeners:
    """Host-side TCP and UDP peers on this machine's own address. Host processes are outside the guard."""

    def __init__(self, address):
        self.events = []
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.tcp.bind((address, 0))
        self.tcp.listen(16)
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind((address, 0))
        self.tcp_port = self.tcp.getsockname()[1]
        self.udp_port = self.udp.getsockname()[1]
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def record(self, kind, data):
        with self.lock:
            self.events.append({'at': time.monotonic(), 'kind': kind, 'first': data[:120].decode('latin-1')})

    def serve(self):
        while not self.stopping.is_set():
            ready = select.select([self.tcp, self.udp], [], [], 0.2)[0]
            for item in ready:
                if item is self.udp:
                    data, _ = self.udp.recvfrom(2048)
                    self.record('udp', data)
                    continue
                connection, _ = self.tcp.accept()
                connection.settimeout(2)
                try:
                    data = connection.recv(2048)
                except OSError:
                    data = b''
                self.record('tcp', data)
                try:
                    connection.sendall(b'HTTP/1.0 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok')
                except OSError:
                    pass
                connection.close()

    def since(self, start):
        with self.lock:
            return [event for event in self.events if event['at'] >= start]

    def close(self):
        self.stopping.set()
        self.thread.join(timeout=5)
        self.tcp.close()
        self.udp.close()


def app_path_contacts(events, tag):
    """Attribute contacts by the tag each probe sends."""
    def first(event):
        return event['first']
    return {
        'urlSession': sum(1 for e in events if e['kind'] == 'tcp' and f'/{tag}-urlsession' in first(e)),
        'nwTcp': sum(1 for e in events if e['kind'] == 'tcp' and f'/{tag}-nwtcp' in first(e)),
        'nwUdp': sum(1 for e in events if e['kind'] == 'udp' and first(e) == f'{tag}-nwudp'),
        'safari': sum(1 for e in events if e['kind'] == 'tcp' and f'/{tag}-safari' in first(e)),
    }


listeners = None

try:
    for name in ('ServeSimEgressGuard', 'ServeSimCapabilityLoader'):
        shutil.copytree(source.parent / name, work / name)
    output = work / 'out'
    run(['bash', str(work / 'ServeSimCapabilityLoader/build.sh'), str(output)])
    loader = output / 'libServeSimCapabilityLoader.dylib'
    if '_serve_sim_startup_all_processes' not in run(['nm', '-gU', str(loader)]).split():
        raise RuntimeError('Simulator harness requires the all-process capability loader; no Simulator was created')
    run(['bash', str(work / 'ServeSimEgressGuard/build.sh'), str(output)])
    sdk = run(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'])
    fixture = output / 'simulator-check'
    run(['xcrun', '--sdk', 'iphonesimulator', 'clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
         '-Wconversion', '-Wshadow', '-arch', 'arm64', '-mios-simulator-version-min=15.0', '-isysroot', sdk,
         str(work / 'ServeSimEgressGuard/tests/simulator-test.c'), '-o', str(fixture)])
    app_paths = output / 'app-paths'
    run(['xcrun', '--sdk', 'iphonesimulator', 'clang', '-fobjc-arc', '-O2', '-Wall', '-Wextra', '-Werror',
         '-Wshadow', '-arch', 'arm64', '-mios-simulator-version-min=15.0', '-isysroot', sdk,
         '-framework', 'Foundation', '-framework', 'Network',
         str(work / 'ServeSimEgressGuard/tests/app-paths.m'), '-o', str(app_paths)])
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
    local_peer = milestone()
    assert local_peer['phase'] == 'passthrough'
    results['blockPublication'] = json.loads(run([str(control), 'set', str(page), 'block']))
    client.stdin.write('b'); client.stdin.flush()
    assert milestone()['phase'] == 'block'
    results['passPublication'] = json.loads(run([str(control), 'set', str(page), 'passthrough']))
    client.stdin.write('p'); client.stdin.flush()
    assert milestone()['phase'] == 'passthrough-again'
    if client.wait(timeout=10):
        raise RuntimeError('Simulator fixture failed')
    # Ordinary app paths. Safari is warmed under pass-through first, so its cold launch cannot
    # hide inside the block window. Probe processes are new for each mode.
    listeners = HostListeners(local_peer['localPeer'])
    base_url = f"http://{local_peer['localPeer']}:{listeners.tcp_port}"

    def wait_for(start, tag, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if app_path_contacts(listeners.since(start), tag)['safari']:
                return True
            time.sleep(0.5)
        return False

    warm_start = time.monotonic()
    run(['xcrun', 'simctl', 'openurl', device, f'{base_url}/warm-safari'], timeout=60)
    if not wait_for(warm_start, 'warm', 60):
        raise RuntimeError('Safari did not load the warm-up page under pass-through')
    time.sleep(2)
    app_paths_results = {}
    for tag, mode in (('block', 'block'), ('pass', 'passthrough')):
        publication = json.loads(run([str(control), 'set', str(page), mode]))
        start = time.monotonic()
        probe = json.loads(run(['xcrun', 'simctl', 'spawn', device, str(app_paths), str(loader), str(guard),
                                local_peer['localPeer'], str(listeners.tcp_port), str(listeners.udp_port), tag],
                               timeout=60))
        time.sleep(1)
        window = listeners.since(start)
        contacts = app_path_contacts(window, tag)
        if mode == 'block':
            # Only this probe runs in the window, so an untagged TCP contact is also a gap.
            contacts['untaggedTcp'] = sum(1 for e in window if e['kind'] == 'tcp' and not any(
                f'/{tag}-{name}' in e['first'] for name in ('urlsession', 'nwtcp')))
        safari_start = time.monotonic()
        run(['xcrun', 'simctl', 'openurl', device, f'{base_url}/{tag}-safari'], timeout=60)
        if mode == 'block':
            time.sleep(15)
            # A blocked attempt may not reach the request line (for example a TLS upgrade), so any
            # TCP contact in this window counts. No other probe runs during it.
            contacts['safari'] = sum(1 for e in listeners.since(safari_start) if e['kind'] == 'tcp')
        else:
            wait_for(safari_start, tag, 30)
            contacts['safari'] = app_path_contacts(listeners.since(safari_start), tag)['safari']
        app_paths_results[mode] = {'publication': publication, 'probe': probe, 'contacts': contacts}
        print(json.dumps({'appPaths': mode, 'contacts': contacts}), flush=True)
    # A block-tagged contact that arrived late is still a gap.
    late = app_path_contacts(listeners.since(warm_start), 'block')
    for path, count in late.items():
        app_paths_results['block']['contacts'][path] = max(app_paths_results['block']['contacts'][path], count)
    listeners.close()
    verdicts = {}
    for path in ('urlSession', 'nwTcp', 'nwUdp', 'safari'):
        blocked = app_paths_results['block']['contacts'][path]
        passed = app_paths_results['passthrough']['contacts'][path]
        verdicts[path] = 'gap' if blocked else 'enforced' if passed else 'inconclusive'
    results['appPaths'] = app_paths_results | {'verdicts': verdicts,
                                               'scope': 'one probe per path on this machine; no remote traffic'}
    if app_paths_results['block']['contacts']['untaggedTcp']:
        verdicts['untaggedTcp'] = 'gap'
    if any(verdict != 'enforced' for verdict in verdicts.values()):
        raise RuntimeError(f'App path coverage not established: {verdicts}')
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
    if listeners:
        listeners.close()
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
