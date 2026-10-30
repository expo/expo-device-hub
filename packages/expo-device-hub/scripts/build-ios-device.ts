import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Physical iOS capture builds require an Apple Silicon Mac.");
}
const root = resolve(import.meta.dir, "../native/ios-device");
// @ref LLP 0015#physical-ios-transport — reuse the pinned adapter instead of maintaining a copy.
const revision = "7ea9a42c713117464a36c2f4ebde424b13059bb7";
const checksum = "d30b64b1863a0613fabd6974eddf1fb39dfb26107b4bc59f1073df0ed1ccbd58";
const archive = resolve(root, "source.tar.gz");
const source = resolve(root, "source");
if (!existsSync(archive)) {
  const response = await fetch(
    `https://codeload.github.com/callstackincubator/codex-mobile-dev-plugin/tar.gz/${revision}`,
  );
  if (!response.ok) throw new Error(`Cannot download iOS adapter: HTTP ${response.status}`);
  writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
}
if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== checksum) {
  throw new Error(`iOS adapter checksum mismatch. Remove ${archive} and retry.`);
}
rmSync(source, { recursive: true, force: true });
mkdirSync(source, { recursive: true });
execFileSync("tar", [
  "-xzf",
  archive,
  "--strip-components=4",
  "-C",
  source,
  `codex-mobile-dev-plugin-${revision}/packages/native/ios-mirror`,
]);
execFileSync("patch", ["-p1", "-F0", "-i", resolve(import.meta.dir, "ios-device.patch")], {
  cwd: source,
  stdio: "inherit",
});
const manifest = resolve(source, "Cargo.toml");
execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", manifest], {
  stdio: "inherit",
  env: { ...process.env, CARGO_TARGET_DIR: resolve(root, "target") },
});
copyFileSync(
  resolve(root, "target/release/libexpo_hub_ios_device.dylib"),
  resolve(root, "ios-device.node"),
);
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--locked", "--format-version", "1", "--manifest-path", manifest],
    { encoding: "utf8" },
  ),
);
const licenses = metadata.packages
  .filter((pkg: { name: string }) => pkg.name !== "expo-hub-ios-device")
  .map(
    (pkg: {
      name: string;
      version: string;
      license: string;
      repository: string;
      manifest_path: string;
    }) => {
      const directory = dirname(pkg.manifest_path);
      const files = readdirSync(directory).filter((file) =>
        /^(LICENSE|LICENCE|COPYING|NOTICE)([-._]|$)/i.test(file),
      );
      if (pkg.name === "idevice") files.push("../LICENSE.txt");
      const texts = files.flatMap((file) => {
        try {
          return [readFileSync(resolve(directory, file), "utf8")];
        } catch {
          return [];
        }
      });
      return `${pkg.name} ${pkg.version} (${pkg.license})\n${pkg.repository ?? ""}\n\n${texts.join("\n\n")}`;
    },
  );
writeFileSync(
  resolve(root, "THIRD-PARTY-LICENSES.txt"),
  licenses.join("\n\n====================\n\n"),
);
console.log("Built physical iOS capture → native/ios-device/ios-device.node");
