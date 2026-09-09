import { describe, expect, test } from "bun:test";
import { parseDetachState } from "./detach-state";

const STATE_LINE =
  '{"url":"http://127.0.0.1:3100","streamUrl":"http://127.0.0.1:3100/helper/AC78FEE5/stream.mjpeg",' +
  '"wsUrl":"ws://127.0.0.1:3100/helper/AC78FEE5/ws","port":3100,"device":"AC78FEE5"}';

describe("parseDetachState", () => {
  test("parses a clean state blob", () => {
    expect(parseDetachState<{ port: number }>(`${STATE_LINE}\n`).port).toBe(3100);
  });

  test("skips the port-reclaim notice the CLI prints ahead of the state", () => {
    // Captured verbatim from a flaking run: ports.ts logs this (with ANSI
    // colors) to stdout when --detach reclaims the default port from a server
    // the previous test was still tearing down.
    const stdout =
      "\x1b[90mPort 3100 busy, killing listener pid(s): 83620\x1b[0m\n" +
      `${STATE_LINE}\n`;
    expect(parseDetachState<{ device: string }>(stdout).device).toBe("AC78FEE5");
  });

  test("throws with the stdout in the message when no state JSON exists", () => {
    expect(() => parseDetachState("No device specified\n")).toThrow(/No device specified/);
  });
});
