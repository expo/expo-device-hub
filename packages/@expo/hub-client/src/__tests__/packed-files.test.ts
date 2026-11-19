import { describe, expect, test } from "bun:test";

import { FILES } from "./glb-fixtures";
import { entryPointFiles, packedFileProblems, readManifest } from "./packed-files";

const manifest = readManifest();
// A package with every entry point's file, source, and the models' README.
const complete = [...entryPointFiles(manifest), "src/index.ts", "models/README.md", "package.json"];

describe("the package content check", () => {
  test("the entry points name the build output of both models entries and every GLB file", () => {
    const files = entryPointFiles(manifest);
    for (const file of [
      "dist/index.mjs",
      "dist/index.d.ts",
      "dist/models/index.mjs",
      "dist/models/index.d.ts",
      "dist/models/catalog.mjs",
      "dist/models/catalog.d.ts",
      "models/glb.d.ts",
      ...Object.values(FILES).map((file) => `models/${file}`),
    ]) {
      expect(files).toContain(file);
    }
  });

  test("a package with every entry point's file has no problems", () => {
    expect(packedFileProblems(manifest, complete)).toEqual([]);
  });

  test("an entry point's file that is not packed is a problem", () => {
    for (const absent of ["models/iphone-duo.glb", "dist/models/catalog.d.ts", "models/glb.d.ts"]) {
      const problems = packedFileProblems(
        manifest,
        complete.filter((path) => path !== absent),
      );
      expect(problems.some((problem) => problem.includes(absent))).toBe(true);
    }
  });

  test('a "files" entry that matches nothing is a problem', () => {
    const noModels = complete.filter((path) => !path.endsWith(".glb"));
    expect(packedFileProblems(manifest, noModels)).toContain(
      `"files" has models/*.glb, which matches no packed file.`,
    );
    const noBuild = complete.filter((path) => !path.startsWith("dist/"));
    expect(packedFileProblems(manifest, noBuild)).toContain(
      `"files" has dist, which matches no packed file.`,
    );
    // A pattern matches in its own directory only, and a name is not a prefix.
    const moved = packedFileProblems({ ...manifest, files: ["models/*.glb", "dist"] }, [
      "models/old/iphone-duo.glb",
      "distribution/index.mjs",
    ]);
    expect(moved).toContain(`"files" has models/*.glb, which matches no packed file.`);
    expect(moved).toContain(`"files" has dist, which matches no packed file.`);
  });

  test("a packed test file is a problem", () => {
    expect(
      packedFileProblems(manifest, [...complete, "src/__tests__/device-screen.test.tsx"]),
    ).toEqual([
      `"files" excludes src/__tests__, but src/__tests__/device-screen.test.tsx is packed.`,
      "src/__tests__/device-screen.test.tsx is a test file.",
    ]);
    expect(packedFileProblems(manifest, [...complete, "dist/__tests__/fixtures/a.mjs"])).toEqual([
      "dist/__tests__/fixtures/a.mjs is a test file.",
    ]);
  });
});
