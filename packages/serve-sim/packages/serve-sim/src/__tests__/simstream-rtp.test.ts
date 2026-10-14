import { afterEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "net";
import { DescriptionType, PeerConnection } from "node-datachannel";
import { WebSocket, WebSocketServer } from "ws";
import { iceServerUrls } from "../simstream-ice";
import { asksForKeyframe, bridgeSimstreamRtp, parameterSets, parseControlMessage, parseSignalMessage } from "../simstream-rtp";

describe("simstream RTP bridge helpers", () => {
  test("turns an avcC box into length-prefixed SPS and PPS", () => {
    const sps = [0x67, 0x64, 0x00, 0x1f];
    const pps = [0x68, 0xee, 0x3c];
    // version, profile, compat, level, 0xff (4-byte lengths), 0xe1 (1 SPS), len, SPS, 1 PPS, len, PPS
    const avcC = Buffer.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, sps.length, ...sps, 1, 0, pps.length, ...pps]);
    expect([...parameterSets(avcC)]).toEqual([0, 0, 0, sps.length, ...sps, 0, 0, 0, pps.length, ...pps]);
  });

  test("spots a PLI or FIR anywhere in a compound RTCP packet", () => {
    const receiverReport = Buffer.from([0x80, 201, 0, 1, 0, 0, 0, 1]); // RR, no report blocks
    const pli = Buffer.from([0x81, 206, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2]); // PSFB fmt 1
    const fir = Buffer.from([0x84, 206, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2]); // PSFB fmt 4
    const remb = Buffer.from([0x8f, 206, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0]); // PSFB fmt 15: not a keyframe ask
    expect(asksForKeyframe(receiverReport)).toBe(false);
    expect(asksForKeyframe(Buffer.concat([receiverReport, pli]))).toBe(true);
    expect(asksForKeyframe(Buffer.concat([receiverReport, fir]))).toBe(true);
    expect(asksForKeyframe(Buffer.concat([receiverReport, remb]))).toBe(false);
  });

  test("passes serve-sim's STUN and TURN servers in node-datachannel's form", () => {
    expect(iceServerUrls([
      { urls: ["stun:stun.example.com:3478"] },
      { urls: ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"], username: "u@x", credential: "p:w" },
    ])).toEqual([
      "stun:stun.example.com:3478",
      "turn:u%40x:p%3Aw@turn.example.com:3478?transport=udp",
      "turns:u%40x:p%3Aw@turn.example.com:5349",
    ]);
    expect(iceServerUrls(undefined)).toEqual([]);
  });
});

describe("simstream RTP bridge messages", () => {
  test("accepts only well-formed signaling messages", () => {
    expect(parseSignalMessage('{"t":"sdp","sdp":"v=0","type":"answer"}')).toEqual({ t: "sdp", sdp: "v=0", type: "answer" as DescriptionType });
    expect(parseSignalMessage('{"t":"cand","candidate":"candidate:1"}')).toEqual({ t: "cand", candidate: "candidate:1", mid: "0" });
    expect(parseSignalMessage('{"t":"cand","candidate":"candidate:1","mid":"video"}')).toEqual({ t: "cand", candidate: "candidate:1", mid: "video" });
    for (const text of ["{", "null", "[]", '"sdp"', '{"t":"sdp","sdp":"v=0"}', '{"t":"sdp","sdp":"v=0","type":"bogus"}', '{"t":"sdp","sdp":1,"type":"answer"}', '{"t":"cand"}', '{"t":"cand","candidate":"c","mid":3}', '{"t":"other"}']) {
      expect(parseSignalMessage(text)).toBeNull();
    }
  });

  test("passes control messages to the engine and maps only numeric acks", () => {
    expect(parseControlMessage('{"t":"ack","rtp":90000}')).toEqual({ ack: 90000 });
    expect(parseControlMessage('{"t":"pause"}')).toEqual({ engine: '{"t":"pause"}' });
    for (const text of ["{", "null", "[]", "{}", '{"t":1}', '{"t":"ack"}', '{"t":"ack","rtp":"1"}', '{"t":"ack","rtp":1.5}']) {
      expect(parseControlMessage(text)).toBeNull();
    }
  });
});

describe("simstream RTP bridge isolation", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function listen() {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    cleanups.push(() => server.close());
    return { server, port: (server.address() as AddressInfo).port };
  }

  /**
   * A signaling server that bridges every connection, as the relay does. The engine accepts the
   * bridge and sends nothing, so a refused engine connection can't close a bridge first.
   */
  async function startRelay() {
    const engine = await listen();
    engine.server.on("connection", (socket) => cleanups.push(() => socket.terminate()));
    const relay = await listen();
    relay.server.on("connection", (signal) => bridgeSimstreamRtp(signal, engine.port, []));
    return `ws://127.0.0.1:${relay.port}`;
  }

  /** A viewer's signaling socket that has received the bridge's offer. */
  async function connectViewer(url: string) {
    const socket = new WebSocket(url);
    cleanups.push(() => socket.terminate());
    const messages: Array<{ t: string; sdp?: string; type?: string; candidate?: string; mid?: string; message?: string }> = [];
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    const offer = new Promise<void>((resolve) => socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as (typeof messages)[number];
      messages.push(message);
      if (message.t === "sdp") resolve();
    }));
    await offer;
    return { socket, messages, closed };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  test("a malformed signaling message closes only its own bridge", async () => {
    const url = await startRelay();
    const broken = await connectViewer(url);
    const other = await connectViewer(url);
    broken.socket.send("{");
    expect(await broken.closed).toBe(1008);
    expect(broken.messages.at(-1)).toEqual({ t: "error", message: "malformed signaling message" });
    await settle();
    expect(other.socket.readyState).toBe(WebSocket.OPEN);
    // The relay still bridges new viewers.
    const next = await connectViewer(url);
    expect(next.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("an SDP the peer connection rejects closes only its own bridge", async () => {
    const url = await startRelay();
    const broken = await connectViewer(url);
    const other = await connectViewer(url);
    broken.socket.send(JSON.stringify({ t: "sdp", sdp: "not an sdp", type: "answer" }));
    expect(await broken.closed).toBe(1008);
    expect(broken.messages.at(-1)?.t).toBe("error");
    await settle();
    expect(other.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("a malformed control message closes only its own bridge", async () => {
    const url = await startRelay();
    const other = await connectViewer(url);
    const broken = await connectViewer(url);
    // Answer the bridge as a browser would, then send garbage on its "ctl" data channel.
    const browser = new PeerConnection("browser", { iceServers: [] });
    cleanups.push(() => browser.close());
    browser.onLocalDescription((sdp, type) => broken.socket.send(JSON.stringify({ t: "sdp", sdp, type })));
    browser.onLocalCandidate((candidate, mid) => broken.socket.send(JSON.stringify({ t: "cand", candidate, mid })));
    browser.onDataChannel((channel) => channel.onOpen(() => channel.sendMessage("{")));
    broken.socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { t: string; candidate?: string; mid?: string };
      if (message.t === "cand") browser.addRemoteCandidate(message.candidate!, message.mid!);
    });
    const offer = broken.messages.find((message) => message.t === "sdp")!;
    browser.setRemoteDescription(offer.sdp!, offer.type as DescriptionType);
    for (const message of broken.messages) {
      if (message.t === "cand") browser.addRemoteCandidate(message.candidate!, message.mid!);
    }
    expect(await broken.closed).toBe(1008);
    expect(broken.messages.at(-1)).toEqual({ t: "error", message: "malformed control message" });
    await settle();
    expect(other.socket.readyState).toBe(WebSocket.OPEN);
  }, 10_000);
});
