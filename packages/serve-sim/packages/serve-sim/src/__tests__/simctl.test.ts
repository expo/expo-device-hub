import { describe, expect, test } from "bun:test";
import { simctl, simctlRaw } from "../simctl";
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
});
