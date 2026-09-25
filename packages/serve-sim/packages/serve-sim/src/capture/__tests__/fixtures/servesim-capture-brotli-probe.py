"""Run by mitmdump -s: checks brotli decoding with the brotli that mitmproxy itself ships."""
import importlib.util
import json
import os

import brotli
from mitmproxy import ctx

spec = importlib.util.spec_from_file_location("servesim_capture", os.environ["SERVE_SIM_ADDON_PATH"])
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)


class Message:
    def __init__(self, wire):
        self.raw_content = wire
        self.headers = {"content-encoding": "br"}


text = addon._part(Message(brotli.compress(b'{"hello":"brotli"}')), True)
bomb = addon._part(Message(brotli.compress(b"\0" * (20 * 1024 * 1024))), True)
garbage = addon._part(Message(b"\xff\xfenot-brotli"), True)

with open(os.environ["SERVE_SIM_BROTLI_PROBE_OUT"], "w") as out:
    json.dump(
        {
            "textBody": text["body"],
            "textTruncated": text["truncated"],
            "bombBodyLength": len(bomb["body"]),
            "bombTruncated": bomb["truncated"],
            "garbageBase64": garbage["base64"],
        },
        out,
    )


def running():
    ctx.master.shutdown()
