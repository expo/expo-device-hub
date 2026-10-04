#!/usr/bin/env python3
"""Loopback-only range server. Start only after all recording captures finish."""
import argparse
import http.server
import json
from pathlib import Path
import re
import threading
import time
from urllib.parse import urlparse
import uuid

ROOT = Path(__file__).resolve().parent
LOCK = threading.Lock()
REQUESTS = {}
BUDGETS = {}
MANIFEST = None
TRIAL_PATH = re.compile(r'^/video/([a-zA-Z0-9-]+)/(?P<variant>front|tail)\.mp4$')


def log(path, value):
    with LOCK:
        with (ROOT / path).open('a') as target:
            target.write(json.dumps(value) + '\n')


def reserve(run, size):
    # All simultaneous media range responses in a trial share this byte budget.
    rate = MANIFEST['settings']['mbps'] * 1_000_000 / 8
    with LOCK:
        now = time.monotonic()
        deadline = max(now, BUDGETS.get(run, now)) + size / rate
        BUDGETS[run] = deadline
    time.sleep(max(0, deadline - time.monotonic()))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_headers(self, status, kind, length):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Content-Length', str(length))

    def json_response(self, value):
        body = json.dumps(value).encode()
        self.send_headers(200, 'application/json', len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/results':
            self.send_error(404)
            return
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length < 1_000_000:
            self.send_error(413)
            return
        value = json.loads(self.rfile.read(length))
        log('browser-results.jsonl', value)
        self.send_headers(204, 'application/json', 0)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ('/', '/index.html'):
            body = (ROOT / 'index.html').read_bytes()
            self.send_headers(200, 'text/html; charset=utf-8', len(body))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == '/manifest':
            self.json_response({key: value for key, value in MANIFEST.items()
                                if key not in ('front', 'tail')})
            return
        if parsed.path == '/results':
            path = ROOT / 'browser-results.jsonl'
            rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
            self.json_response(rows)
            return
        if parsed.path.startswith('/settle/'):
            run = parsed.path.removeprefix('/settle/')
            limit = time.monotonic() + 8
            while time.monotonic() < limit:
                with LOCK:
                    active = sum(item.get('completedUnix') is None for item in REQUESTS.get(run, []))
                if not active:
                    break
                time.sleep(0.02)
            with LOCK:
                rows = [dict(item) for item in REQUESTS.get(run, [])]
            self.json_response({'run': run, 'requests': rows,
                                'settled': all(item.get('completedUnix') is not None for item in rows)})
            return
        match = TRIAL_PATH.fullmatch(parsed.path)
        if not match:
            self.send_error(404)
            return
        run, variant = match.group(1), match.group('variant')
        path = Path(MANIFEST[variant])
        total = path.stat().st_size
        start, end = 0, total - 1
        range_header = self.headers.get('Range')
        if range_header:
            requested = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header)
            if not requested or not any(requested.groups()):
                self.send_error(416)
                return
            left, right = requested.groups()
            if left:
                start = int(left)
                end = min(int(right), end) if right else end
            else:
                start = max(0, total - int(right))
            if start >= total or end < start:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{total}')
                self.end_headers()
                return
        entry = {'requestId': uuid.uuid4().hex, 'run': run, 'variant': variant,
                 'range': range_header, 'start': start, 'end': end,
                 'startedUnix': time.time(), 'completedUnix': None, 'bytesWritten': 0,
                 'mbps': MANIFEST['settings']['mbps'], 'latencyMs': MANIFEST['settings']['latencyMs']}
        with LOCK:
            REQUESTS.setdefault(run, []).append(entry)
        log('http-requests.jsonl', {'event': 'started', **entry})
        begun = time.monotonic()
        try:
            time.sleep(MANIFEST['settings']['latencyMs'] / 1000)
            self.send_headers(206 if range_header else 200, 'video/mp4', end - start + 1)
            self.send_header('Accept-Ranges', 'bytes')
            if range_header:
                self.send_header('Content-Range', f'bytes {start}-{end}/{total}')
            self.end_headers()
            with path.open('rb') as source:
                source.seek(start)
                remaining = end - start + 1
                while remaining:
                    block = source.read(min(65_536, remaining))
                    if not block:
                        break
                    reserve(run, len(block))
                    self.wfile.write(block)
                    remaining -= len(block)
                    entry['bytesWritten'] += len(block)
        except (BrokenPipeError, ConnectionResetError):
            entry['clientDisconnected'] = True
        finally:
            with LOCK:
                entry['completedUnix'] = time.time()
                entry['wallSeconds'] = time.monotonic() - begun
            log('http-requests.jsonl', {'event': 'completed', **entry})


def main():
    global MANIFEST
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8773)
    args = parser.parse_args()
    MANIFEST = json.loads((ROOT / 'manifest.json').read_text())
    for variant in ('front', 'tail'):
        if not Path(MANIFEST[variant]).is_file():
            raise ValueError(f'Missing {variant} media')
    print(f'http://127.0.0.1:{args.port}/', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
