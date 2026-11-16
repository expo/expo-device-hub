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
  pushes the release commit, publishes to npm, pushes tags, and creates GitHub releases.
- **on** → canary release. The workflow versions packages, then rewrites each published
  package's version into a prerelease, builds and tests, and publishes under the **`canary`** npm
  dist-tag — without committing the version bump, pushing tags, or creating GitHub releases.
  Install it with `npm install expo-device-hub@canary`, and `latest` stays untouched.

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

`changeset publish` publishes every public package in the same run. If one of them fails to
publish, the workflow stops before it pushes tags or creates GitHub releases, even though the
version commit is already on `main`.

## npm mirror for EAS device sessions

EAS device sessions start `expo-device-hub@latest` (Android) and `@expo/serve-sim@latest` (iOS).
npm can list a new version before it serves the tarball, for example while the npm security
scan runs, and then a session that starts in that window fails. So after **Create GitHub
releases**, a real release copies the tarball of each of these packages that it published into a
public bucket, the npm mirror, and EAS reads the mirror first and npm second. LLP 0019 describes
the layout and the reasons.

`scripts/upload-npm-mirror.ts` does the copy. For each package, it:

1. packs the package (the same bytes as on npm) and stops if the sha512 is not npm's
   `dist.integrity`;
2. uploads `<name>/-/<npm tarball name>` and `<name>/<version>.json`, and never replaces them;
3. reads the tarball back through its public URL and checks the sha512 again;
4. then writes `<name>/latest.json`, only to a newer version, with `Cache-Control: no-cache`.

The steps run only when the repository variable `NPM_MIRROR_URL` is set, for example
`gs://turtle-v2/npm`. They sign in to Google Cloud with GitHub's OIDC token through the shared
`expo` Workload Identity provider, so the `expo/expo-device-hub` repository needs write access to
that bucket path. If the bucket uses fine-grained ACLs, also set `NPM_MIRROR_PREDEFINED_ACL` to
`publicRead`.

If the mirror steps fail, npm already has the release, and EAS sessions use npm until the next
release. To copy a version later, run the script with Google Cloud credentials:

```sh
NPM_MIRROR_URL=gs://turtle-v2/npm ./scripts/upload-npm-mirror.ts expo-device-hub@0.24.0
```

To roll back a bad release, move the npm `latest` dist-tag and copy the previous version record
over the pointer:

```sh
gcloud storage cp gs://turtle-v2/npm/expo-device-hub/0.23.0.json \
  gs://turtle-v2/npm/expo-device-hub/latest.json --cache-control="no-cache, max-age=0"
```
