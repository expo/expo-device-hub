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

test("both releases version in EAS; stable commits wait for a successful build and artifact download", async () => {
  const { github, eas } = await workflows();
  const githubSteps = github.jobs.release.steps;
  const easSteps = eas.jobs.package.steps;
  const githubNames = githubSteps.map((step) => step.name);
  const easNames = easSteps.map((step) => step.name);
  expect(github.on.workflow_dispatch.inputs.resume).toBeUndefined();
  expect(
    githubSteps.some((step) => step.run?.includes("changeset:version")),
  ).toBe(false);
  expect(
    githubNames.indexOf("Commit & push tested version changes"),
  ).toBeGreaterThan(githubNames.indexOf("Download npm packages from EAS"));
  expect(githubNames.indexOf("Download npm packages from EAS")).toBeGreaterThan(
    githubNames.indexOf("Build packages on EAS"),
  );
  expect(
    easNames.indexOf("Apply version bump & generate changelog"),
  ).toBeLessThan(easNames.indexOf("Apply canary version"));
  expect(easNames.indexOf("Apply canary version")).toBeLessThan(
    easNames.indexOf("Build packages"),
  );
  expect(easNames.indexOf("Capture version changes")).toBeLessThan(
    easNames.indexOf("Build packages"),
  );
  expect(easNames.indexOf("Upload npm packages")).toBeGreaterThan(
    easNames.indexOf("Test"),
  );
  expect(
    githubSteps.find((step) => step.name === "Configure git")?.run,
  ).toContain("102182381+expo[bot]@users.noreply.github.com");
});

test("the EAS version patch preserves changeset deletions and new changelogs before GitHub commits it", async () => {
  const f = await fixture(false);
  const { eas } = await workflows();
  await f.git("checkout", "--detach", f.source);
  await f.git(
    "restore",
    `--source=${f.sha}`,
    "--worktree",
    "--",
    "packages",
    ".changeset",
  );
  const capture = eas.jobs.package.steps
    .find((step) => step.name === "Capture version changes")!
    .run!.replaceAll("${{ inputs.canary }}", "false");
  expect((await command(f.repo, ["bash", "-e", "-c", capture])).code).toBe(0);
  // A failed build stops here: the release branch still contains pending changesets.
  expect(await f.git("ls-remote", "origin", "refs/heads/main")).toBe(
    `${f.source}\trefs/heads/main`,
  );
  const github = join(f.root, "github");
  await f.git("clone", "--branch", "main", f.remote, github);
  for (const [key, value] of [
    ["user.name", "expo[bot]"],
    ["user.email", "102182381+expo[bot]@users.noreply.github.com"],
    ["commit.gpgsign", "false"],
  ]) {
    expect((await command(github, ["git", "config", key!, value!])).code).toBe(
      0,
    );
  }
  const patch = join(f.repo, "release-artifacts/version.patch");
  const result = await command(
    github,
    [process.execPath, join(scripts, "commit-release.ts"), patch],
    { RELEASE_BRANCH: "main" },
  );
  expect(result.code).toBe(0);
  expect(await Bun.file(join(github, ".changeset/release.md")).exists()).toBe(
    false,
  );
  expect(
    await Bun.file(join(github, "packages/changed/CHANGELOG.md")).text(),
  ).toContain("1.1.0");
  expect(
    (
      await command(github, ["git", "show", "-s", "--format=%an <%ae>"])
    ).stdout.trim(),
  ).toBe("expo[bot] <102182381+expo[bot]@users.noreply.github.com>");
  expect(
    (await command(github, ["git", "rev-parse", "HEAD^{tree}"])).stdout.trim(),
  ).toBe(await f.git("rev-parse", `${f.sha}^{tree}`));
});

test("rerunning the original source reuses the pushed version commit and repairs its tag", async () => {
  const f = await fixture();
  const patch = join(f.root, "version.patch");
  await Bun.write(
    patch,
    (await f.git("diff", "--binary", f.source, f.sha)) + "\n",
  );
  await Bun.write(f.state, "published");
  await f.git("checkout", "--detach", f.source);
  const result = await command(
    f.repo,
    [process.execPath, join(scripts, "commit-release.ts"), patch],
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
  const patch = join(f.root, "version.patch");
  await Bun.write(
    patch,
    (await f.git("diff", "--binary", f.source, f.sha)) + "\n",
  );
  await Bun.write(join(f.repo, "later-change.txt"), "another change");
  await f.git("add", ".");
  await f.git("commit", "-m", "Later change");
  await f.git("push", "origin", "main");
  const latest = await f.git("rev-parse", "HEAD");
  await f.git("checkout", "--detach", f.source);
  const result = await command(
    f.repo,
    [process.execPath, join(scripts, "commit-release.ts"), patch],
    { RELEASE_BRANCH: "main" },
  );
  expect(result.code).not.toBe(0);
  expect(await f.git("ls-remote", "origin", "refs/heads/main")).toBe(
    `${latest}\trefs/heads/main`,
  );
});
