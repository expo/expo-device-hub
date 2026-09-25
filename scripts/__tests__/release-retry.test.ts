import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scripts = resolve(import.meta.dir, "..");
const roots: string[] = [];

async function command(cwd: string, args: string[], env = {}) {
  const child = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function fixture(pushRelease = true) {
  const root = await mkdtemp(join(tmpdir(), "release-retry-"));
  roots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  const artifacts = join(root, "artifacts");
  await Promise.all([mkdir(repo), mkdir(bin), mkdir(artifacts)]);
  async function git(...args: string[]) {
    const result = await command(repo, ["git", ...args]);
    if (result.code) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Release test");
  await git("config", "user.email", "release-test@example.com");
  await git("config", "commit.gpgsign", "false");
  await git("init", "--bare", remote);
  await git("remote", "add", "origin", remote);
  await Bun.write(
    join(repo, "package.json"),
    JSON.stringify({ private: true, workspaces: ["packages/*"] }),
  );
  await Bun.write(
    join(repo, ".changeset/config.json"),
    JSON.stringify({ ignore: ["ignored"] }),
  );
  await Bun.write(
    join(repo, ".changeset/release.md"),
    '---\n"changed": minor\n---\n\nRelease\n',
  );
  for (const name of ["changed", "unchanged", "ignored"]) {
    await Bun.write(
      join(repo, `packages/${name}/package.json`),
      JSON.stringify({ name, version: "1.0.0" }),
    );
  }
  await git("add", ".");
  await git("commit", "-m", "Initial packages");
  const source = await git("rev-parse", "HEAD");
  await git("push", "origin", "main");
  await Bun.write(
    join(repo, "packages/changed/package.json"),
    JSON.stringify({ name: "changed", version: "1.1.0" }),
  );
  await Bun.write(
    join(repo, "packages/ignored/package.json"),
    JSON.stringify({ name: "ignored", version: "1.1.0" }),
  );
  await Bun.write(
    join(repo, "packages/changed/CHANGELOG.md"),
    "# changed\n\n## 1.1.0\n\nRelease\n",
  );
  await rm(join(repo, ".changeset/release.md"));
  await git("add", ".");
  await git("commit", "-m", "chore(release): version packages");
  const sha = await git("rev-parse", "HEAD");
  if (pushRelease) await git("push", "origin", "main");
  for (const name of ["changed", "unchanged", "ignored"]) {
    const staging = join(root, `stage-${name}`);
    await mkdir(join(staging, "package"), { recursive: true });
    await Bun.write(
      join(staging, "package/package.json"),
      await Bun.file(join(repo, `packages/${name}/package.json`)).text(),
    );
    const packed = await command(staging, [
      "tar",
      "-czf",
      join(artifacts, `${name}.tgz`),
      "package",
    ]);
    expect(packed.code).toBe(0);
  }
  const state = join(root, "published");
  const log = join(root, "npm.log");
  await Bun.write(
    join(bin, "npm"),
    `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.NPM_TEST_LOG, args.join(" ") + "\\n");
if (args[0] === "view") process.exit(args[1].startsWith("unchanged@") || existsSync(process.env.NPM_TEST_STATE) ? 0 : 1);
if (args[0] === "publish") {
  if (!args.includes("--dry-run")) writeFileSync(process.env.NPM_TEST_STATE, "published");
  process.exit(0);
}
process.exit(2);
`,
  );
  await chmod(join(bin, "npm"), 0o755);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    NPM_TEST_STATE: state,
    NPM_TEST_LOG: log,
  };
  const publish = (cwd = repo, flags: string[] = []) =>
    command(
      cwd,
      [
        process.execPath,
        join(scripts, "publish-packages.ts"),
        artifacts,
        ...flags,
      ],
      env,
    );
  return {
    root,
    repo,
    remote,
    artifacts,
    state,
    log,
    source,
    sha,
    git,
    publish,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("a fresh retry restores the tag after npm succeeds but tag push fails", async () => {
  const f = await fixture();
  const hook = join(f.remote, "hooks/pre-receive");
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect((await f.publish()).code).not.toBe(0);
  expect(await Bun.file(f.state).exists()).toBe(true);
  await rm(hook);
  const retry = join(f.root, "retry");
  await f.git("clone", "--branch", "main", f.remote, retry);
  expect((await f.publish(retry)).code).toBe(0);
  expect(await f.git("ls-remote", "origin", "refs/tags/changed@1.1.0")).toBe(
    `${f.sha}\trefs/tags/changed@1.1.0`,
  );
  expect(await f.git("ls-remote", "origin", "refs/tags/unchanged@1.0.0")).toBe(
    "",
  );
  expect(await f.git("ls-remote", "origin", "refs/tags/ignored@1.1.0")).toBe(
    "",
  );
  expect(
    (await Bun.file(f.log).text())
      .split("\n")
      .filter((line) => line.startsWith("publish ")),
  ).toHaveLength(1);
});

test("an existing local tag is pushed again after a failed push", async () => {
  const f = await fixture();
  await Bun.write(f.state, "published");
  await f.git("tag", "changed@1.1.0");
  expect((await f.publish()).code).toBe(0);
  expect(await f.git("ls-remote", "origin", "refs/tags/changed@1.1.0")).toBe(
    `${f.sha}\trefs/tags/changed@1.1.0`,
  );
});

test("a tarball that disagrees with the release commit is rejected before publishing", async () => {
  const f = await fixture();
  await Bun.write(
    join(f.root, "stage-changed/package/package.json"),
    JSON.stringify({ name: "changed", version: "9.0.0" }),
  );
  expect(
    (
      await command(join(f.root, "stage-changed"), [
        "tar",
        "-czf",
        join(f.artifacts, "changed.tgz"),
        "package",
      ])
    ).code,
  ).toBe(0);
  expect((await f.publish()).code).not.toBe(0);
  expect(await Bun.file(f.log).exists()).toBe(false);
  expect(await f.git("tag", "--list")).toBe("");
});

test("a remote annotated tag is reused without being replaced", async () => {
  const f = await fixture();
  await Bun.write(f.state, "published");
  await f.git("tag", "-a", "changed@1.1.0", "-m", "Published release");
  const tag = await f.git("rev-parse", "refs/tags/changed@1.1.0");
  await f.git("push", "origin", "refs/tags/changed@1.1.0");
  await f.git("tag", "-d", "changed@1.1.0");
  expect((await f.publish()).code).toBe(0);
  expect(await f.git("rev-parse", "refs/tags/changed@1.1.0")).toBe(tag);
});

test("a remote tag for a different commit is rejected without overwriting it", async () => {
  const f = await fixture();
  await Bun.write(f.state, "published");
  const parent = await f.git("rev-parse", "HEAD^");
  await f.git("tag", "changed@1.1.0", parent);
  await f.git("push", "origin", "refs/tags/changed@1.1.0");
  await f.git("tag", "-d", "changed@1.1.0");
  expect((await f.publish()).code).not.toBe(0);
  expect(await f.git("ls-remote", "origin", "refs/tags/changed@1.1.0")).toBe(
    `${parent}\trefs/tags/changed@1.1.0`,
  );
});

for (const flag of ["--canary", "--dry-run"]) {
  test(`${flag} never creates release tags`, async () => {
    const f = await fixture();
    expect((await f.publish(f.repo, [flag])).code).toBe(0);
    expect(await f.git("tag", "--list")).toBe("");
    expect(await f.git("ls-remote", "--tags", "origin")).toBe("");
    if (flag === "--dry-run")
      expect(await Bun.file(f.state).exists()).toBe(false);
  });
}

type Step = { name?: string; run?: string; with?: Record<string, unknown> };
type Workflow = {
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  jobs: Record<string, { steps: Step[] }>;
};
async function workflows() {
  return {
    github: Bun.YAML.parse(
      await Bun.file(
        resolve(scripts, "../.github/workflows/release.yml"),
      ).text(),
    ) as Workflow,
    eas: Bun.YAML.parse(
      await Bun.file(
        resolve(scripts, "../.eas/workflows/build-release.yml"),
      ).text(),
    ) as Workflow,
  };
}

test("EAS owns versioning and stable commits; GitHub only checks out the result to publish", async () => {
  const { github, eas } = await workflows();
  const githubSteps = github.jobs.release.steps;
  const easSteps = eas.jobs.package.steps;
  const githubNames = githubSteps.map((step) => step.name);
  const easNames = easSteps.map((step) => step.name);
  expect(github.on.workflow_dispatch.inputs.resume).toBeUndefined();
  expect(
    githubSteps.some(
      (step) =>
        step.run?.includes("changeset:version") ||
        step.run?.includes("commit-release.ts") ||
        step.run?.includes("git config user"),
    ),
  ).toBe(false);
  expect(
    githubSteps.find((step) => step.name === "Checkout")?.with?.ref,
  ).toBeUndefined();
  expect(
    githubSteps.find((step) => step.name === "Checkout")?.with?.["fetch-depth"],
  ).toBeUndefined();
  expect(githubNames.indexOf("Checkout release commit")).toBeGreaterThan(
    githubNames.indexOf("Download npm packages from EAS"),
  );
  expect(githubNames.indexOf("Publish to npm")).toBeGreaterThan(
    githubNames.indexOf("Checkout release commit"),
  );
  expect(
    easNames.indexOf("Apply version bump & generate changelog"),
  ).toBeLessThan(easNames.indexOf("Apply canary version"));
  expect(easNames.indexOf("Apply canary version")).toBeLessThan(
    easNames.indexOf("Build packages"),
  );
  expect(easNames.indexOf("Stage version changes")).toBeLessThan(
    easNames.indexOf("Build packages"),
  );
  expect(
    easNames.indexOf("Commit & push tested version changes"),
  ).toBeGreaterThan(easNames.indexOf("Test"));
  expect(
    easNames.indexOf("Commit & push tested version changes"),
  ).toBeGreaterThan(easNames.indexOf("Pack packages"));
  expect(easNames.indexOf("Archive npm packages")).toBeGreaterThan(
    easNames.indexOf("Commit & push tested version changes"),
  );
  expect(
    easSteps.find(
      (step) => step.name === "Commit & push tested version changes",
    )?.run,
  ).toContain("102182381+expo[bot]@users.noreply.github.com");
});

async function stageVersions(f: Awaited<ReturnType<typeof fixture>>) {
  await f.git("checkout", "--detach", f.source);
  await f.git(
    "restore",
    `--source=${f.sha}`,
    "--worktree",
    "--",
    "packages",
    ".changeset",
  );
  const { eas } = await workflows();
  const stage = eas.jobs.package.steps
    .find((step) => step.name === "Stage version changes")!
    .run!.replaceAll("${{ inputs.canary }}", "false");
  expect((await command(f.repo, ["bash", "-e", "-c", stage])).code).toBe(0);
}

test("EAS commits only staged versions as expo[bot] and GitHub fetches the returned SHA", async () => {
  const f = await fixture(false);
  const { eas, github } = await workflows();
  await stageVersions(f);
  // A failed build stops here: the remote still contains pending changesets.
  expect(await f.git("ls-remote", "origin", "refs/heads/main")).toBe(
    `${f.source}\trefs/heads/main`,
  );
  const publisher = join(f.root, "github");
  await f.git("clone", "--branch", "main", f.remote, publisher);
  // Build outputs created after staging must not enter the version commit.
  await Bun.write(join(f.repo, "build-output.txt"), "generated");
  await mkdir(join(f.repo, "release-artifacts"));
  const commit = eas.jobs.package.steps
    .find((step) => step.name === "Commit & push tested version changes")!
    .run!.replaceAll("${{ inputs.canary }}", "false")
    .replace(
      "bun scripts/commit-release.ts",
      `"${process.execPath}" "${join(scripts, "commit-release.ts")}"`,
    );
  expect(
    (
      await command(f.repo, ["bash", "-e", "-c", commit], {
        RELEASE_BRANCH: "main",
      })
    ).code,
  ).toBe(0);
  const releaseSha = await f.git("rev-parse", "HEAD");
  expect(await f.git("show", "-s", "--format=%an <%ae>")).toBe(
    "expo[bot] <102182381+expo[bot]@users.noreply.github.com>",
  );
  expect(await f.git("rev-parse", "HEAD^{tree}")).toBe(
    await f.git("rev-parse", `${f.sha}^{tree}`),
  );
  expect(await f.git("ls-tree", "HEAD", "build-output.txt")).toBe("");
  const marker = await Bun.file(
    join(f.repo, "release-artifacts/release-commit.txt"),
  ).text();
  expect(marker.trim()).toBe(releaseSha);
  await Bun.write(
    join(publisher, "release-artifacts/release-commit.txt"),
    marker,
  );
  const checkout = github.jobs.release.steps.find(
    (step) => step.name === "Checkout release commit",
  )!.run!;
  expect(
    (
      await command(publisher, ["bash", "-e", "-c", checkout], {
        SOURCE_SHA: f.source,
      })
    ).code,
  ).toBe(0);
  expect(
    (await command(publisher, ["git", "rev-parse", "HEAD"])).stdout.trim(),
  ).toBe(releaseSha);
  expect(
    await Bun.file(join(publisher, ".changeset/release.md")).exists(),
  ).toBe(false);
  expect(
    await Bun.file(join(publisher, "packages/changed/CHANGELOG.md")).text(),
  ).toContain("1.1.0");
  expect((await f.publish(publisher)).code).toBe(0);
});

test("GitHub rejects an artifact commit that belongs to a different source", async () => {
  const f = await fixture();
  const { github } = await workflows();
  await Bun.write(join(f.repo, "release-artifacts/release-commit.txt"), f.sha);
  const checkout = github.jobs.release.steps.find(
    (step) => step.name === "Checkout release commit",
  )!.run!;
  expect(
    (
      await command(f.repo, ["bash", "-e", "-c", checkout], {
        SOURCE_SHA: "0".repeat(40),
      })
    ).code,
  ).not.toBe(0);
});

test("rerunning EAS reuses the pushed version commit and publication repairs its tag", async () => {
  const f = await fixture();
  await Bun.write(f.state, "published");
  await stageVersions(f);
  const result = await command(
    f.repo,
    [process.execPath, join(scripts, "commit-release.ts")],
    { RELEASE_BRANCH: "main" },
  );
  expect(result.code).toBe(0);
  expect(await f.git("rev-parse", "HEAD")).toBe(f.sha);
  expect((await f.publish()).code).toBe(0);
  expect(await f.git("ls-remote", "origin", "refs/tags/changed@1.1.0")).toBe(
    `${f.sha}\trefs/tags/changed@1.1.0`,
  );
});

test("a release does not overwrite an unrelated change pushed while EAS was building", async () => {
  const f = await fixture();
  await Bun.write(join(f.repo, "later-change.txt"), "another change");
  await f.git("add", ".");
  await f.git("commit", "-m", "Later change");
  await f.git("push", "origin", "main");
  const latest = await f.git("rev-parse", "HEAD");
  await stageVersions(f);
  const result = await command(
    f.repo,
    [process.execPath, join(scripts, "commit-release.ts")],
    { RELEASE_BRANCH: "main" },
  );
  expect(result.code).not.toBe(0);
  expect(await f.git("ls-remote", "origin", "refs/heads/main")).toBe(
    `${latest}\trefs/heads/main`,
  );
});
