import { describe, expect, test } from "bun:test";
import { shellEscape } from "../client/utils/exec";
import { HID_USAGE_BY_CODE } from "../client/utils/hid";
import {
  PBCOPY_INLINE_MAX,
  copyTextToSim,
  pbcopyCommand,
  readSimClipboard,
  pbpasteCommand,
  simPasteHidEvents,
} from "../client/utils/sim-clipboard";

const UTF8_ENV = "export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8";

describe("sim clipboard commands", () => {
  test("pbpaste pins UTF-8 and quotes the udid", () => {
    expect(pbpasteCommand("UDID-1")).toBe(
      `${UTF8_ENV}; xcrun simctl pbpaste ${shellEscape("UDID-1")}`,
    );
  });

  test("pbcopy quotes text so shell metacharacters stay literal", () => {
    const text = "it's 100% café";
    expect(pbcopyCommand("UDID-1", text)).toBe(
      `${UTF8_ENV}; printf '%s' ${shellEscape(text)} | xcrun simctl pbcopy ${shellEscape("UDID-1")}`,
    );
  });

  test("copyTextToSim inlines short text", async () => {
    const cmds: string[] = [];
    const ok = await copyTextToSim("UDID-1", "hello", async (cmd) => {
      cmds.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    expect(ok).toBe(true);
    expect(cmds).toEqual([pbcopyCommand("UDID-1", "hello")]);
  });

  test("copyTextToSim stages a temp file above the inline limit", async () => {
    const cmds: string[] = [];
    const text = "x".repeat(PBCOPY_INLINE_MAX + 1);
    const ok = await copyTextToSim("UDID-1", text, async (cmd) => {
      cmds.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    expect(ok).toBe(true);
    expect(cmds.some((c) => c.includes("base64 -d"))).toBe(true);
    expect(cmds.some((c) => c.includes("simctl pbcopy") && c.includes(" < "))).toBe(true);
    expect(cmds.some((c) => c.startsWith("rm -f "))).toBe(true);
    expect(cmds.some((c) => c.includes("printf '%s'"))).toBe(false);
  });

  test("copyTextToSim uses UTF-8 byte length for the inline limit", async () => {
    const cmds: string[] = [];
    const text = "你".repeat(Math.floor(PBCOPY_INLINE_MAX / 3) + 1);
    expect(text.length).toBeLessThanOrEqual(PBCOPY_INLINE_MAX);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(PBCOPY_INLINE_MAX);
    await copyTextToSim("UDID-1", text, async (cmd) => {
      cmds.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    expect(cmds.some((c) => c.includes("printf '%s'"))).toBe(false);
    expect(cmds.some((c) => c.includes("base64 -d"))).toBe(true);
  });
});

describe("sim paste HID", () => {
  const usage = (code: string): number => {
    const value = HID_USAGE_BY_CODE[code];
    if (value === undefined) throw new Error(`no HID usage for ${code}`);
    return value;
  };
  const ControlLeft = usage("ControlLeft");
  const ControlRight = usage("ControlRight");
  const MetaLeft = usage("MetaLeft");
  const MetaRight = usage("MetaRight");
  const KeyV = usage("KeyV");
  const held = (...usages: number[]): Set<number> => new Set(usages);

  test("taps Cmd+V when no modifiers are held", () => {
    expect(simPasteHidEvents(new Set())).toEqual([
      { type: "down", usage: MetaLeft },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
      { type: "up", usage: MetaLeft },
    ]);
  });

  test("only taps V when Command is already down", () => {
    expect(simPasteHidEvents(held(MetaLeft))).toEqual([
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
    ]);
    expect(simPasteHidEvents(held(MetaRight))).toEqual([
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
    ]);
  });

  test("releases Control before injecting Cmd+V", () => {
    expect(simPasteHidEvents(held(ControlLeft))).toEqual([
      { type: "up", usage: ControlLeft },
      { type: "down", usage: MetaLeft },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
      { type: "up", usage: MetaLeft },
    ]);
    expect(simPasteHidEvents(held(ControlLeft, ControlRight, MetaLeft))).toEqual([
      { type: "up", usage: ControlLeft },
      { type: "up", usage: ControlRight },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
    ]);
  });
});

describe("readSimClipboard", () => {
  test("returns stdout on success", async () => {
    const text = await readSimClipboard("UDID-1", async () => ({
      stdout: "café",
      stderr: "",
      exitCode: 0,
    }));
    expect(text).toBe("café");
  });

  test("explains the likely cause when pbpaste fails", async () => {
    const failing = readSimClipboard("UDID-1", async () => ({
      stdout: "",
      stderr: "device not booted",
      exitCode: 1,
    }));
    await expect(failing).rejects.toThrow(/booted/i);
  });
});
