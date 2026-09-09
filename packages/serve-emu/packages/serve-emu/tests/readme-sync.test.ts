import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GENERATED_README_NOTICE,
  checkPackageReadme,
  renderPackageReadme,
} from "../scripts/sync-readme.ts";

const REPOSITORY_DIR = resolve(import.meta.dir, "../../..");
const PACKAGE_DIR = resolve(import.meta.dir, "..");
const ROOT_README_PATH = resolve(REPOSITORY_DIR, "README.md");
const PACKAGE_README_PATH = resolve(PACKAGE_DIR, "README.md");
const PACKAGE_JSON_PATH = resolve(PACKAGE_DIR, "package.json");

function localMarkdownLinks(markdown: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    if (
      target === "" ||
      target.startsWith("#") ||
      /^[a-z][a-z\d+.-]*:/i.test(target)
    ) {
      continue;
    }
    const path = target.split("#", 1)[0];
    if (path) links.push(decodeURIComponent(path));
  }
  return links;
}

describe("package README generation", () => {
  test("rewrites repository links for the packed package deterministically", () => {
    const root = [
      "# Example",
      "",
      "[`packages/serve-emu/package.json`](packages/serve-emu/package.json)",
      "[`packages/serve-emu/CHANGELOG.md`](packages/serve-emu/CHANGELOG.md)",
      "[protocol](packages/serve-emu/docs/protocol.md)",
      "[contributing](CONTRIBUTING.md)",
      "Vendored at `packages/serve-emu/vendor/`.",
      "",
    ].join("\n");

    expect(renderPackageReadme(root)).toBe(
      [
        GENERATED_README_NOTICE,
        "",
        "# Example",
        "",
        "[`package.json`](package.json)",
        "[`CHANGELOG.md`](CHANGELOG.md)",
        "[protocol](docs/protocol.md)",
        "[contributing](https://github.com/expo/serve-emu/blob/main/CONTRIBUTING.md)",
        "Vendored at `vendor/`.",
        "",
      ].join("\n"),
    );
  });

  test("detects clean and intentionally stale generated content", () => {
    const root = "# Canonical\n";
    const generated = renderPackageReadme(root);

    expect(checkPackageReadme(root, generated)).toEqual({
      current: true,
      expected: generated,
    });
    expect(checkPackageReadme(root, `${generated}\nstale\n`).current).toBe(
      false,
    );
  });

  test("checked-in package README exactly matches the canonical root README", async () => {
    const [rootReadme, packageReadme] = await Promise.all([
      readFile(ROOT_README_PATH, "utf8"),
      readFile(PACKAGE_README_PATH, "utf8"),
    ]);

    expect(checkPackageReadme(rootReadme, packageReadme).current).toBe(true);
    expect(packageReadme.startsWith(`${GENERATED_README_NOTICE}\n\n`)).toBe(
      true,
    );
    expect(packageReadme).toContain(
      "[protocol reference](docs/protocol.md)",
    );
    expect(packageReadme).toContain(
      "[`CONTRIBUTING.md`](https://github.com/expo/serve-emu/blob/main/CONTRIBUTING.md)",
    );
  });

  test("all local root and package README links resolve in their own context", async () => {
    const readmes = [
      {
        path: ROOT_README_PATH,
        base: REPOSITORY_DIR,
      },
      {
        path: PACKAGE_README_PATH,
        base: PACKAGE_DIR,
      },
    ];

    for (const readme of readmes) {
      const markdown = await readFile(readme.path, "utf8");
      const missing = localMarkdownLinks(markdown).filter(
        (target) => !existsSync(resolve(readme.base, target)),
      );
      expect(missing).toEqual([]);
    }
  });

  test("the packed package includes the generated README link targets", async () => {
    const manifest = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8")) as {
      files?: unknown;
    };
    expect(Array.isArray(manifest.files)).toBe(true);
    if (!Array.isArray(manifest.files)) return;
    expect(manifest.files).toContain("README.md");
    expect(manifest.files).toContain("docs");
    expect(manifest.files).toContain("CHANGELOG.md");
  });
});
