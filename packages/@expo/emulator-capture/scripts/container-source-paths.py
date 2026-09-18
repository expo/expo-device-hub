#!/usr/bin/env python3
"""Translate a Frida source-override map for the package's Docker bind mount."""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
values = json.loads(sys.argv[2])
if not isinstance(values, dict):
    sys.exit("POC_FRIDA_SOURCE_OVERRIDES must be a JSON object")
mounts = set()
for name, value in values.items():
    if not isinstance(value, str) or any(c in value for c in "\r\n,"):
        sys.exit("Source override paths must be strings without commas/newlines")
    path = (root / value).resolve()
    if not path.is_dir():
        sys.exit(f"Missing source override: {path}")
    if path.is_relative_to(root):
        values[name] = "/work/" + path.relative_to(root).as_posix()
    else:
        values[name] = str(path)
        mounts.add(str(path))
print(json.dumps(values))
for path in sorted(mounts):
    print(path)
