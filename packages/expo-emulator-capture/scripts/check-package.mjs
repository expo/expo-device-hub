import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [manifest] = JSON.parse(execFileSync(
  "npm",
  ["pack", "--dry-run", "--ignore-scripts", "--json"],
  { cwd: root, encoding: "utf8" },
));

for (const path of ["dist/linux-x64/inject", "dist/linux-x64/libgpu_capture.so"]) {
  const entry = manifest.files.find((file) => file.path === path);
  if (!entry || entry.size === 0) {
    throw new Error(`Native package is missing a non-empty ${path}; build it first`);
  }
  if (path.endsWith("/inject") && (entry.mode & 0o111) === 0) {
    throw new Error("Packed native injector is not executable");
  }
}
console.log("Native package contains both Linux binaries and an executable injector");
