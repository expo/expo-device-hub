// consumer.mjs: a direct capture socket consumer for the timing matrix.
//
// node consumer.mjs --capture <package dir> --socket <path> --out <prefix> --seconds <n>
//   [--role stream|recording] [--max-size N] [--fps N] [--bit-rate N] [--hello-only]
//
// Writes <prefix>.h264 (Annex B), <prefix>.frames.csv (arrival ms since start, agent pts in us,
// pts on the host clock in ms since start, bytes, key) and prints one JSON line with hello,
// configured records and counts. With --hello-only it prints hello and closes: a connection that
// sends no 'S' takes no role, so it measures the posts counter without capture.
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    capture: { type: "string" },
    socket: { type: "string" },
    out: { type: "string" },
    seconds: { type: "string", default: "33" },
    role: { type: "string", default: "stream" },
    "max-size": { type: "string", default: "0" },
    fps: { type: "string", default: "60" },
    "bit-rate": { type: "string", default: "12000000" },
    "hello-only": { type: "boolean", default: false },
  },
});
const protocol = await import(join(values.capture, "src/protocol.mjs"));
const start = performance.now();
const now = () => performance.now() - start;
const socket = createConnection(values.socket);
let h264 = null;
const rows = [];
const summary = { role: values.role, configured: [], frames: 0, keyFrames: 0, bytes: 0 };
let clockOffsetMs = null; // host ms since start = agent us / 1000 + offset

const reader = new protocol.RecordReader((record) => {
  if (record.flags === protocol.FLAGS.hello) {
    const hello = JSON.parse(record.payload.toString());
    summary.hello = {
      ...hello,
      width: record.width,
      height: record.height,
      atMs: now(),
      hostMs: Date.now(),
    };
    if (values["hello-only"]) {
      console.log(JSON.stringify(summary));
      socket.end();
      process.exit(0);
    }
    if (typeof hello.clockUs === "number") clockOffsetMs = now() - hello.clockUs / 1000;
    if (values.role === "recording") socket.write(protocol.roleCommand("recording"));
    socket.write(
      protocol.settingsCommand({
        maxSize: Number(values["max-size"]),
        fps: Number(values.fps),
        bitRate: Number(values["bit-rate"]),
      }),
    );
  } else if (record.flags === protocol.FLAGS.configured) {
    summary.configured.push({
      width: record.width,
      height: record.height,
      fps: record.fps,
      atMs: now(),
      details: JSON.parse(record.payload.toString()),
    });
  } else if (record.flags === protocol.FLAGS.frame || record.flags === protocol.FLAGS.keyFrame) {
    h264 ??= openSync(`${values.out}.h264`, "w");
    writeSync(h264, record.payload);
    const key = record.flags === protocol.FLAGS.keyFrame;
    const ptsUs = Number(record.pts);
    const ptsHostMs = clockOffsetMs === null ? "" : (ptsUs / 1000 + clockOffsetMs).toFixed(3);
    rows.push(`${now().toFixed(3)},${ptsUs},${ptsHostMs},${record.payload.length},${key ? 1 : 0}`);
    summary.frames++;
    if (key) summary.keyFrames++;
    summary.bytes += record.payload.length;
  } else if (record.flags === protocol.FLAGS.replaced) {
    summary.replaced = true;
  }
});
socket.on("data", (chunk) => reader.push(chunk));
socket.on("error", (error) => {
  summary.error = error.message;
});
setTimeout(
  () => {
    socket.end();
    if (h264 !== null) closeSync(h264);
    writeFileSync(`${values.out}.frames.csv`, rows.join("\n") + "\n");
    console.log(JSON.stringify(summary));
    process.exit(0);
  },
  Number(values.seconds) * 1000,
);
