# Releasing

This monorepo publishes three public packages:

- **`expo-device-hub`** — the DevTools plugin.
- **`@expo/hub-client`** — the device-client hooks and the `DeviceScreen` component.
- **`@expo/serve-sim`** — the iOS simulator server in `packages/serve-sim/packages/serve-sim`.

Every other workspace package is marked `private` and is skipped by the release tooling.

Releases are driven by [changesets](https://github.com/changesets/changesets): the version
bump and changelog for each package are computed from the `.changeset/*.md` entries that have
accumulated since the last release. The **Release** GitHub Actions workflow
(`.github/workflows/release.yml`) is dispatched manually for real releases, runs automatically
as a canary release on every push to `main`, and publishes to npm using **OIDC Trusted
Publishing** (no long-lived `NPM_TOKEN`).

## Cutting a release

### 1. During development — add a changeset to your PR

Any change that should ship needs a changeset. From the repo root:

```sh
bun changeset
```

Select the package(s) you changed (`expo-device-hub`, `@expo/hub-client`, `@expo/serve-sim`), choose the
bump level (`patch` / `minor` / `major`), and write a summary. Changes to private workspace
packages that ship inside `expo-device-hub` belong in the `expo-device-hub` changeset. Commit
the generated `.changeset/*.md` file with your PR. Multiple PRs accumulate multiple changesets —
the release folds them together, and each package's final bump is the largest one requested
for it.

### 2. When ready to publish — run the workflow

Go to **Actions → Release → Run workflow**. The only input is **canary**:

- **off** (default) → real release. The workflow versions packages, builds and tests them,
  pushes the release commit, and publishes changed versions under the **`next`** npm dist-tag.
  After every release tarball is available, it promotes those versions to **`latest`**, pushes
  Git tags, and creates GitHub releases.
- **on** → canary release. The workflow versions packages, then rewrites each published
  package's version into a prerelease, builds and tests, and publishes under the **`canary`** npm
  dist-tag — without committing the version bump, pushing tags, or creating GitHub releases.
  The job waits for every canary tarball to become available. Install it with `npm install expo-device-hub@canary`, and `latest` stays untouched.

Both paths use the [EAS CLI availability check](https://github.com/expo/eas-cli/blob/b78cda16a5eea09480faa27fd6489dfceda967c1/.github/workflows/release.yml#L97-L123)
to look up each exact version with `npm view --prefer-online`, then download its tarball.
The verification step retries after 10 seconds and times out after 30 minutes.

Both paths build all packages after the final version changes so bundled version metadata and
vendored artifacts match the versions being published. Build or test failures stop the workflow
before it commits the version bump or publishes packages.

The release job runs on Ubuntu, but `@expo/serve-sim` builds native macOS binaries. So the
workflow first dispatches `.eas/workflows/build-release-cache.yml` on EAS for the same commit
and waits for it. That macOS job applies the same version steps, runs `bun run build --force`, and
writes the Turborepo remote cache (`turbo.exp.host`, team `expo-device-hub`) with the `TURBO_TOKEN` from the
production EAS environment. The release job then reads the cache with the public `readonly`
token, so its build is a cache hit. Both jobs use one canary id (`CANARY_ID`), because package
versions are Turborepo inputs. If the serve-sim build is not a cache hit, the release fails at
**Build packages**. The dispatch uses the `EXPO_CI_ROBOT_ACCESS_TOKEN` repository
secret.

The native release build is pinned to `macos-tahoe-26.5-xcode-26.6`. The EAS
builder uses `--force` to rebuild and write fresh cache entries on that image.
The Ubuntu reader uses the cache without `--force`.
On a PR that is ready for review, or a draft with the `ci-ready` label, the serve-sim
workflow tests one Xcode 26 build on the Xcode 26 and 27 images. A second workflow builds serve-sim with Xcode 27 and tests
that build on the Xcode 27 image, for users who build from source. It runs every night
and on a PR with the `xcode-27` label, and it does not publish its build. LLP 0014
states which Xcode versions serve-sim supports.

Every push to `main` also runs the workflow as a canary release, so `@canary` always tracks the
latest commit on `main`.

Canary versions are `<release-version>-canary-<YYYYMMDD>-<short-sha>`. When a pending changeset
bumps a package, the canary uses that version directly (e.g. `0.3.0` with a minor changeset becomes
`0.4.0-canary-...`). Otherwise it uses the next minor version (e.g. `0.1.1` becomes
`0.2.0-canary-...`). The suffix contains the build date and released commit's short hash (e.g.
`expo-device-hub@0.2.0-canary-20260429-a5e59cf`). Unlike a real release, a canary does not require
a pending changeset, so you can publish one from any commit.

Real releases only version and publish the packages that have a changeset; the others stay put.
Canary releases assign every public package a canary version so they can also run without
pending changesets.

## Recover a stable release after verification or promotion fails

Once the workflow has pushed the version commit and published to `next`, the changesets for
those versions are consumed. A later release can skip those packages.

1. From the failed run’s **Commit & push version bump** and **Publish to npm** logs, identify
   the version commit and the exact published `package@version` entries. Put one entry per
   line in a temporary manifest. The version summary also lists unchanged packages.
2. Run `./scripts/verify-npm-availability.ts "$manifest"` from the release checkout, with
   `manifest` set to the file’s path. Continue once every tarball is downloadable.
3. Coordinate with anyone cutting another stable release. For each entry, inspect
   `npm dist-tag ls <package>`. If `latest` still needs to move forward, run
   `npm dist-tag add <package>@<exact-version> latest` as an authorized npm maintainer.
   Skip entries where `latest` already points to that version or a newer release.
4. The workflow pushes Git tags and creates GitHub releases after promotion. Check each
   published version for a missing tag or release. Create missing tags at the **version
   commit**, and attach the published tarball (downloaded with `npm pack <package>@<exact-version>`)
   to the corresponding GitHub release with that version’s changelog notes.

## One-time setup for a new public package

The workflow publishes with npm Trusted Publishing, so npm must know the package before its
first release. For every package that is not `private`:

1. Make sure the package exists on npm under the `@expo` scope (or is unscoped) and that the
   Expo org owns it.
2. On npmjs.com, open the package's **Settings → Trusted Publisher** and add a GitHub Actions
   publisher for the repository `expo/expo-device-hub`, the workflow file `release.yml`, and the
   environment `npm-publish`. Enable both **Allow npm publish** and **Allow npm dist-tag**.
   Existing packages also need dist-tag permission before their first release under this workflow.
   See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing).
3. Keep `repository.url` in the package's `package.json` set to
   `https://github.com/expo/expo-device-hub.git`. npm rejects a provenance-signed publish when
   the URL does not match the repository that runs the workflow.
4. Add a changeset for the package so the next real release versions and publishes it.

`changeset publish` publishes every public package in the same run. If one of them fails to
publish, the workflow stops before it pushes tags or creates GitHub releases, even though the
version commit is already on `main`.
