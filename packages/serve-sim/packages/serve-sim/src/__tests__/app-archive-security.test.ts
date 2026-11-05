import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { c as createTar, Header } from "tar";
import { iterableToStream, tar as packTar, TarFile } from "multitars";
import { prepareAppInstall } from "../app-install-worker";

function header(
  name: string,
  type: "File" | "Directory" | "SymbolicLink" | "Link" | "ExtendedHeader" | "GlobalExtendedHeader",
  size = 0,
  target?: string,
) {
  const value = new Header({ path: name, type, size, linkpath: target, mode: 0o700 });
  value.encode();
  return Buffer.from(value.block!);
}
function checksum(block: Buffer) {
  block.fill(32, 148, 156);
  const sum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return block;
}
function padded(body: string) {
  const value = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  value.write(body);
  return value;
}
const tail = () => [header("Test.app/Info.plist", "File", 5), padded("plist"), Buffer.alloc(1024)];

test("node-tar PAX metadata preserves an executable with a Unicode name", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-archive-pax-mode-"));
  try {
    await mkdir(join(root, "Café.app"));
    await writeFile(join(root, "Café.app", "Café"), "executable", { mode: 0o755 });
    await writeFile(join(root, "Café.app", "Info.plist"), "plist");
    const archive = join(root, "input.tgz");
    await createTar({ cwd: root, gzip: true, file: archive }, ["Café.app"]);
    const app = await prepareAppInstall(archive, join(root, "extracted"));
    expect((await stat(join(app, "Café"))).mode & 0o100).toBe(0o100);
    expect(await readFile(join(app, "Café"), "utf8")).toBe("executable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multitars preserves an executable path longer than the USTAR fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-archive-long-mode-"));
  try {
    const name = `Test.app/${"nested/".repeat(36)}executable`;
    expect(Buffer.byteLength(name)).toBeGreaterThan(255);
    const file = TarFile.from(new Blob(["executable"]).stream(), name, { size: 10 });
    file.mode = 0o700;
    const archive = join(root, "input.tgz");
    const bytes = await new Response(iterableToStream(packTar([file]))).arrayBuffer();
    await writeFile(archive, gzipSync(new Uint8Array(bytes)));
    const directory = join(root, "extracted");
    await prepareAppInstall(archive, directory);
    expect((await stat(join(directory, name))).mode & 0o100).toBe(0o100);
    expect(await readFile(join(directory, name), "utf8")).toBe("executable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a metadata header's USTAR prefix does not change the next file's path", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-archive-pax-prefix-"));
  try {
    // macOS tar can split a PAX header's name even when the real file's name
    // fits in the following header without a prefix.
    const metadata = header("PaxHeader/file", "ExtendedHeader", 13);
    metadata.write("metadata-parent", 345, "utf8");
    const archive = join(root, "input.tgz");
    await writeFile(
      archive,
      gzipSync(Buffer.concat([checksum(metadata), padded("13 comment=x\n"), ...tail()])),
    );
    const app = await prepareAppInstall(archive, join(root, "extracted"));
    expect(app).toBe(join(root, "extracted", "Test.app"));
    expect(await readFile(join(app, "Info.plist"), "utf8")).toBe("plist");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["ExtendedHeader", "GlobalExtendedHeader"] as const)(
  "%s still applies an explicit PAX mode override",
  async (type) => {
    const root = await mkdtemp(join(tmpdir(), "app-archive-pax-override-"));
    try {
      const archive = join(root, "input.tgz");
      await writeFile(
        archive,
        gzipSync(Buffer.concat([header("pax", type, 12), padded("12 mode=384\n"), ...tail()])),
      );
      const app = await prepareAppInstall(archive, join(root, "extracted"));
      expect((await stat(join(app, "Info.plist"))).mode & 0o100).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("binary macOS extended attributes do not change TAR framing", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-archive-xattr-"));
  try {
    const body = Buffer.concat([
      Buffer.from(" SCHILY.xattr.com.apple.FinderInfo="),
      Buffer.from([255, 254, 0]),
      Buffer.from("\n"),
    ]);
    let length = body.length + 1;
    while (length !== body.length + String(length).length)
      length = body.length + String(length).length;
    const record = Buffer.concat([Buffer.from(String(length)), body]);
    const padding = Buffer.alloc(Math.ceil(record.length / 512) * 512);
    record.copy(padding);
    const file = join(root, "input.tgz");
    await writeFile(
      file,
      gzipSync(Buffer.concat([header("pax", "ExtendedHeader", record.length), padding, ...tail()])),
    );
    expect(await prepareAppInstall(file, join(root, "extracted"))).toBe(
      join(root, "extracted/Test.app"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function rejectsArchive(blocks: Buffer[], message: RegExp) {
  const root = await mkdtemp(join(tmpdir(), "app-archive-security-"));
  try {
    const file = join(root, "input.tgz");
    await writeFile(file, gzipSync(Buffer.concat(blocks)));
    await expect(prepareAppInstall(file, join(root, "extracted"))).rejects.toThrow(message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.each([
  ["case", "S", "s"],
  ["Unicode normalization", "Róot", "Ro\u0301ot"],
])("archive links reject %s aliases before filesystem lookup", async (_kind, name, alias) => {
  await rejectsArchive(
    [
      header("Test.app/", "Directory"),
      header("Test.app/d1/d2/d3/", "Directory"),
      header(`Test.app/d1/d2/d3/${name}`, "SymbolicLink", 0, "../../../.."),
      header("Test.app/d1/d2/d3/t", "SymbolicLink", 0, `${alias}/../../../../..`),
      ...tail(),
    ],
    /unsafe link/,
  );
});

test.each(["missing", "Info.plist"])(
  "archive links cannot traverse %s as a directory",
  async (component) => {
    await rejectsArchive(
      [
        ...tail().slice(0, -1),
        header("Test.app/link", "SymbolicLink", 0, `${component}/../Info.plist`),
        Buffer.alloc(1024),
      ],
      /unsafe link/,
    );
  },
);

test.each([
  ["case", "S", "s", "T", "t"],
  ["Unicode normalization", "é", "e\u0301", "è", "e\u0300"],
  ["full case folding", "ß", "ss", "T", "t"],
])(
  "link parents cannot redirect extraction through %s aliases",
  async (_kind, name, alias, upper, lower) => {
    for (const linksFirst of [false, true]) {
      const root = await mkdtemp(join(tmpdir(), "app-archive-parent-"));
      const directory = join(root, "a", "extracted");
      try {
        await mkdir(join(root, "a"));
        await mkdir(join(root, "x"));
        await mkdir(join(root, "probe"));
        await mkdir(join(root, "probe", name));
        await mkdir(join(root, "probe", upper));
        const aliasesCollide =
          existsSync(join(root, "probe", alias)) && existsSync(join(root, "probe", lower));
        const links = [
          header(`Test.app/${name}`, "SymbolicLink", 0, ".."),
          header(`Test.app/${alias}/${lower}`, "SymbolicLink", 0, "../../x"),
          header(`Test.app/${alias}/${upper}/w`, "Link", 0, "Test.app/Info.plist"),
        ];
        const file = join(root, "input.tgz");
        await writeFile(
          file,
          gzipSync(
            Buffer.concat([
              header("x/", "Directory"),
              ...(linksFirst ? [...links].reverse() : []),
              ...tail().slice(0, -1),
              ...(linksFirst ? [] : links),
              Buffer.alloc(1024),
            ]),
          ),
        );
        let failure: unknown;
        try {
          await prepareAppInstall(file, directory);
        } catch (error) {
          failure = error;
        }
        // Match install cleanup, then check the sibling the alias used to reach.
        await rm(directory, { recursive: true, force: true });
        expect(existsSync(join(root, "x", "w"))).toBe(false);
        if (aliasesCollide) {
          expect(failure).toBeInstanceOf(Error);
          expect((failure as Error).message).toBe("App archive contains conflicting entries.");
        } else {
          // Distinct names on a case-sensitive filesystem are safe to extract.
          expect(failure).toBeUndefined();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

// Only 2 MiB is needed to prove the 1 MiB metadata cap was bypassed. The parser
// sees the PAX header while the gate sees it as body data, then a fake file header.
const METADATA_BYTES = 2 * 1024 ** 2;
const hiddenMetadata = () => [
  header("pax", "ExtendedHeader", METADATA_BYTES),
  Buffer.alloc(512),
  header("Test.app/fake", "File", METADATA_BYTES - 1024),
  Buffer.alloc(METADATA_BYTES - 1024),
  ...tail(),
];

test("leading NULs cannot hide a TAR size from the metadata gate", async () => {
  const ambiguous = header("Test.app/a", "File");
  ambiguous.fill(0, 124, 136);
  ambiguous.write("1000", 131, "ascii");
  await rejectsArchive(
    [checksum(ambiguous), header("Test.app/b", "File", 1024), ...hiddenMetadata()],
    /invalid header/,
  );
});

test.each(["6 abc\n13 size=1024\n", "0x1a ignored=" + "x".repeat(12) + "\n13 size=1024\n"])(
  "malformed PAX records cannot hide later headers: %s",
  async (record) => {
    await rejectsArchive(
      [
        header("pax", "ExtendedHeader", Buffer.byteLength(record)),
        padded(record),
        header("Test.app/a", "File"),
        ...hiddenMetadata(),
      ],
      /invalid metadata/,
    );
  },
);

test("a global PAX size supersedes an earlier local override", async () => {
  await rejectsArchive(
    [
      header("local", "ExtendedHeader", 13),
      padded("13 size=1024\n"),
      header("global", "GlobalExtendedHeader", 10),
      padded("10 size=0\n"),
      header("Test.app/a", "File"),
      ...hiddenMetadata(),
    ],
    /metadata exceeds the size limit/,
  );
});
