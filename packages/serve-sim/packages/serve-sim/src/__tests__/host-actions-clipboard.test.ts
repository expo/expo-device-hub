import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { describeHostActions, runHostActionAsync } from "../host-actions";
import * as pasteboard from "../sim-pasteboard";
import * as reader from "../sim-pasteboard-reader";
import * as sessions from "../device-session";
import { UDID } from "./helpers";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});
const run = (action: string, params = {}) =>
  runHostActionAsync({ action, params: { udid: UDID, ...params } }, "false");

describe("clipboard host actions", () => {
  test("advertises text input and optional paste text", () => {
    const catalog = describeHostActions();
    expect(catalog["clipboard.write"]).toMatchObject({
      required: ["udid", "text"],
      properties: { text: { type: "string" } },
    });
    expect(catalog["clipboard.paste"]).toMatchObject({ required: ["udid"] });
    for (const name of ["read", "write", "copy", "paste"])
      expect(catalog[`clipboard.${name}`]).toBeDefined();
  });

  test("returns read text as JSON without trimming or interpreting it", async () => {
    const text = ' \n{"a":true}\n\t';
    const read = spyOn(reader, "readSimPasteboardResult").mockResolvedValue({
      text,
      cleanupWarning: "cleanup warning",
    });
    restores.push(() => read.mockRestore());
    const result = await run("clipboard.read", { udid: UDID.toLowerCase() });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ text, cleanupWarning: "cleanup warning" });
    expect(read).toHaveBeenCalledWith(UDID);
  });

  test("writes empty and multiline Unicode text without putting it in argv", async () => {
    const write = spyOn(pasteboard, "writeSimPasteboard").mockResolvedValue(undefined);
    restores.push(() => write.mockRestore());
    for (const text of ["", " \n🦆\n'$(echo nope)' "]) {
      expect((await run("clipboard.write", { text })).exitCode).toBe(0);
      expect(write).toHaveBeenLastCalledWith(UDID, text);
    }
  });

  test("validates a single device and the UTF-8 byte limit before IO", async () => {
    for (const action of [
      "clipboard.read",
      "clipboard.write",
      "clipboard.copy",
      "clipboard.paste",
    ]) {
      await expect(run(action, { udid: "booted", text: "" })).rejects.toThrow("udid");
    }
    for (const action of ["clipboard.write", "clipboard.paste"]) {
      await expect(
        run(action, { text: "🦆".repeat(pasteboard.MAX_PASTEBOARD_TEXT_BYTES / 4 + 1) }),
      ).rejects.toThrow("text");
    }
    await expect(run("clipboard.write")).rejects.toThrow("text");
  });

  test("reports a failed input session for copy and paste", async () => {
    const get = spyOn(sessions, "getDeviceSession").mockImplementation(() => {
      throw new Error("Device is not booted");
    });
    restores.push(() => get.mockRestore());
    for (const action of ["clipboard.copy", "clipboard.paste"]) {
      expect(await run(action)).toMatchObject({ exitCode: 1, stderr: "Device is not booted" });
    }
  });

  test("uses the session copy and paste paths and preserves warnings", async () => {
    const session = Object.create(sessions.DeviceSession.prototype) as sessions.DeviceSession;
    const copy = spyOn(session, "copyPasteboard").mockResolvedValue({
      text: " \n",
      cleanupWarning: "held key",
    });
    const paste = spyOn(session, "pastePasteboard").mockResolvedValue("held key");
    const get = spyOn(sessions, "getDeviceSession").mockReturnValue(session);
    restores.push(
      () => copy.mockRestore(),
      () => paste.mockRestore(),
      () => get.mockRestore(),
    );
    expect(JSON.parse((await run("clipboard.copy")).stdout)).toEqual({
      text: " \n",
      cleanupWarning: "held key",
    });
    for (const text of [undefined, ""]) {
      expect(
        JSON.parse((await run("clipboard.paste", text === undefined ? {} : { text })).stdout),
      ).toEqual({ ok: true, cleanupWarning: "held key" });
      expect(paste).toHaveBeenLastCalledWith(text);
      expect(get).toHaveBeenLastCalledWith(UDID, undefined);
    }
    copy.mockRejectedValue(
      Object.assign(new Error("Copy timed out"), { cleanupWarning: "held key" }),
    );
    const failure = await run("clipboard.copy");
    expect(failure.exitCode).toBe(1);
    expect(failure.stderr).toContain("Copy timed out");
    expect(failure.stderr).toContain("held key");
  });
});
