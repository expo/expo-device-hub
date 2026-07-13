# Releasing

This monorepo publishes two public packages:

- **`expo-device-hub`** — the DevTools plugin.
- **`@expo/hub-client`** — device-client hooks and types.

Every other workspace package is marked `private` and is skipped by the release tooling.

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

Select the package(s) you changed (`expo-device-hub` and/or `@expo/hub-client`), choose the
bump level (`patch` / `minor` / `major`), and write a summary. Commit the generated
`.changeset/*.md` file with your PR. Multiple PRs accumulate multiple changesets — the release
folds them all together, and each package's final bump is the largest one requested for it.

### 2. When ready to publish — run the workflow

Go to **Actions → Release → Run workflow**. The only input is **canary**:

- **off** (default) → real release. The workflow tests, builds, versions, publishes to npm,
  pushes the release commit and tags, and creates GitHub releases.
- **on** → canary release. The workflow tests, builds, and versions as usual, then rewrites each
  published package's version into a prerelease and publishes it under the **`canary`** npm
  dist-tag — without committing the version bump, pushing tags, or creating GitHub releases.
  Install it with `npm install expo-device-hub@canary`, and `latest` stays untouched.

Canary versions are `<next-minor>-canary-<YYYYMMDD>-<short-sha>` — the current version with its
minor bumped (e.g. `0.1.1` → `0.2.0`), suffixed with the build date and the released commit's
short hash (e.g. `expo-device-hub@0.2.0-canary-20260429-a5e59cf`). Unlike a real release,
a canary does not require a pending changeset, so you can publish one from any commit.

Only packages that have a changeset are versioned and published; the other one stays put.
