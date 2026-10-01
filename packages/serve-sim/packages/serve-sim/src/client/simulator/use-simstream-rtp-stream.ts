import { useEffect, useState } from "react";
import type { WebRtcIceServer } from "../../stream-settings";
import { transitionMode } from "./use-simstream-stream.js";

export interface UseSimstreamRtpStreamOptions {
  /** Helper base URL, e.g. "http://localhost:3200/helper/<udid>"; signaling is `<url>/simstream-rtp`. */
  url: string;
  enabled: boolean;
  iceServers?: WebRtcIceServer[];
}

export interface SimstreamRtpStream {
  stream: MediaStream | null;
  peerConnection: RTCPeerConnection | null;
  error: string | null;
}

const RETRY_DELAY_MS = 1000;

/** Posts each encoded frame's RTP timestamp as it arrives (Safari's RTCRtpScriptTransform). */
const ACK_WORKER = `onrtctransform = ({ transformer }) => {
  transformer.readable.pipeThrough(new TransformStream({
    transform(frame, controller) { postMessage(frame.getMetadata().rtpTimestamp); controller.enqueue(frame); },
  })).pipeTo(transformer.writable);
};`;

type EncodedStreamsReceiver = RTCRtpReceiver & {
  createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream };
};

/**
 * The simstream engine's H.264 as a WebRTC video track (RTP), from serve-sim's bridge in the
 * simstream relay process. The browser's WebRTC stack does jitter buffering, loss recovery (NACK),
 * keyframe requests and decoding; the returned stream plays in the simulator's `<video>`.
 *
 * The engine keeps its own per-viewer rate control, driven by acks: every encoded frame is acked
 * (by RTP timestamp) on the "ctl" data channel as it arrives, before decoding, like the WebSocket
 * path's ack-on-decode. Input still goes through serve-sim's control socket.
 */
export function useSimstreamRtpStream({ url, enabled, iceServers }: UseSimstreamRtpStreamOptions): SimstreamRtpStream {
  const [state, setState] = useState<SimstreamRtpStream>({ stream: null, peerConnection: null, error: null });

  useEffect(() => {
    if (!enabled || !url) return;
    let stopped = false;
    let signal: WebSocket | null = null;
    let pc: RTCPeerConnection | null = null;
    let worker: Worker | null = null;
    let ctl: RTCDataChannel | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const send = (message: object) => {
      if (ctl?.readyState === "open") ctl.send(JSON.stringify(message));
    };
    const ack = (rtp: number) => send({ t: "ack", rtp });
    const onVisibility = () => send({ t: document.hidden ? "pause" : "resume" });

    const teardown = () => {
      signal?.close();
      pc?.close();
      worker?.terminate();
      signal = null;
      pc = null;
      worker = null;
      ctl = null;
    };

    const connect = () => {
      if (stopped) return;
      const peer = new RTCPeerConnection({ iceServers: iceServers ?? [], encodedInsertableStreams: true } as RTCConfiguration);
      const socket = new WebSocket(`${url.replace(/^http/, "ws").replace(/\/$/, "")}/simstream-rtp`);
      pc = peer;
      signal = socket;

      peer.onicecandidate = ({ candidate }) => {
        if (candidate && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: "cand", candidate: candidate.candidate, mid: candidate.sdpMid }));
        }
      };
      peer.ontrack = ({ track, receiver, streams }) => {
        const rtpReceiver = receiver as EncodedStreamsReceiver;
        // Render as soon as frames are decodable: no smoothing buffer.
        if ("jitterBufferTarget" in rtpReceiver) rtpReceiver.jitterBufferTarget = 0;
        if (rtpReceiver.createEncodedStreams) {
          const { readable, writable } = rtpReceiver.createEncodedStreams();
          void readable.pipeThrough(new TransformStream({
            transform(frame: RTCEncodedVideoFrame, controller) {
              ack(frame.getMetadata().rtpTimestamp ?? frame.timestamp);
              controller.enqueue(frame);
            },
          })).pipeTo(writable);
        } else if (typeof RTCRtpScriptTransform !== "undefined") {
          worker = new Worker(URL.createObjectURL(new Blob([ACK_WORKER], { type: "text/javascript" })));
          worker.onmessage = ({ data }) => ack(data as number);
          rtpReceiver.transform = new RTCRtpScriptTransform(worker);
        } else {
          setState({ stream: null, peerConnection: null, error: "This browser can't ack WebRTC frames as they arrive; use the WebSocket transport." });
          teardown();
          return;
        }
        setState({ stream: streams[0] ?? new MediaStream([track]), peerConnection: peer, error: null });
      };
      peer.ondatachannel = ({ channel }) => {
        if (channel.label !== "ctl") return;
        ctl = channel;
        channel.onopen = () => {
          send({ t: "hello", codecs: ["h264"] });
          send({ t: "settings", transitions: transitionMode(), hevc: false });
          if (document.hidden) send({ t: "pause" });
        };
      };
      socket.onmessage = async ({ data }) => {
        const message = JSON.parse(data as string) as {
          t: string; sdp?: string; type?: RTCSdpType; candidate?: string; mid?: string; message?: string;
        };
        if (message.t === "sdp" && message.sdp && message.type) {
          await peer.setRemoteDescription({ type: message.type, sdp: message.sdp });
          if (message.type === "offer") {
            await peer.setLocalDescription(await peer.createAnswer());
            socket.send(JSON.stringify({ t: "sdp", sdp: peer.localDescription!.sdp, type: peer.localDescription!.type }));
          }
        } else if (message.t === "cand" && message.candidate) {
          await peer.addIceCandidate({ candidate: message.candidate, sdpMid: message.mid }).catch(() => {});
        } else if (message.t === "error") {
          setState({ stream: null, peerConnection: null, error: `simstream RTP: ${message.message}` });
        }
      };
      const reconnect = () => {
        if (stopped || pc !== peer) return;
        teardown();
        setState((current) => current.error ? current : { stream: null, peerConnection: null, error: null });
        retryTimer = setTimeout(connect, RETRY_DELAY_MS);
      };
      socket.onclose = reconnect;
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "closed") reconnect();
      };
    };

    document.addEventListener("visibilitychange", onVisibility);
    connect();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (retryTimer) clearTimeout(retryTimer);
      teardown();
      setState({ stream: null, peerConnection: null, error: null });
    };
  }, [url, enabled, iceServers]);

  return state;
}
