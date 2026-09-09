import { describe, expect, test } from "bun:test";
import {
  isWorkerEvent,
  parseWorkerCommand,
  parseWorkerEvent,
  type WorkerCommand,
  type WorkerEvent,
} from "../src/shared/worker-contracts.ts";

function commandName(command: WorkerCommand): string {
  switch (command.type) {
    case "init":
    case "connect":
    case "send":
    case "stop":
      return command.type;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function eventName(event: WorkerEvent): string {
  switch (event.type) {
    case "status":
    case "session":
    case "rendered":
    case "stats":
      return event.type;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

describe("worker contracts", () => {
  test("parses all commands without a DOM canvas type", () => {
    const canvas = { kind: "canvas" };
    const isCanvas = (value: unknown): value is typeof canvas =>
      typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "canvas";
    const commands = [
      parseWorkerCommand({ type: "init", canvas, url: "ws://localhost/ws" }, isCanvas),
      parseWorkerCommand({ type: "connect" }),
      parseWorkerCommand({ type: "send", text: "{}" }),
      parseWorkerCommand({ type: "stop" }),
    ];
    expect(commands.map(commandName)).toEqual(["init", "connect", "send", "stop"]);
    expect(() => parseWorkerCommand({ type: "init", canvas: null, url: "ws://localhost/ws" })).toThrow(
      "canvas",
    );
  });

  test("parses every event and validates stats", () => {
    const events = [
      parseWorkerEvent({ type: "status", status: "streaming" }),
      parseWorkerEvent({ type: "session", size: { width: 720, height: 1280 } }),
      parseWorkerEvent({ type: "rendered" }),
      parseWorkerEvent({
        type: "stats",
        stats: {
          fps: 60,
          decodeQueue: 2,
          transitMs: 3.2,
          e2eMs: null,
          codec: "avc1.640028",
          rendered: true,
        },
      }),
    ];
    expect(events.map(eventName)).toEqual(["status", "session", "rendered", "stats"]);
    expect(isWorkerEvent({ type: "stats", stats: { fps: Number.NaN } })).toBe(false);
  });
});
