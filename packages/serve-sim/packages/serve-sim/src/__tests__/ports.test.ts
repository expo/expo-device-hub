import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { findOwnListeners } from "../ports";
import { recordState, useTempStateDir } from "./helpers";

const PORT = 3461;

function spawnNode(script: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.once("data", () => resolve(child));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`child exited early (${code})`)));
  });
}

let listener: ChildProcess;
let client: ChildProcess;
let forgetListener: () => void;
let tempState: ReturnType<typeof useTempStateDir>;

beforeAll(async () => {
  tempState = useTempStateDir();
  listener = await spawnNode(
    `const net = require("net");
     const srv = net.createServer((s) => s.pipe(s));
     srv.listen(${PORT}, "127.0.0.1", () => console.log("ready"));`,
  );
  forgetListener = recordState("PORTS-TEST-LISTENER", listener.pid!, PORT);
  client = await spawnNode(
    `const net = require("net");
     const s = net.connect(${PORT}, "127.0.0.1", () => console.log("connected"));
     s.on("error", () => {});
     setInterval(() => {}, 1000);`,
  );
});

afterAll(() => {
  client?.kill("SIGKILL");
  listener?.kill("SIGKILL");
  forgetListener?.();
  tempState?.restore();
});

describe("findOwnListeners", () => {
  test("returns the listener pid", () => {
    expect(findOwnListeners(PORT)).toContain(listener.pid!);
  });

  test("does not return pids of connected clients", () => {
    expect(findOwnListeners(PORT)).not.toContain(client.pid!);
  });
});
