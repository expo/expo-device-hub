import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { create, Header, Pax } from "tar";
import { runHostActionAsync } from "../host-actions";
import { UPLOAD_DIR, UPLOAD_ROOT } from "../host-paths";
import { readStagedUploadAsync, withStagedUploadSnapshotAsync } from "../upload-store";
import { UDID, installShims, withActionTimeoutAsync, withShimsAsync } from "./helpers";
const BIN = fileURLToPath(new URL("../../dist/serve-sim.js", import.meta.url));
let root: string;
let shims: ReturnType<typeof installShims>;
beforeAll(async () => {
  await mkdir(UPLOAD_DIR, { recursive: true });
  root = await mkdtemp(join(UPLOAD_DIR, "install-test-"));
  shims = installShims({
    xcrun:
      '#!/bin/sh\nprintf "%s\\n" "$3"\n[ -z "$SERVE_SIM_INSTALL_SLEEP" ] || sleep "$SERVE_SIM_INSTALL_SLEEP"\n[ -z "$SERVE_SIM_INSTALL_STARTED" ] || touch "$SERVE_SIM_INSTALL_STARTED"\nif [ -n "$SERVE_SIM_INSTALL_GATE" ]; then while [ ! -f "$SERVE_SIM_INSTALL_GATE" ]; do sleep 0.01; done; fi\ncat "$4/Info.plist"\nprintf "\\n%s\\n" "$4"\n[ -x "$4/App" ] || exit 9\nexit "${SERVE_SIM_INSTALL_EXIT:-0}"\n',
  });
});
afterAll(async () => {
  shims.restore();
  await rm(root, { recursive: true, force: true });
  delete process.env.SERVE_SIM_INSTALL_EXIT;
});
async function app(name = "My App.app") {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "Info.plist"), "test app");
  await writeFile(join(path, "App"), "executable");
  await chmod(join(path, "App"), 0o755);
  return path;
}
async function install(path: string) {
  return runHostActionAsync({ action: "app.install", params: { udid: UDID, path } }, BIN);
}
async function archive(name: string, paths: string[]) {
  const file = join(root, name);
  await create({ cwd: root, file, gzip: true }, paths);
  return file;
}
function installedPath(stdout: string) {
  return stdout.trim().split("\n").at(-1)!;
}
test("installs a direct app bundle", async () => {
  const bundle = await app();
  const result = await install(bundle);
  expect(result.exitCode).toBe(0);
  expect(installedPath(result.stdout)).toBe(bundle);
});
test.each(["Device.ipa", "Device.IPA", "Build.zip", "uploaded-without-extension"])(
  "rejects unsupported install files before invoking simctl: %s",
  async (name) => {
    const file = join(root, name);
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const started = join(root, `unsupported-${name}-started`);
    process.env.SERVE_SIM_INSTALL_STARTED = started;
    try {
      expect(await install(file)).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining(
          "Simulator installs require a Simulator .app bundle or .tar.gz/.tgz archive.",
        ),
      });
      expect(existsSync(started)).toBe(false);
    } finally {
      delete process.env.SERVE_SIM_INSTALL_STARTED;
    }
  },
);
test("rejects an extensionless staged ZIP upload before invoking simctl", async () => {
  const uploadId = "unsupported-staged-archive";
  const started = join(root, "unsupported-staged-started");
  await runHostActionAsync(
    {
      action: "upload.append",
      params: {
        uploadId,
        first: true,
        data: Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64"),
      },
    },
    BIN,
  );
  process.env.SERVE_SIM_INSTALL_STARTED = started;
  try {
    expect(
      await runHostActionAsync({ action: "app.install", params: { udid: UDID, uploadId } }, BIN),
    ).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Simulator installs require") });
    expect(existsSync(started)).toBe(false);
  } finally {
    delete process.env.SERVE_SIM_INSTALL_STARTED;
    await runHostActionAsync({ action: "upload.remove", params: { uploadId } }, BIN);
  }
});
test("installs tar.gz and extensionless uploaded archives, preserving executable bits and cleaning extraction", async () => {
  await app();
  for (const name of ["build.tar.gz", "build.tgz", "uploaded-file"]) {
    const result = await install(await archive(name, ["My App.app"]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test app");
    expect(existsSync(installedPath(result.stdout))).toBe(false);
  }
});
test("cleans extraction when simctl install fails", async () => {
  process.env.SERVE_SIM_INSTALL_EXIT = "7";
  try {
    const result = await install(await archive("failure.tgz", ["My App.app"]));
    expect(result.exitCode).toBe(7);
    expect(existsSync(installedPath(result.stdout))).toBe(false);
  } finally {
    delete process.env.SERVE_SIM_INSTALL_EXIT;
  }
});
test("finds a single app under wrapper folders but does not count nested watch apps", async () => {
  await app("Payload/Main.app");
  await app("Payload/Main.app/Watch/Watch.app");
  expect((await install(await archive("wrapper.tgz", ["Payload"]))).exitCode).toBe(0);
});
test("rejects archives with zero or multiple app bundles", async () => {
  await writeFile(join(root, "readme"), "no app");
  expect(await install(await archive("empty.tgz", ["readme"]))).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("exactly one .app"),
  });
  await app("Second.app");
  expect(await install(await archive("multiple.tgz", ["My App.app", "Second.app"]))).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("exactly one .app"),
  });
});
async function headerArchive(
  name: string,
  path: string,
  size = 0,
  type: "File" | "SymbolicLink" = "File",
  linkpath?: string,
) {
  const h = new Header({ path, size, type, mode: 0o644, linkpath });
  h.encode();
  const file = join(root, name);
  await writeFile(file, gzipSync(Buffer.concat([Buffer.from(h.block!), Buffer.alloc(1024)])));
  return file;
}
test("rejects traversal, absolute paths, and oversized archive entries before installing", async () => {
  for (const path of ["../escape.app/Info.plist", "/escape.app/Info.plist"]) {
    expect(await install(await headerArchive("bad-path.tgz", path))).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("unsafe"),
    });
  }
  expect(
    await install(await headerArchive("oversized.tgz", "Huge.app/data", 2 * 1024 ** 3 + 1)),
  ).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("size limit"),
  });
});
test("rejects links escaping extraction and supports internal bundle links", async () => {
  expect(
    await install(
      await headerArchive("bad-link.tgz", "My.app/link", 0, "SymbolicLink", "../../outside"),
    ),
  ).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("unsafe") });
  await symlink("App", join(root, "My App.app", "Internal"));
  expect((await install(await archive("internal-link.tgz", ["My App.app"]))).exitCode).toBe(0);
});
test("reports a malformed gzip archive without running install", async () => {
  const file = join(root, "corrupt.tgz");
  await writeFile(file, Buffer.from([0x1f, 0x8b, 1, 2, 3]));
  expect((await install(file)).exitCode).toBe(1);
});

test("queued archive installs share one action deadline and do not install after expiry", async () => {
  const file = await archive("deadline.tgz", ["My App.app"]);
  process.env.SERVE_SIM_INSTALL_SLEEP = "0.2";
  try {
    await withActionTimeoutAsync(30, async () => {
      const [first, second] = await Promise.all([install(file), install(file)]);
      expect(first.exitCode).not.toBe(0);
      expect(second).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("timed out") });
    });
  } finally {
    delete process.env.SERVE_SIM_INSTALL_SLEEP;
  }
});

test("removes partially extracted files after an unsafe later entry", async () => {
  const before = await readdir(UPLOAD_DIR);
  const chunks: Buffer[] = [];
  for (let n = 0; n < 100; n++) {
    const h = new Header({ path: `Partial.app/file-${n}`, type: "File", size: 1, mode: 0o644 });
    h.encode();
    chunks.push(Buffer.from(h.block!), Buffer.concat([Buffer.from("x"), Buffer.alloc(511)]));
  }
  const bad = new Header({ path: "../escape", type: "File", size: 0, mode: 0o644 });
  bad.encode();
  chunks.push(Buffer.from(bad.block!), Buffer.alloc(1024));
  const file = join(root, "partial.tgz");
  await writeFile(file, gzipSync(Buffer.concat(chunks)));
  expect((await install(file)).exitCode).toBe(1);
  await Bun.sleep(50);
  expect(
    (await readdir(UPLOAD_DIR)).filter(
      (name) => name.startsWith(".install-extract-") && !before.includes(name),
    ),
  ).toEqual([]);
});

test("keeps extracted entries owner-accessible for install and cleanup", async () => {
  const blocks: Buffer[] = [];
  for (const entry of [
    { path: "Locked.app/", type: "Directory" as const, mode: 0, body: "" },
    { path: "Locked.app/Info.plist", type: "File" as const, mode: 0, body: "test app" },
    { path: "Locked.app/App", type: "File" as const, mode: 0o111, body: "executable" },
  ]) {
    const body = Buffer.from(entry.body),
      h = new Header({ path: entry.path, type: entry.type, mode: entry.mode, size: body.length });
    h.encode();
    blocks.push(Buffer.from(h.block!), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  const file = join(root, "permissions.tgz");
  await writeFile(file, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
  const result = await install(file);
  expect(result.exitCode).toBe(0);
  expect(existsSync(installedPath(result.stdout))).toBe(false);
});

test("installs a highly compressible app below the expanded size limit", async () => {
  await app("Compressible.app");
  await writeFile(join(root, "Compressible.app", "zeros"), Buffer.alloc(20 * 1024 ** 2));
  const result = await install(await archive("compressible.tgz", ["Compressible.app"]));
  expect(result.exitCode, result.stderr).toBe(0);
});

test.each(["../../outside", "../../../etc/passwd", "folder/../../../../outside", "/etc/passwd"])(
  "rejects an escaping symlink target %s",
  async (target) => {
    expect(
      await install(
        await headerArchive("escaping-link.tgz", "My.app/link", 0, "SymbolicLink", target),
      ),
    ).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("unsafe") });
  },
);

test.each(["uploadId", "path"])(
  "staged %s installs exclude removal while waiting for extraction",
  async (source) => {
    const uploadId = `install-reader-${source}`;
    const bytes = await readFile(await archive(`queued-${source}.tgz`, ["My App.app"]));
    await runHostActionAsync(
      {
        action: "upload.append",
        params: { uploadId, first: true, data: bytes.toString("base64") },
      },
      BIN,
    );
    process.env.SERVE_SIM_INSTALL_SLEEP = "0.1";
    try {
      const first = install(await archive(`ahead-${source}.tgz`, ["My App.app"]));
      await Bun.sleep(30);
      const pending = runHostActionAsync(
        {
          action: "app.install",
          params: {
            udid: UDID,
            [source]: source === "path" ? join(UPLOAD_DIR, uploadId) : uploadId,
          },
        },
        BIN,
      );
      const removed = runHostActionAsync({ action: "upload.remove", params: { uploadId } }, BIN);
      const results = await Promise.all([first, pending, removed]);
      expect(
        results.map((result) => result.exitCode),
        results[1]?.stderr,
      ).toEqual([0, 0, 0]);
      expect(existsSync(join(UPLOAD_DIR, uploadId))).toBe(false);
    } finally {
      delete process.env.SERVE_SIM_INSTALL_SLEEP;
    }
  },
);

async function rawArchive(
  name: string,
  entries: Array<{
    path: string;
    type?:
      | "File"
      | "Directory"
      | "SymbolicLink"
      | "Link"
      | "FIFO"
      | "CharacterDevice"
      | "BlockDevice";
    body?: string;
    target?: string;
    mode?: number;
  }>,
  gzip = true,
) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const header = new Header({
      path: entry.path,
      type: entry.type ?? "File",
      size: body.length,
      mode: entry.mode ?? 0o755,
      linkpath: entry.target,
    });
    header.encode();
    blocks.push(Buffer.from(header.block!), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  const bytes = Buffer.concat([...blocks, Buffer.alloc(1024)]);
  const file = join(root, name);
  await writeFile(file, gzip ? gzipSync(bytes) : bytes);
  return file;
}
const bundleEntries = [
  { path: "Framework.app/Info.plist", body: "test app" },
  { path: "Framework.app/App", body: "executable" },
];

test.each([false, true])(
  "installs versioned framework links independent of order: %s",
  async (reverse) => {
    const prefix = "Framework.app/Frameworks/F.framework";
    const links = [
      { path: `${prefix}/Versions/Current`, type: "SymbolicLink" as const, target: "A" },
      { path: `${prefix}/F`, type: "SymbolicLink" as const, target: "Versions/Current/F" },
      { path: "Framework.app/links/only", type: "SymbolicLink" as const, target: "../Info.plist" },
      {
        path: "Framework.app/PlistCopy",
        type: "Link" as const,
        target: "Framework.app/Info.plist",
      },
    ];
    if (reverse) links.reverse();
    const archive = await rawArchive("framework.tgz", [
      ...bundleEntries,
      { path: `${prefix}/Versions/A/F`, body: "framework" },
      ...links,
    ]);
    const result = await install(archive);
    expect(result.exitCode, result.stderr).toBe(0);
  },
);

test("rejects a link chain escaping extraction before invoking simctl", async () => {
  const started = join(root, "chain-install-started");
  process.env.SERVE_SIM_INSTALL_STARTED = started;
  try {
    const result = await install(
      await rawArchive("chain.tgz", [
        ...bundleEntries,
        { path: "Framework.app/a/b/c/data", body: "fixture" },
        { path: "Framework.app/a/b/c/s", type: "SymbolicLink", target: "../../.." },
        { path: "Framework.app/a/b/c/t", type: "SymbolicLink", target: "s/../../canary" },
      ]),
    );
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("unsafe link") });
    expect(existsSync(started)).toBe(false);
  } finally {
    delete process.env.SERVE_SIM_INSTALL_STARTED;
  }
});

test("rejects plain tar renamed to tar.gz", async () => {
  const result = await install(await rawArchive("plain.tar.gz", bundleEntries, false));
  expect(result).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("Simulator installs require"),
  });
});

test("many pending entries cannot race rejected-link cleanup or hide its error", async () => {
  for (let iteration = 0; iteration < 5; iteration++) {
    const before = await readdir(UPLOAD_DIR);
    const result = await install(
      await rawArchive("many-files.tgz", [
        ...bundleEntries,
        ...Array.from({ length: 300 }, (_, i) => ({ path: `Framework.app/f${i}`, body: "x" })),
        { path: "Framework.app/bad", type: "SymbolicLink", target: "/outside" },
      ]),
    );
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("unsafe link") });
    expect(
      (await readdir(UPLOAD_DIR)).filter(
        (name) => name.startsWith(".install-extract-") && !before.includes(name),
      ),
    ).toEqual([]);
  }
});

test("an archive cannot make its extraction root writable by other users", async () => {
  const checking = installShims({ xcrun: '#!/bin/sh\nstat -f "%Lp" "$4/.."\n' });
  try {
    const result = await install(
      await rawArchive("root-mode.tgz", [
        { path: ".", type: "Directory", mode: 0o777 },
        ...bundleEntries,
      ]),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("700");
  } finally {
    checking.restore();
  }
});

test.each([false, true])(
  "hard-link chains resolve directly to the extracted file: %s",
  async (reverse) => {
    const links = [
      { path: "Framework.app/bin", type: "Link" as const, target: "Framework.app/alias" },
      { path: "Framework.app/alias", type: "Link" as const, target: "Framework.app/real" },
    ];
    if (reverse) links.reverse();
    const result = await install(
      await rawArchive("hard-chain.tgz", [
        ...bundleEntries,
        ...links,
        { path: "Framework.app/real", body: "target" },
      ]),
    );
    expect(result.exitCode, result.stderr).toBe(0);
  },
);

test.each([false, true])(
  "deferred archive links cannot redirect extraction writes: %s",
  async (reverse) => {
    const canary = await mkdtemp(join(tmpdir(), "owned-archive-canary-"));
    try {
      await writeFile(join(canary, "value"), "unchanged");
      const entries = [
        {
          path: "Framework.app/redirect",
          type: "SymbolicLink" as const,
          target: "../../" + basename(canary),
        },
        { path: "Framework.app/redirect/value", body: "overwrite" },
      ];
      if (reverse) entries.reverse();
      const result = await install(
        await rawArchive("parent-link.tgz", [...bundleEntries, ...entries]),
      );
      expect(result.exitCode).toBe(1);
      expect(await readFile(join(canary, "value"), "utf8")).toBe("unchanged");
    } finally {
      await rm(canary, { recursive: true, force: true });
    }
  },
);

test("failed cleanup cannot accumulate another extraction tree in this process", async () => {
  const archive = await rawArchive("cleanup-retry.tgz", bundleEntries);
  const failing = installShims({ rm: "#!/bin/sh\nexit 1\n" });
  const directories = new Set<string>();
  try {
    const first = await install(archive);
    if (first.stdout.trim()) directories.add(dirname(installedPath(first.stdout)));
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain("could not be removed");
    const second = await install(archive);
    if (second.stdout.trim()) directories.add(dirname(installedPath(second.stdout)));
    expect(second.exitCode).toBe(1);
    expect(directories.size).toBe(1);
  } finally {
    failing.restore();
    for (const directory of directories) {
      expect(basename(directory).startsWith(".install-extract-")).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test.each(["FIFO", "CharacterDevice", "BlockDevice"] as const)(
  "rejects %s entries instead of silently skipping them",
  async (type) => {
    const result = await install(
      await rawArchive("special-entry.tgz", [
        ...bundleEntries,
        { path: "Framework.app/special", type },
      ]),
    );
    expect(result).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("unsupported entry"),
    });
  },
);

test("rejects oversized PAX metadata before buffering it", async () => {
  const header = new Header({
    path: "pax",
    type: "ExtendedHeader",
    size: 1024 * 1024 + 1,
    mode: 0o600,
  });
  header.encode();
  const file = join(root, "oversized-metadata.tgz");
  await writeFile(file, gzipSync(Buffer.concat([Buffer.from(header.block!), Buffer.alloc(1024)])));
  expect(await install(file)).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("metadata exceeds the size limit"),
  });
});

test("PAX size overrides keep the framing policy aligned with entry bodies", async () => {
  const plain = await readFile(await rawArchive("pax-base.tar", bundleEntries, false));
  const body = Buffer.from("pax-sized payload");
  const header = new Header({ path: "Framework.app/pax-data", type: "File", size: 0, mode: 0o600 });
  header.encode();
  const data = Buffer.concat([
    plain.subarray(0, -1024),
    new Pax({ size: body.length }).encode(),
    Buffer.from(header.block!),
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
  const file = join(root, "pax-size.tgz");
  await writeFile(file, gzipSync(data));
  const checking = installShims({ xcrun: '#!/bin/sh\ncat "$4/pax-data"\n' });
  try {
    const result = await install(file);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("pax-sized payload");
  } finally {
    checking.restore();
  }
});

test("a valid TAR with a corrupt gzip trailer is rejected before installation", async () => {
  const file = await archive("corrupt-trailer.tgz", ["My App.app"]);
  const data = await readFile(file);
  data[data.length - 8] = data[data.length - 8]! ^ 1;
  await writeFile(file, data);
  const started = join(root, "corrupt-trailer-install");
  process.env.SERVE_SIM_INSTALL_STARTED = started;
  try {
    expect((await install(file)).exitCode).toBe(1);
    expect(existsSync(started)).toBe(false);
  } finally {
    delete process.env.SERVE_SIM_INSTALL_STARTED;
  }
});

test("a slow staged install does not block unrelated uploads or removals", async () => {
  await app();
  const uploadId = "install-snapshot-progress";
  const bytes = await readFile(await archive("snapshot-progress.tgz", ["My App.app"]));
  await runHostActionAsync(
    { action: "upload.append", params: { uploadId, first: true, data: bytes.toString("base64") } },
    "unused",
  );
  const started = join(root, "snapshot-started"),
    gate = join(root, "snapshot-release");
  process.env.SERVE_SIM_INSTALL_STARTED = started;
  process.env.SERVE_SIM_INSTALL_GATE = gate;
  const pending = runHostActionAsync(
    { action: "app.install", params: { udid: UDID, uploadId } },
    "unused",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let n = 0; n < 500 && !existsSync(started); n++) await Bun.sleep(10);
    expect(existsSync(started)).toBe(true);
    const progress = (async () => {
      const appended = await runHostActionAsync(
        {
          action: "upload.append",
          params: {
            uploadId: "unrelated-upload",
            first: true,
            data: Buffer.from("other app").toString("base64"),
          },
        },
        "unused",
      );
      const removed = await runHostActionAsync(
        { action: "upload.remove", params: { uploadId } },
        "unused",
      );
      return appended.exitCode === 0 && removed.exitCode === 0;
    })();
    expect(
      await Promise.race([
        progress,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]),
    ).toBe(true);
  } finally {
    if (timer) clearTimeout(timer);
    await writeFile(gate, "release");
    delete process.env.SERVE_SIM_INSTALL_STARTED;
    delete process.env.SERVE_SIM_INSTALL_GATE;
    expect((await pending).exitCode).toBe(0);
    await runHostActionAsync(
      { action: "upload.remove", params: { uploadId: "unrelated-upload" } },
      "unused",
    );
  }
});

test("private upload snapshots survive source removal, clean failures, and enforce their byte ceiling", async () => {
  const uploadId = "snapshot-cleanup";
  await runHostActionAsync(
    {
      action: "upload.append",
      params: { uploadId, first: true, data: Buffer.from("stable source").toString("base64") },
    },
    "unused",
  );
  let snapshotPath: string | undefined;
  await expect(
    withStagedUploadSnapshotAsync(uploadId, async (path) => {
      snapshotPath = path;
      expect(path.startsWith(join(UPLOAD_DIR, ".install-snapshot-"))).toBe(true);
      await runHostActionAsync({ action: "upload.remove", params: { uploadId } }, "unused");
      expect(await readFile(path, "utf8")).toBe("stable source");
      throw new Error("consumer failed");
    }),
  ).rejects.toThrow("consumer failed");
  expect(snapshotPath).toBeDefined();
  expect(existsSync(snapshotPath!)).toBe(false);
  for (const uploadId of ["snapshot-too-large", "Sparse.app"]) {
    const oversized = join(UPLOAD_DIR, uploadId);
    const sparseFile = uploadId.endsWith(".app") ? join(oversized, "App") : oversized;
    if (uploadId.endsWith(".app")) await mkdir(oversized);
    await writeFile(sparseFile, "");
    try {
      await truncate(sparseFile, 2 * 1024 ** 3 + 1);
      await expect(
        withStagedUploadSnapshotAsync(uploadId, async () => {}),
      ).rejects.toThrow("staging is full");
    } finally {
      await rm(oversized, { recursive: true, force: true });
    }
  }
});

test("expired queued installs do not create a source snapshot", async () => {
  const uploadId = "expired-snapshot";
  await writeFile(join(UPLOAD_DIR, uploadId), "source");
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = readStagedUploadAsync(uploadId, async () => {
    entered();
    await gate;
  });
  await ready;
  const before = await readdir(UPLOAD_DIR);
  let consumed = false;
  const pending = withStagedUploadSnapshotAsync(
    uploadId,
    async () => {
      consumed = true;
    },
    Date.now() + 10,
  );
  const outcome = pending.then(
    () => undefined,
    (error) => error,
  );
  try {
    await Bun.sleep(30);
    release();
    await held;
    expect(await outcome).toBeInstanceOf(Error);
    expect((await outcome)?.message).toContain("timed out");
    expect(consumed).toBe(false);
    expect(await readdir(UPLOAD_DIR)).toEqual(before);
  } finally {
    release();
    await held;
    await rm(join(UPLOAD_DIR, uploadId));
  }
});

test("owner-scoped snapshots are reclaimed for dead servers and preserved for live servers", async () => {
  const dead = join(UPLOAD_ROOT, "2147483647-deadbeef"),
    live = join(UPLOAD_ROOT, `${process.pid}-deadbeef`);
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  for (const directory of [dead, live]) {
    await mkdir(join(directory, ".install-snapshot-test"), { recursive: true });
    await writeFile(join(directory, ".install-snapshot-test", "source"), "app source");
    await utimes(join(directory, ".install-snapshot-test"), old, old);
    await writeFile(join(directory, "install-snapshot-upload"), "old upload");
    await utimes(join(directory, "install-snapshot-upload"), old, old);
  }
  try {
    await runHostActionAsync(
      {
        action: "upload.append",
        params: {
          uploadId: "prune-snapshots",
          first: true,
          data: Buffer.from("x").toString("base64"),
        },
      },
      "unused",
    );
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(join(live, ".install-snapshot-test", "source"))).toBe(true);
    expect(existsSync(join(live, "install-snapshot-upload"))).toBe(false);
  } finally {
    await rm(dead, { recursive: true, force: true });
    await rm(live, { recursive: true, force: true });
    await runHostActionAsync(
      { action: "upload.remove", params: { uploadId: "prune-snapshots" } },
      "unused",
    );
  }
});

test("an old staged app directory installs from its private copy while upload pruning runs", async () => {
  const uploadId = "Old.app",
    source = join(UPLOAD_DIR, uploadId);
  await mkdir(source);
  await writeFile(join(source, "Info.plist"), "test app");
  await writeFile(join(source, "App"), "executable");
  await chmod(join(source, "App"), 0o755);
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await utimes(source, old, old);
  const started = join(root, "directory-started"),
    gate = join(root, "directory-release");
  process.env.SERVE_SIM_INSTALL_STARTED = started;
  process.env.SERVE_SIM_INSTALL_GATE = gate;
  const pending = runHostActionAsync(
    { action: "app.install", params: { udid: UDID, path: source } },
    "unused",
  );
  try {
    for (let n = 0; n < 500 && !existsSync(started); n++) await Bun.sleep(10);
    expect(existsSync(started)).toBe(true);
    const uploaded = await runHostActionAsync(
      {
        action: "upload.append",
        params: {
          uploadId: "prune-old-app",
          first: true,
          data: Buffer.from("x").toString("base64"),
        },
      },
      "unused",
    );
    expect(uploaded.exitCode).toBe(0);
    expect(existsSync(source)).toBe(false);
  } finally {
    await writeFile(gate, "release");
    delete process.env.SERVE_SIM_INSTALL_STARTED;
    delete process.env.SERVE_SIM_INSTALL_GATE;
    expect((await pending).exitCode).toBe(0);
    await rm(source, { recursive: true, force: true });
    await runHostActionAsync(
      { action: "upload.remove", params: { uploadId: "prune-old-app" } },
      "unused",
    );
  }
});

test("snapshot copying is bounded by the remaining action deadline", async () => {
  const uploadId = "snapshot-copy-timeout";
  await writeFile(join(UPLOAD_DIR, uploadId), "source");
  let consumed = false;
  try {
    await withShimsAsync({ cp: "#!/bin/sh\nsleep 2\n" }, async () => {
      await expect(
        withStagedUploadSnapshotAsync(
          uploadId,
          async () => {
            consumed = true;
          },
          Date.now() + 100,
        ),
      ).rejects.toThrow("timed out");
    });
    expect(consumed).toBe(false);
  } finally {
    await rm(join(UPLOAD_DIR, uploadId));
  }
});
