import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const OWN_COPY = resolve(import.meta.dir, "../src/screenshot-artifacts.ts");
const SERVE_SIM_COPY = resolve(
  import.meta.dir,
  "../../../../serve-sim/packages/serve-sim/src/screenshot-artifacts.ts",
);

// @expo/serve-sim ships standalone with no workspace dependencies, so it carries its own copy.
test.skipIf(!existsSync(SERVE_SIM_COPY))(
  "screenshot-artifacts.ts matches the serve-sim copy byte for byte",
  async () => {
    expect(await readFile(OWN_COPY, "utf8")).toBe(await readFile(SERVE_SIM_COPY, "utf8"));
  },
);
