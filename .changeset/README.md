# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets). It holds the
pending changelog entries that drive the next release — each published package's version bump
and `CHANGELOG.md` are generated from these files.

Two packages are published from this repo: **`expo-device-hub`** and **`@expo/hub-client`**.
Every other workspace package is `private` and is skipped by `changeset publish`.

## Add a changeset with every change

Any change that should ship needs a changeset. From the repo root:

```sh
bun changeset
```

Select the package(s) you changed, pick the bump level, and write a summary. Commit the
generated `.changeset/*.md` file with your PR.

## Releasing

The **Release** GitHub Actions workflow (`.github/workflows/release.yml`) is dispatched
manually. It requires at least one pending changeset (it fails fast otherwise), runs
`changeset version` to bump versions and generate changelogs from these files, then publishes
to npm via OIDC.

See [`RELEASING.md`](../RELEASING.md) for the full process and one-time setup.
