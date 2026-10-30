import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function buildDashboard(outdir: string) {
  const packageRoot = resolve(import.meta.dir, "../..");
  const require = createRequire(resolve(packageRoot, "package.json"));
  const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
  const tailwind = require("@tailwindcss/postcss");
  const aliases: Record<string, string> = {
    "@expo/hub-client": resolve(packageRoot, "../@expo/hub-client/dist/index.mjs"),
    "@expo/hub-components": resolve(packageRoot, "../@expo/hub-components/src/index.ts"),
    "@expo/hub-components/theme.css": resolve(
      packageRoot,
      "../@expo/hub-components/src/theme/theme.css",
    ),
  };
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "dashboard.tsx")],
    outdir,
    target: "browser",
    format: "esm",
    naming: "[name].[ext]",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "workspace-dashboard",
        setup(build) {
          build.onResolve(
            { filter: /^@expo\/hub-(client|components)(\/theme\.css)?$/ },
            ({ path }) => ({ path: aliases[path]! }),
          );
          build.onLoad({ filter: /\/expo-device-hub\/global\.css$/ }, async ({ path }) => {
            const css = await postcss([tailwind({ base: packageRoot })]).process(
              await readFile(path, "utf8"),
              { from: path },
            );
            return { contents: css.css, loader: "css" };
          });
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
}
