"""Exercise one add-on instance against a real control server."""

import gzip
import importlib.util
import json
import os
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer

ADDON_PATH = sys.argv[1]

received = []


class ControlHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        received.append(
            {"path": self.path, "body": json.loads(self.rfile.read(length) or b"{}")}
        )
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), ControlHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()

os.environ["SERVE_SIM_CAPTURE_CONTROL_URL"] = f"http://127.0.0.1:{server.server_port}"
os.environ["SERVE_SIM_CAPTURE_CONTROL_TOKEN"] = "probe-token"
os.environ["SERVE_SIM_CAPTURE_FIELDS"] = os.environ.get(
    "PROBE_FIELDS", "header,request-body,response-body"
)
for name in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    os.environ[name] = "http://127.0.0.1:1"

spec = importlib.util.spec_from_file_location("servesim_capture", ADDON_PATH)
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)

MAX_BODY_BYTES = addon.MAX_BODY_BYTES


class FakeMessage:
    def __init__(self, wire, headers=None):
        self.raw_content = wire
        self.headers = headers if headers is not None else {"Content-Type": "text/plain"}


def wait_for(count, timeout=5.0):
    deadline = time.time() + timeout
    while len(received) < count and time.time() < deadline:
        time.sleep(0.02)
    return len(received)


results = {}

plain = addon._part(FakeMessage(b"gzipbytes" * 10), True)
results["plainSize"] = plain["size"]
results["plainBody"] = plain["body"]

gzipped_wire = gzip.compress(b'{"ok":true}')
gzipped = addon._part(FakeMessage(gzipped_wire, {"content-encoding": "gzip"}), True)
results["gzipBody"] = gzipped["body"]
results["gzipSize"] = gzipped["size"] == len(gzipped_wire)
results["gzipTruncated"] = gzipped["truncated"]

raw_deflate = zlib.compressobj(wbits=-zlib.MAX_WBITS)
raw_deflate_wire = raw_deflate.compress(b"raw deflate") + raw_deflate.flush()
results["deflateBodies"] = [
    addon._part(FakeMessage(zlib.compress(b"zlib deflate"), {"content-encoding": "deflate"}), True)["body"],
    addon._part(FakeMessage(raw_deflate_wire, {"content-encoding": "deflate"}), True)["body"],
]

bomb_wire = gzip.compress(b"\0" * (20 * 1024 * 1024))
bomb = addon._part(FakeMessage(bomb_wire, {"content-encoding": "gzip"}), True)
results["bombBodyLength"] = len(bomb["body"])
results["bombTruncated"] = bomb["truncated"]
results["bombSize"] = bomb["size"] == len(bomb_wire)
results["bombDecodedBytes"] = len(addon._body_of(FakeMessage(bomb_wire, {"content-encoding": "gzip"}), bomb_wire)[0])

cut_wire = gzip.compress(b'{"a":1,"b":"text"}')[:-10]
cut = addon._part(FakeMessage(cut_wire, {"content-encoding": "gzip"}), True)
results["cutBody"] = cut["body"]
results["cutTruncated"] = cut["truncated"]

members_wire = gzip.compress(b"first member ") + gzip.compress(b"second member")
members = addon._part(FakeMessage(members_wire, {"content-encoding": "gzip"}), True)
results["membersBody"] = members["body"]
results["membersTruncated"] = members["truncated"]

lying = addon._part(FakeMessage(b"raw-wire-bytes", {"content-encoding": "gzip"}), True)
results["lyingSize"] = lying["size"]
results["lyingBody"] = lying["body"]

unsupported = addon._part(FakeMessage(b"\xff\xfe", {"content-encoding": "zstd"}), True)
results["unsupportedBase64"] = unsupported["base64"]

class RecordingHeaders(dict):
    def __init__(self, *args):
        super().__init__(*args)
        self.encoding_read = False

    def get(self, key, default=None):
        if key == "content-encoding":
            self.encoding_read = True
        return super().get(key, default)


metadata_headers = RecordingHeaders({"content-encoding": "gzip"})
metadata_only = addon._part(FakeMessage(b"compressed", metadata_headers), False)
results["metadataBody"] = metadata_only["body"]
results["metadataDecoded"] = metadata_headers.encoding_read

binary = addon._part(FakeMessage(b"\xff\xfe\x00\x01"), True)
results["binaryBody"] = binary["body"]
results["binaryBase64"] = binary["base64"]

oversized = addon._part(FakeMessage(b"a" * (MAX_BODY_BYTES + 10)), True)
results["oversizedTruncated"] = oversized["truncated"]
results["oversizedBodyLength"] = len(oversized["body"])

split_wire = b"a" * (MAX_BODY_BYTES - 1) + "é".encode("utf-8")
split = addon._part(FakeMessage(split_wire), True)
results["splitCharBody"] = len(split["body"]) if split["body"] is not None else None
results["splitCharBase64"] = split["base64"]
results["splitCharTruncated"] = split["truncated"]

empty = addon._part(FakeMessage(b""), True)
results["emptySize"] = empty["size"]
results["emptyBody"] = empty["body"]
results["emptyTruncated"] = empty["truncated"]

headers = addon._part(FakeMessage(b"", headers={"Content-Type": "application/json"}), True)
results["headerKeys"] = list(headers["headers"].keys())

# Delivery. Reaching the control server at all proves the hostile proxy above was ignored.
addon.running()
results["readyDelivered"] = wait_for(1) == 1
results["readyPath"] = received[0]["path"] if received else None
results["proxyBypassed"] = bool(received)

received.clear()


class FakeRequest:
    def __init__(self):
        self.method = "GET"
        self.pretty_url = "https://example.test/thing"
        self.pretty_host = "example.test"
        self.port = 443
        self.timestamp_start = 1000.0
        self.raw_content = b""
        self.headers = {}


class FakeResponse:
    def __init__(self, timestamp_end=None):
        self.timestamp_end = timestamp_end


class FakeFlow:
    def __init__(self, error=None, response=None):
        self.id = "flow-1"
        self.request = FakeRequest()
        self.error = error
        self.response = response


addon.request(FakeFlow())
wait_for(1)
results["requestStartedAt"] = received[0]["body"]["startedAt"]
received.clear()

# A completed response was already reported; erroring after it must not produce a second row.
addon.error(FakeFlow(error="reset", response=FakeResponse(timestamp_end=1001.0)))
# One worker keeps the order, so a record queued after it arriving alone proves the skip.
addon._post("/probe-sentinel", {"id": "sentinel"})
wait_for(1)
results["errorSkippedWhenResponseCompleted"] = [
    item["path"].split("?")[0] for item in received
] == ["/probe-sentinel"]

received.clear()

# Headers arrived and the body was cut: `response` never ran, so this error is the only report there is.
addon.error(FakeFlow(error="server closed the connection", response=FakeResponse()))
results["errorAfterPartialResponseFrames"] = wait_for(1)
results["errorAfterPartialResponseStatus"] = (
    received[0]["body"].get("status", "missing") if received else "missing"
)
results["errorAfterPartialResponseMessage"] = received[0]["body"].get("error") if received else None

received.clear()

addon.http_connect_error(FakeFlow(error="no route to host"))
results["connectErrorFrames"] = wait_for(2)
results["connectErrorPaths"] = [item["path"].split("?")[0] for item in received]

received.clear()

addon.error(FakeFlow(error="connection reset"))
results["errorWithoutResponseFrames"] = wait_for(1)
results["errorWithoutResponseMessage"] = received[0]["body"].get("error") if received else None

received.clear()

# The byte counter must return to zero once the queue drains, or the limit below would creep shut.
time.sleep(0.3)
results["queuedBytesAfterDrain"] = addon._queued_bytes

# Over the limit, a record is dropped rather than queued without bound.
_saved_limit = addon.QUEUE_BYTE_LIMIT
addon.QUEUE_BYTE_LIMIT = 16
addon._post("/response", {"id": "big", "res": {"body": "x" * 64}})
time.sleep(0.3)
results["oversizedRecordDropped"] = len(received) == 0
results["queuedBytesAfterDrop"] = addon._queued_bytes

received.clear()
addon.QUEUE_BYTE_LIMIT = 500
addon._post("/request", {"id": "hdr", "method": "GET", "url": "https://a.test/" + "p" * 3000})
time.sleep(0.3)
results["bodylessRecordCounted"] = len(received) == 0
addon.QUEUE_BYTE_LIMIT = _saved_limit

results["urlQueryRedacted"] = addon._safe_url("https://a.test/cb?code=SECRET&state=xyz")
results["urlWithoutQueryUntouched"] = addon._safe_url("https://a.test/thing")
_expanding = "https://a.test/?" + "&".join(f"k{i}=1" for i in range(1000))
results["urlCappedExpanding"] = len(addon._safe_url(_expanding)) <= addon.MAX_URL_CHARS
results["urlCapped"] = len(addon._safe_url("https://a.test/?x=" + "y" * 99_000)) <= addon.MAX_URL_CHARS
results["urlBareTokenRedacted"] = addon._safe_url("https://a.test/cb?SECRETTOKEN")
print(json.dumps(results))
