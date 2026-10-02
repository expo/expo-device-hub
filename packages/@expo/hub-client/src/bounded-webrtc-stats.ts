/** A deadline bounds waiting; the browser's underlying getStats read cannot be cancelled. */
const readsInFlight = new WeakMap<RTCPeerConnection, Promise<RTCStatsReport | null>>();

export async function readStatsBeforeDeadline(
  peer: RTCPeerConnection | null,
  deadlineMs = 2_000,
): Promise<RTCStatsReport | null> {
  if (!peer) return null;
  let read = readsInFlight.get(peer);
  if (!read) {
    read = Promise.resolve().then(() => peer.getStats()).catch(() => null);
    readsInFlight.set(peer, read);
    void read.then(() => readsInFlight.delete(peer));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), deadlineMs); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
