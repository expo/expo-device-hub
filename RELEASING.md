# Releasing

This monorepo publishes one public package:

- **`expo-device-hub`** — the DevTools plugin.

Every other workspace package, including the internal **`@expo/hub-client`** device-client
layer, is marked `private` and is skipped by the release tooling.

Releases are driven by [changesets](https://github.com/changesets/changesets): the version
bump and changelog for each package are computed from the `.changeset/*.md` entries that have
accumulated since the last release. The **Release** GitHub Actions workflow
(`.github/workflows/release.yml`) is dispatched manually and publishes to npm using **OIDC
Trusted Publishing** (no long-lived `NPM_TOKEN`).

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

- **off** (default) → real release. The workflow tests, builds, versions, publishes to npm,
  pushes the release commit and tags, and creates GitHub releases.
- **on** → canary release. The workflow tests, builds, and versions as usual, then rewrites each
  published package's version into a prerelease and publishes it under the **`canary`** npm
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
