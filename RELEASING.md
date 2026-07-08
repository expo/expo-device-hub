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

Go to **Actions → Release → Run workflow**. The only input is **dry_run**:

- **off** → real release.
- **on** → build, version, preview the changelog, and upload the packed `.tgz` tarballs as a
  **`package-tarballs`** artifact — without committing, tagging, or publishing. Download it from
  the run summary to install/verify the packages locally (e.g.
  `npm install ./expo-device-hub-<version>.tgz`).

Only packages that have a changeset are versioned and published; the other one stays put.
