# Reports mitmproxy flows to the capture session control port.

import base64 as b64
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
import zlib

try:
    import brotli
except ImportError:
    brotli = None

CONTROL = os.environ.get("SERVE_SIM_CAPTURE_CONTROL_URL")
TOKEN = os.environ.get("SERVE_SIM_CAPTURE_CONTROL_TOKEN", "")
# Absent fields mean metadata only.
FIELDS = {
    part.strip()
    for part in os.environ.get("SERVE_SIM_CAPTURE_FIELDS", "").split(",")
    if part.strip()
}
WANT_HEADERS = "header" in FIELDS
WANT_REQUEST_BODY = "request-body" in FIELDS
WANT_RESPONSE_BODY = "response-body" in FIELDS
# Query values require explicit opt-in.
WANT_QUERY = "query" in FIELDS
REDACTED = "[REDACTED]"

MAX_BODY_BYTES = 512 * 1024
TIMEOUT_SECONDS = 2
# serve-sim sends SIGKILL 3 s after SIGTERM, so the final flush must finish sooner.
SHUTDOWN_SECONDS = 2.5
_shutdown_deadline = None
QUEUE_BYTE_LIMIT = 32 * 1024 * 1024
# Bound metadata independently of the body cap.
MAX_URL_CHARS = 4096
MAX_HEADER_NAME_CHARS = 256
MAX_HEADER_VALUE_CHARS = 4096
MAX_HEADERS = 100
MAX_ERROR_CHARS = 1024
# Bound object overhead as well as serialized bytes.
QUEUE_ITEM_LIMIT = 10_000

# Single worker preserves /request-before-/response order.
_outbox: "queue.Queue[tuple[str, bytes, int] | None]" = queue.Queue()
_queued_bytes = 0
_queued_lock = threading.Lock()

# Bypass http_proxy/HTTP_PROXY so records hit the loopback control port.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _send(path, body):
    request = urllib.request.Request(
        f"{CONTROL}{path}?t={TOKEN}",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    timeout = TIMEOUT_SECONDS
    if _shutdown_deadline is not None:
        # One slow send must not use up the time the rest of the queue needs.
        timeout = max(0.05, min(timeout, _shutdown_deadline - time.monotonic()))
    try:
        _opener.open(request, timeout=timeout).close()
    except Exception:
        pass


def _drain():
    global _queued_bytes
    while True:
        item = _outbox.get()
        if item is None:
            return
        path, body, size = item
        with _queued_lock:
            _queued_bytes -= size
        _send(path, body)


_reporter = threading.Thread(target=_drain, name="servesim-capture-reporter", daemon=True)
if CONTROL:
    _reporter.start()


def _clip(value, limit):
    text = "" if value is None else str(value)
    return text[:limit]


def _clip_headers(headers):
    # The wire bounds none of these, so cap count, name and value.
    out = {}
    for name, value in list(headers.items())[:MAX_HEADERS]:
        out[_clip(name, MAX_HEADER_NAME_CHARS)] = _clip(value, MAX_HEADER_VALUE_CHARS)
    return out


def _post(path, payload):
    global _queued_bytes
    if not CONTROL:
        return
    # Charge metadata as well as bodies.
    body = json.dumps(payload).encode("utf-8")
    size = len(body)
    with _queued_lock:
        if _queued_bytes + size > QUEUE_BYTE_LIMIT or _outbox.qsize() >= QUEUE_ITEM_LIMIT:
            return
        _queued_bytes += size
    _outbox.put_nowait((path, body, size))


def running():
    _post("/ready", {"addon": "servesim_capture"})


def done():
    global _shutdown_deadline
    if not CONTROL:
        return
    _shutdown_deadline = time.monotonic() + SHUTDOWN_SECONDS
    _outbox.put_nowait(None)
    _reporter.join(timeout=SHUTDOWN_SECONDS)
    if _reporter.is_alive():
        left = max(0, _outbox.qsize() - 1)
        print(f"[servesim-capture] stopped with {left} capture record(s) not delivered", file=sys.stderr)


def _headers_of(message):
    # Headers only when asked for; redaction happens on the session side.
    if not WANT_HEADERS:
        return {}
    return _clip_headers({name.lower(): value for name, value in message.headers.items()})


def _mime_of(message):
    # MIME type survives metadata-only capture.
    value = message.headers.get("content-type") if hasattr(message, "headers") else None
    return _clip(value, MAX_HEADER_VALUE_CHARS) or None


def _safe_url(raw):
    text = str(raw or "")
    if WANT_QUERY or "?" not in text:
        return _clip(text, MAX_URL_CHARS)
    head, _, query = text.partition("?")
    if not query:
        return _clip(head, MAX_URL_CHARS)
    parts = []
    for pair in query.split("&"):
        if not pair:
            continue
        name, sep, _value = pair.partition("=")
        # A bare query token is a value, not a field name.
        parts.append(f"{name}={REDACTED}" if sep else REDACTED)
    # Redaction can expand the URL; clip afterward.
    return _clip(f"{head}?{'&'.join(parts)}", MAX_URL_CHARS)


DECODE_CHUNK_BYTES = 64 * 1024


def _inflate(wire, wbits):
    limit = MAX_BODY_BYTES + 1
    decoder = zlib.decompressobj(wbits)
    view = memoryview(wire)
    out = bytearray()
    start = 0
    for start in range(0, len(view), DECODE_CHUNK_BYTES):
        data = view[start : start + DECODE_CHUNK_BYTES]
        while data and len(out) < limit and not decoder.eof:
            out += decoder.decompress(data, limit - len(out))
            data = decoder.unconsumed_tail
        if len(out) >= limit or decoder.eof:
            break
    more_input = bool(decoder.unused_data) or start + DECODE_CHUNK_BYTES < len(view)
    return bytes(out), len(out) < limit and (not decoder.eof or more_input)


def _unbrotli(wire):
    limit = MAX_BODY_BYTES + 1
    decoder = brotli.Decompressor()
    view = memoryview(wire)
    out = bytearray()
    position = 0
    while len(out) < limit and not decoder.is_finished():
        if decoder.can_accept_more_data():
            if position >= len(view):
                break
            data = view[position : position + DECODE_CHUNK_BYTES]
            position += DECODE_CHUNK_BYTES
        else:
            data = b""
        produced = decoder.process(data, output_buffer_limit=limit - len(out))
        if not data and not produced:
            break
        out += produced
    more_input = position < len(view)
    return bytes(out[:limit]), len(out) < limit and (not decoder.is_finished() or more_input)


def _body_of(message, wire):
    # Decode at most one byte past the cap, a chunk at a time, so a small compressed body cannot
    # inflate without bound and a large one is never copied whole. Returns (bytes, incomplete).
    encoding = (message.headers.get("content-encoding") or "").strip().lower()
    try:
        if encoding in ("gzip", "x-gzip", "deflate"):
            modes = (zlib.MAX_WBITS, -zlib.MAX_WBITS) if encoding == "deflate" else (zlib.MAX_WBITS | 32,)
            for wbits in modes:
                try:
                    return _inflate(wire, wbits)
                except zlib.error:
                    continue
        elif encoding == "br" and brotli is not None:
            return _unbrotli(wire)
    except Exception:
        pass
    return wire, False


def _part(message, want_body):
    wire = message.raw_content or b""
    part = {
        "headers": _headers_of(message),
        "mime": _mime_of(message),
        "size": len(wire),
        "body": "",
        "base64": None,
        "truncated": False,
    }
    if want_body and wire:
        body, incomplete = _body_of(message, wire)
        head = body[:MAX_BODY_BYTES]
        part["truncated"] = incomplete or len(body) > MAX_BODY_BYTES
        try:
            part["body"] = head.decode("utf-8")
        except UnicodeDecodeError as error:
            if part["truncated"] and error.end == len(head) and error.reason == "unexpected end of data":
                part["body"] = head[: error.start].decode("utf-8")
            else:
                part["body"] = None
                part["base64"] = b64.b64encode(head).decode("ascii")
    return part


def request(flow):
    _post(
        "/request",
        {
            "id": flow.id,
            "method": flow.request.method,
            "url": _safe_url(flow.request.pretty_url),
            "startedAt": flow.request.timestamp_start * 1000,
        },
    )


def response(flow):
    reply = flow.response
    started = flow.request.timestamp_start
    _post(
        "/response",
        {
            "id": flow.id,
            "status": reply.status_code,
            "ttfbMs": round((reply.timestamp_start - started) * 1000, 1),
            "durationMs": round((reply.timestamp_end - started) * 1000, 1),
            "req": _part(flow.request, WANT_REQUEST_BODY),
            "res": _part(reply, WANT_RESPONSE_BODY),
        },
    )


def error(flow):
    reply = flow.response
    # Completed responses have already been reported.
    if reply is not None and reply.timestamp_end is not None:
        return
    _post(
        "/response",
        {
            "id": flow.id,
            "status": None,
            "error": _clip(flow.error, MAX_ERROR_CHARS) or "the request failed before a response",
            "req": _part(flow.request, WANT_REQUEST_BODY),
        },
    )


def http_connect_error(flow):
    # CONNECT with no inner flow — request/error hooks never fire.
    _post(
        "/request",
        {
            "id": flow.id,
            "method": "CONNECT",
            "startedAt": flow.request.timestamp_start * 1000,
            "url": _clip(f"{flow.request.pretty_host}:{flow.request.port}", MAX_URL_CHARS),
        },
    )
    _post(
        "/response",
        {
            "id": flow.id,
            "status": None,
            "error": _clip(flow.error, MAX_ERROR_CHARS) or "could not connect to the host",
        },
    )
