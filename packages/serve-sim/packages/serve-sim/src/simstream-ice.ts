import type { WebRtcIceServer } from "./stream-settings";

/** serve-sim's ICE servers (`--stun-url`, `--turn-url`) in node-datachannel's form, e.g. `turn:user:pass@host:3478`. */
export function iceServerUrls(servers: WebRtcIceServer[] = []): string[] {
  return servers.flatMap(({ urls, username, credential }) => urls.map((url) => {
    if (!username || !/^turns?:/.test(url)) return url;
    const [scheme, rest] = url.split(/:(.*)/s);
    return `${scheme}:${encodeURIComponent(username)}:${encodeURIComponent(credential ?? "")}@${rest}`;
  }));
}
