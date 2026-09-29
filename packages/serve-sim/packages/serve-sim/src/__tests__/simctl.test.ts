import { describe, expect, test } from "bun:test";
import { simctl, simctlRaw } from "../simctl";
import { PasteboardTooLargeError } from "../sim-pasteboard";
import { readSimPasteboardResult } from "../sim-pasteboard-reader";
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

  test.each(["", "printf 'diagnostic\\n' >&2\n"])("preserves oversized clipboard errors with stderr %p", async (stderr) => {
    await withShimsAsync({ xcrun: `#!/bin/sh\n${stderr}head -c 4194305 /dev/zero\n` }, async () => {
      await expect(readSimPasteboardResult("DEVICE")).rejects.toBeInstanceOf(PasteboardTooLargeError);
    });
  });

  test("does not treat oversized stderr as oversized clipboard text", async () => {
    await withShimsAsync({ xcrun: "#!/bin/sh\nprintf x\nhead -c 4194305 /dev/zero >&2\n" }, async () => {
      const error = await readSimPasteboardResult("DEVICE").catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PasteboardTooLargeError);
      expect((error as Error).message).toContain("stderr maxBuffer length exceeded");
    });
  });

  test("reports stderr for an ordinary command failure", async () => {
    await withShimsAsync({ xcrun: "#!/bin/sh\nprintf 'diagnostic\\n' >&2\nexit 1\n" }, async () => {
      await expect(simctlRaw(["list"])).rejects.toThrow("diagnostic");
    });
  });
});
