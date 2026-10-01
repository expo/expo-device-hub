import { describe, expect, test } from "bun:test";
import { iceServerUrls } from "../simstream-ice";
import { asksForKeyframe, parameterSets } from "../simstream-rtp";

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
