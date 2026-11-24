import { describe, expect, test } from "bun:test";
import { isSimctlTimeout, simctl, simctlRaw, simctlSync } from "../simctl";
import { PasteboardTooLargeError } from "../sim-pasteboard";
import { PasteboardUnavailableError, readSimPasteboardResult } from "../sim-pasteboard-reader";
import { withShimsAsync } from "./helpers";

describe("simctl", () => {
  test("keeps the existing trimmed result", async () => {
    await withShimsAsync({ xcrun: "#!/bin/sh\nprintf '  value\\n\\n'\n" }, async () => {
      expect(await simctl(["list"])).toBe("value");
    });
  });

  test("can preserve clipboard whitespace and set its locale", async () => {
    await withShimsAsync(
      { xcrun: "#!/bin/sh\nprintf '%s\\n' \"$LANG|$LC_ALL\"\nprintf 'café  \\n\\n'\n" },
      async () => {
        expect(
          await simctlRaw(["pbpaste", "DEVICE"], {
            env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
          }),
        ).toBe("en_US.UTF-8|en_US.UTF-8\ncafé  \n\n");
      },
    );
  });

  test.each(["", "printf 'diagnostic\\n' >&2\n"])(
    "preserves oversized clipboard errors with stderr %p",
    async (stderr) => {
      await withShimsAsync(
        { xcrun: `#!/bin/sh\n${stderr}head -c 4194305 /dev/zero\n` },
        async () => {
          await expect(readSimPasteboardResult("DEVICE")).rejects.toBeInstanceOf(
            PasteboardTooLargeError,
          );
        },
      );
    },
  );

  test("does not treat oversized stderr as oversized clipboard text", async () => {
    await withShimsAsync(
      { xcrun: "#!/bin/sh\nprintf x\nhead -c 4194305 /dev/zero >&2\n" },
      async () => {
        const error = await readSimPasteboardResult("DEVICE").catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(PasteboardTooLargeError);
        expect(error).toBeInstanceOf(PasteboardUnavailableError);
      },
    );
  });

  test("reports stderr for an ordinary command failure and keeps the exit status", async () => {
    await withShimsAsync({ xcrun: "#!/bin/sh\nprintf 'diagnostic\\n' >&2\nexit 3\n" }, async () => {
      const error = await simctlRaw(["list"]).catch((error: unknown) => error);
      expect((error as Error).message).toBe("simctl list: diagnostic");
      expect(((error as Error).cause as { code?: unknown } | undefined)?.code).toBe(3);
    });
  });

  test("names the command and its limit when a call times out", async () => {
    await withShimsAsync({ xcrun: "#!/bin/sh\nexec sleep 10\n" }, async () => {
      const args = ["spawn", "DEVICE", "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"];
      const error = await simctlRaw(args, 1_000).catch((error: unknown) => error);
      expect((error as Error).message).toBe(
        "xcrun simctl spawn DEVICE launchctl getenv DYLD_INSERT_LIBRARIES timed out after 1 s",
      );
      // Callers such as the boot wait still recognize the timeout.
      expect(error).toHaveProperty("killed", true);
      expect(() => simctlSync(args, 1_000)).toThrow(
        "xcrun simctl spawn DEVICE launchctl getenv DYLD_INSERT_LIBRARIES timed out after 1 s",
      );
    });
  });

  test("recognizes a timeout by the error object, even with a newline in an argument", async () => {
    await withShimsAsync({ xcrun: "#!/bin/sh\nexec sleep 10\n" }, async () => {
      const error = await simctlRaw(["launch", "DEVICE", "app", "first\nsecond"], 500).catch(
        (error: unknown) => error,
      );
      expect(isSimctlTimeout(error)).toBe(true);
      expect(isSimctlTimeout(new Error((error as Error).message))).toBe(false);
    });
  });

  test("does not call a terminated command without a time limit a timeout", async () => {
    await withShimsAsync({ xcrun: "#!/bin/sh\nkill -TERM $$\n" }, async () => {
      for (const failed of [
        await simctlRaw(["list"], 0).catch((error: unknown) => error),
        (() => {
          try {
            simctlSync(["list"], 0);
          } catch (error) {
            return error;
          }
        })(),
      ]) {
        expect(failed).toBeInstanceOf(Error);
        expect((failed as Error).message).not.toContain("timed out");
      }
    });
  });

  test.each([
    ["an exit with stderr", "printf 'diagnostic\\n' >&2\nexit 3\n", undefined],
    ["an exit without stderr", "exit 3\n", undefined],
    ["oversized stderr", "head -c 4194305 /dev/zero >&2\n", undefined],
    ["a timeout", "exec sleep 10\n", 1_500],
  ] as const)(
    "keeps clipboard text out of the error after %s",
    async (_failure, script, timeout) => {
      await withShimsAsync(
        { xcrun: `#!/bin/sh\nprintf 'clipboard-secret'\n${script}` },
        async () => {
          const error = await simctlRaw(["pbpaste", "DEVICE"], timeout).catch(
            (error: unknown) => error,
          );
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toHaveProperty("stdout");
          expect((error as Error).cause ?? {}).not.toHaveProperty("stdout");
          expect(Bun.inspect(error)).not.toContain("clipboard-secret");
        },
      );
    },
  );
});
