# Releasing

This monorepo publishes one public package:

- **`expo-device-hub`** — the DevTools plugin.

Every other workspace package, including the internal **`@expo/hub-client`** device-client
layer, is marked `private` and is skipped by the release tooling.

Releases are driven by [changesets](https://github.com/changesets/changesets): the version
bump and changelog for each package are computed from the `.changeset/*.md` entries that have
accumulated since the last release. The **Release** GitHub Actions workflow
(`.github/workflows/release.yml`) runs on Ubuntu and publishes to npm using **OIDC
Trusted Publishing** (no long-lived `NPM_TOKEN`). Pushes to `main` publish canaries;
manual dispatch selects a stable or canary release. The build runs on EAS macOS.

## GitHub and EAS handoff

The root `.eas/workflows/build-release.yml` installs the monorepo's locked dependencies,
builds all workspaces (including serve-sim's native helpers), runs tests, and uploads the
final npm tarball. Root `app.config.js` shares the existing hub EAS project identity from
`packages/expo-device-hub/app.json`.

GitHub calculates the final version with Changesets, then dispatches EAS at the triggering
commit SHA with that version as an explicit workflow input. EAS initializes the pinned
submodules and applies the version before building. This also supports canaries without
pushing temporary version commits. The tarball's published files do not include the changelog;
GitHub retains the locally generated changelog for its release notes.

The Ubuntu job waits for EAS, downloads the named artifact, and verifies its package name,
version, web/server output, native helpers, and WebRTC runtime files. Stable releases then
commit/push the version changes, publish the downloaded tarball, create/push the npm-version
tag, and attach the same tarball to the GitHub release. Canaries publish the tarball under
`canary` without creating commits, tags, or GitHub releases. Publishing uses `npm publish`
directly so the EAS artifact is never repacked on Ubuntu.

Before using the pipeline, link the hub EAS project to this GitHub repository with the
project directory at the repository root, and make
`EXPO_DEV_EXPO_GITHUB_ROBOT_ACCESS_TOKEN` available to the GitHub `npm-publish` environment
(an organization or repository secret also works). The token needs access to that EAS
project. Keep the existing npm trusted publisher configured for `.github/workflows/release.yml`
and the `npm-publish` environment. No npm publish credentials are required in EAS.

This first version rebuilds on each release; it does not yet cache native artifacts. A failed
EAS build stops before version changes are pushed or npm is published. Failures after the
version push can still leave a release commit without a published package; inspect the npm
version and Git tags before retrying. GitHub's 90-minute timeout includes EAS queue time.

## Cutting a release

### 1. During development — add a changeset to your PR

Any change that should ship needs a changeset. From the repo root:

```sh
bun changeset
```

Select `expo-device-hub`, choose the bump level (`patch` / `minor` / `major`), and write a
summary. Changes to private workspace packages that ship inside `expo-device-hub` belong in the
`expo-device-hub` changeset. Commit the generated `.changeset/*.md` file with your PR. Multiple
PRs accumulate multiple changesets — the release folds them together, and the final bump is the
largest one requested.

### 2. When ready to publish — run the workflow

Go to **Actions → Release → Run workflow**. The only input is **canary**:

- **off** (default) → real release. The workflow versions, builds/tests on EAS, publishes to npm,
  pushes the release commit and tags, and creates GitHub releases.
- **on** → canary release. The workflow calculates a prerelease version, builds/tests it on
  EAS, and publishes it under the **`canary`** npm
  dist-tag — without committing the version bump, pushing tags, or creating GitHub releases.
  Install it with `npm install expo-device-hub@canary`, and `latest` stays untouched.

Canary versions are `<release-version>-canary-<YYYYMMDD>-<short-sha>`. When a pending changeset
bumps a package, the canary uses that version directly (e.g. `0.3.0` with a minor changeset becomes
`0.4.0-canary-...`). Otherwise it uses the next minor version (e.g. `0.1.1` becomes
`0.2.0-canary-...`). The suffix contains the build date and released commit's short hash (e.g.
`expo-device-hub@0.2.0-canary-20260429-a5e59cf`). Unlike a real release, a canary does not require
a pending changeset, so you can publish one from any commit.

Real releases only version and publish `expo-device-hub` when it has a changeset. Canary releases
assign it a canary version so they can also run without pending changesets.
