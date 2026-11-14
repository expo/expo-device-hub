"""page-fps.py <a.json> <b.json>: the page's frames per second between two page-frames.mjs reads."""
import json
import sys

try:
    a, b = (json.load(open(path)) for path in sys.argv[1:3])
    print(round((b["frame"] - a["frame"]) / ((b["pageMs"] - a["pageMs"]) / 1000), 2))
except (OSError, ValueError, KeyError, ZeroDivisionError, TypeError) as error:
    print(f"n/a ({error})")
