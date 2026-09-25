# Releasing

This monorepo publishes two public packages:

- **`expo-device-hub`** — the DevTools plugin.
- **`@expo/hub-client`** — the device-client hooks and the `DeviceScreen` component.

Every other workspace package is marked `private` or listed in `.changeset/config.json`
`ignore` and is skipped by the release tooling.

Releases are driven by [changesets](https://github.com/changesets/changesets): the version
bump and changelog for each package are computed from the `.changeset/*.md` entries that have
accumulated since the last release. The **Release** GitHub Actions workflow
(`.github/workflows/release.yml`) is dispatched manually for real releases and runs automatically
as a canary release on every push to `main`. It runs `.eas/workflows/build-release.yml` on an
EAS macOS worker (with `EXPO_TOKEN` from the `EXPO_DEV_EXPO_GITHUB_ROBOT_ACCESS_TOKEN` secret)
to version, build, test, and pack the packages. EAS also commits and pushes stable version changes
as `expo[bot]` to `release/<run-number>-<attempt>`. GitHub Actions downloads the tarballs, checks out the
release commit returned by EAS, and publishes to npm using **OIDC Trusted Publishing**
(no long-lived `NPM_TOKEN`). Once publication and GitHub releases succeed, it pushes that same
commit to `main` and deletes the release branch. If `main` advanced, the push fails and leaves
the release branch for manual resolution.

For regular releases, EAS packs only public packages whose versions changed. GitHub publishes
and tags every tarball in that archive after checking that it contains exactly one tarball for
each bumped, non-ignored public package. For canaries, EAS packs every public package that is
not excluded from releases.

## Cutting a release

### 1. During development — add a changeset to your PR

Any change that should ship needs a changeset. From the repo root:

```sh
bun changeset
```

Select the package(s) you changed (`expo-device-hub` and/or `@expo/hub-client`), choose the
bump level (`patch` / `minor` / `major`), and write a summary. Changes to private workspace
packages that ship inside `expo-device-hub` belong in the `expo-device-hub` changeset. Commit
the generated `.changeset/*.md` file with your PR. Multiple PRs accumulate multiple changesets —
the release folds them together, and each package's final bump is the largest one requested
for it.

### 2. When ready to publish — run the workflow

Go to **Actions → Release → Run workflow** and select `main`. The only input is **canary**:

- **off** (default) → real release. EAS versions, builds, tests, and packs the packages, then
  commits and pushes the staged version changes as `expo[bot]` to `release/<run-number>-<attempt>`.
  GitHub checks out that commit, publishes the tarballs to npm, pushes
  package tags, and creates GitHub releases. It then pushes the tested commit to `main`, deletes
  the release branch.
- **on** → canary release. EAS versions as usual, then rewrites each published package's version
  into a prerelease before building, testing, and packing. The workflow publishes it under the
  **`canary`** npm dist-tag — without committing the version bump, pushing tags, or creating GitHub releases.
  Install it with `npm install expo-device-hub@canary`, and `latest` stays untouched.

Both paths build all packages after the final version changes so bundled version metadata and
vendored artifacts match the versions being published. A build or test failure leaves the
repository branches and pending changesets untouched. EAS stages version changes before building
so generated build/test outputs are not included in the release commit.

Development pushes to `main` also run the workflow as a canary release. The release workflow's
own `GITHUB_TOKEN` push to `main` does not trigger another run.

Canary versions are `<release-version>-canary-<YYYYMMDD>-<short-sha>`. When a pending changeset
bumps a package, the canary uses that version directly (e.g. `0.3.0` with a minor changeset becomes
`0.4.0-canary-...`). Otherwise it uses the next minor version (e.g. `0.1.1` becomes
`0.2.0-canary-...`). The suffix contains the build date and released commit's short hash (e.g.
`expo-device-hub@0.2.0-canary-20260429-a5e59cf`). Unlike a real release, a canary does not require
a pending changeset, so you can publish one from any commit.

Real releases only version and publish the packages that have a changeset; the others stay put.
Canary releases assign every public package a canary version so they can also run without
pending changesets.

### Retrying a failed release

Use **Re-run failed jobs** on the original workflow run. It checks out the original source SHA
and rebuilds the same release, creating a new `release/<run-number>-<attempt>` branch after
the build, tests, and packing succeed. Each attempt leaves any earlier release branch alone.

If publishing, tagging, creating GitHub releases, or pushing to `main` fails, the release
branch remains for a maintainer to inspect. If `main` advanced during the release, its
fast-forward push fails; the maintainer must reconcile the release branch with `main` manually.
If an earlier attempt already pushed package tags, a new attempt's release commit will not match
those tags and publication will fail until a maintainer resolves the partial release.

Publication skips versions already on npm. Once every publish succeeds, it pushes package tags
together. If publishing a package fails, no tags are pushed by that attempt. Unchanged and
ignored packages do not receive new tags. An existing tag pointing elsewhere causes a failure
rather than being replaced. Canary and dry-run publication never change tags.

## One-time setup for a new public package

The workflow publishes with npm Trusted Publishing, so npm must know the package before its
first release. For every package that is not `private`:

1. Make sure the package exists on npm under the `@expo` scope (or is unscoped) and that the
   Expo org owns it.
2. On npmjs.com, open the package's **Settings → Trusted Publisher** and add a GitHub Actions
   publisher for the repository `expo/expo-device-hub`, the workflow file `release.yml`, and the
   environment `npm-publish`.
3. Keep `repository.url` in the package's `package.json` set to
   `https://github.com/expo/expo-device-hub.git`. npm rejects a provenance-signed publish when
   the URL does not match the repository that runs the workflow.
4. Add a changeset for the package so the next real release versions and publishes it.

All packages versioned by a real release are published in the same run. If one package fails
to publish, the workflow stops before pushing tags or creating GitHub releases. Its tested
version commit remains on the remote for manual recovery.
