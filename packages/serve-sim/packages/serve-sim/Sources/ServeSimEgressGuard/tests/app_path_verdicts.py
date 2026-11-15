"""Verdict rule for the app-path check. Kept separate so host tests can cover it without a Simulator."""

PATHS = ('urlSession', 'nwTcp', 'nwUdp', 'safari')


def app_path_verdicts(block, passthrough):
    """A path is enforced only if block had no contact and pass-through had one.

    Any untagged TCP contact during a block probe window is also a gap.
    """
    verdicts = {}
    for path in PATHS:
        if block.get(path, 0):
            verdicts[path] = 'gap'
        elif passthrough.get(path, 0):
            verdicts[path] = 'enforced'
        else:
            verdicts[path] = 'inconclusive'
    if block.get('untaggedTcp', 0):
        verdicts['untaggedTcp'] = 'gap'
    return verdicts
