# Builds route-maps.json: the shared Maps script every approach is recorded with.
#   python3 route-maps.py [through-step] > route-maps.json
# Starts on the home screen, with Maps in the background at Midtown (see prep-maps.sh).
# Coordinates are fractions of the simulator screen (iPhone 17 Pro, portrait).
# Moves are sampled at 60 Hz, one per display refresh like a real finger or mouse: the picture can
# only change as often as the finger moves, so sparser paths record as stutter at any stream rate.
import json, math, sys

HZ = 60
UPTO = int(sys.argv[1]) if len(sys.argv) > 1 else 7
steps = []
def wait(ms): steps.append({"op": "wait", "ms": ms})
# kind labels each input for the measurements (newpic.py); the recorder ignores it.
def tap(x, y, after=0, note=None, kind="tap"): steps.append({"op": "tap", "x": x, "y": y, "wait": after, "kind": kind, **({"note": note} if note else {})})
def path(pts, kind, after=0, note=None): steps.append({"op": "path", "pts": [[round(t), round(x, 4), round(y, 4)] for t, x, y in pts], "wait": after, "kind": kind, **({"note": note} if note else {})})
def line(x0, y0, x1, y1, ms, hold=0):
    """Press at (x0, y0), move to (x1, y1) over ms, optionally hold still before release (no momentum)."""
    n = max(1, round(ms * HZ / 1000))
    pts = [(ms * k / n, x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n) for k in range(n + 1)]
    if hold: pts.append((ms + hold, x1, y1))
    return pts
def one_finger_zoom(y0, y1, ms=500, after=350):
    """Maps' one-finger zoom: double-tap and hold, then drag (down = out, up = in)."""
    tap(0.5, y0, after=90)
    path(line(0.5, y0, 0.5, y1, ms), "zoom", after=after)

# 1. Open Maps (icon on the home screen).
wait(1000)
tap(0.155, 0.483, after=2200, note="1 open Maps")
if UPTO >= 2:
    # 2. Move around the map: four slow pans, each held still before release.
    path(line(0.7, 0.3, 0.3, 0.38, 700, hold=150), "pan", after=500, note="2 pan")
    path(line(0.35, 0.42, 0.6, 0.15, 700, hold=150), "pan", after=500)
    path(line(0.3, 0.2, 0.75, 0.3, 700, hold=150), "pan", after=500)
    path(line(0.6, 0.15, 0.45, 0.42, 700, hold=150), "pan", after=800)
if UPTO >= 3:
    # 3. Zoom out to the whole earth (Maps' minimum zoom). Drags are long enough to reach it with
    #    margin: 60 Hz drags zoom less per distance than the earlier 20 Hz ones did.
    for y1 in (0.62, 0.62, 0.62, 0.58):
        one_finger_zoom(0.1, y1)
    wait(1500)
if UPTO >= 4:
    # 4. Fling the earth left, then right.
    path(line(0.8, 0.5, 0.2, 0.5, 110), "fling", after=2000, note="4 fling left")
    path(line(0.2, 0.5, 0.8, 0.5, 110), "fling", after=2000, note="4 fling right")
if UPTO >= 5:
    # 5. Jiggle the earth rapidly: 2 s of side-to-side shaking at 5 Hz, 0.06 of the width each way,
    #    easing out over the last half second so it ends at rest where it started (no fling on
    #    release). It moves at full speed from the first frame: a slow start lets Maps' long press
    #    take the touch and the map doesn't move at all. A smooth wave rather than hopping between two
    #    points, which can only ever show two positions.
    ms, n, ease = 2000, round(2000 * HZ / 1000), round(500 * HZ / 1000)
    pts = [(ms * k / n, 0.5 + 0.06 * math.sin(2 * math.pi * 5 * k / HZ) * min(1, (n - k) / ease), 0.5) for k in range(n + 1)]
    path(pts, "jiggle", after=1200, note="5 jiggle")
if UPTO >= 6:
    # 6. Zoom in until the earth barely fills the screen.
    one_finger_zoom(0.55, 0.45, ms=500, after=1500)
if UPTO >= 7:
    # 7. Fling left, interrupt it with a touch, fling right and let it finish.
    path(line(0.8, 0.5, 0.2, 0.5, 110), "fling", after=450, note="7 fling left")
    # Wait 700 ms after the interrupt: a press 300 ms after it read as double-tap-and-drag (one-finger
    # zoom) in most runs, and the sideways fling then did nothing.
    path([(0, 0.5, 0.5), (250, 0.5, 0.5)], "hold", after=700, note="7 interrupt")
    path(line(0.2, 0.5, 0.8, 0.5, 110), "fling", after=3500, note="7 fling right")
print(json.dumps(steps, indent=1))
