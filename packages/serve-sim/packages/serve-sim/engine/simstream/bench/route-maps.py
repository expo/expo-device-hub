# Builds route-maps.json: the shared Maps script every approach is recorded with.
#   python3 route-maps.py [through-step] > route-maps.json
# Starts on the home screen, with Maps in the background at Midtown (see prepare-maps in
# rec-six.sh). Coordinates are fractions of the simulator screen (iPhone 17 Pro, portrait).
import json, sys

UPTO = int(sys.argv[1]) if len(sys.argv) > 1 else 7
steps = []
def wait(ms): steps.append({"op": "wait", "ms": ms})
def tap(x, y, after=0, note=None): steps.append({"op": "tap", "x": x, "y": y, "wait": after, **({"note": note} if note else {})})
def path(pts, after=0, note=None): steps.append({"op": "path", "pts": [[int(t), round(x, 4), round(y, 4)] for t, x, y in pts], "wait": after, **({"note": note} if note else {})})
def line(x0, y0, x1, y1, ms, n=12, hold=0):
    """Press at (x0, y0), move to (x1, y1) over ms, optionally hold still before release (no momentum)."""
    pts = [(ms * k / n, x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n) for k in range(n + 1)]
    if hold: pts.append((ms + hold, x1, y1))
    return pts
def one_finger_zoom(y0, y1, ms=500, after=350):
    """Maps' one-finger zoom: double-tap and hold, then drag (down = out, up = in)."""
    tap(0.5, y0, after=90)
    path(line(0.5, y0, 0.5, y1, ms, n=10), after=after)

# 1. Open Maps (icon on the home screen).
wait(1000)
tap(0.155, 0.483, after=2200, note="1 open Maps")
if UPTO >= 2:
    # 2. Move around the map: four slow pans, each held still before release.
    path(line(0.7, 0.3, 0.3, 0.38, 700, hold=150), after=500, note="2 pan")
    path(line(0.35, 0.42, 0.6, 0.15, 700, hold=150), after=500)
    path(line(0.3, 0.2, 0.75, 0.3, 700, hold=150), after=500)
    path(line(0.6, 0.15, 0.45, 0.42, 700, hold=150), after=800)
if UPTO >= 3:
    # 3. Zoom out until space is barely visible on either side of the earth.
    for y1 in (0.5, 0.5, 0.5, 0.47):
        one_finger_zoom(0.1, y1)
    wait(1500)
if UPTO >= 4:
    # 4. Fling the earth left, then right.
    path(line(0.8, 0.5, 0.2, 0.5, 110, n=7), after=2000, note="4 fling left")
    path(line(0.2, 0.5, 0.8, 0.5, 110, n=7), after=2000, note="4 fling right")
if UPTO >= 5:
    # 5. Jiggle the earth rapidly: 2 s of small side-to-side moves at 30 Hz, then let go.
    pts = [(0, 0.5, 0.5)] + [(33 * k, 0.5 + (0.06 if k % 2 else -0.06), 0.5) for k in range(1, 61)] + [(33 * 61, 0.5, 0.5)]
    path(pts, after=1200, note="5 jiggle")
if UPTO >= 6:
    # 6. Zoom in until the earth barely fills the screen.
    one_finger_zoom(0.55, 0.45, ms=500, after=1500)
if UPTO >= 7:
    # 7. Fling left, interrupt it with a touch, fling right and let it finish.
    path(line(0.8, 0.5, 0.2, 0.5, 110, n=7), after=450, note="7 fling left")
    path([(0, 0.5, 0.5), (250, 0.5, 0.5)], after=300, note="7 interrupt")
    path(line(0.2, 0.5, 0.8, 0.5, 110, n=7), after=3500, note="7 fling right")
print(json.dumps(steps, indent=1))
