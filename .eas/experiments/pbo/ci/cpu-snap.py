"""cpu-snap.py <out file> <name=pid>...: machine CPU, and each process with its threads.

One line per item: "time <epoch ms>", "total <cpu fields of /proc/stat>",
"proc <name> <pid> <ticks>", "thread <name> <tid> <comm> <ticks>" (ticks = utime + stime).
"""
import os
import sys
import time


def ticks(path):
    try:
        data = open(path).read()
    except OSError:
        return None
    fields = data.rsplit(")", 1)[1].split()  # comm can hold spaces and parentheses
    return int(fields[11]) + int(fields[12])


lines = [f"time {int(time.time() * 1000)}"]
with open("/proc/stat") as stat:
    lines.append("total " + stat.readline().split(None, 1)[1].strip())
with open("/proc/loadavg") as load:
    lines.append("load " + load.read().strip())
for pair in sys.argv[2:]:
    name, _, pid = pair.partition("=")
    if not pid:
        continue
    total = ticks(f"/proc/{pid}/stat")
    if total is None:
        continue
    lines.append(f"proc {name} {pid} {total}")
    try:
        tids = os.listdir(f"/proc/{pid}/task")
    except OSError:
        tids = []
    for tid in tids:
        value = ticks(f"/proc/{pid}/task/{tid}/stat")
        try:
            comm = open(f"/proc/{pid}/task/{tid}/comm").read().strip().replace(" ", "_")
        except OSError:
            continue
        if value is not None:
            lines.append(f"thread {name} {tid} {comm} {value}")
with open(sys.argv[1], "w") as out:
    out.write("\n".join(lines) + "\n")
