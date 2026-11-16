# LLP 0019: npm mirror for EAS device sessions

**Type:** Decision
**Status:** Draft
**Systems:** Release, CI, Hub, ServeSim
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-11-16
**Related:** LLP 0000, LLP 0014

## Summary

A real release copies the npm tarballs of `expo-device-hub` and `@expo/serve-sim` into a public bucket, the npm mirror, and moves a `latest.json` pointer per package. EAS device sessions read the mirror first and npm second. They still run the latest release; nothing is pinned.

## Why

- EAS starts `npx --yes expo-device-hub@latest` for Android sessions and `npx --yes @expo/serve-sim@latest` for cold iOS sessions [observed: `createExpoDeviceHubArgs` and `createServeSimArgs` in expo/eas-cli `packages/build-tools/src/steps/utils/deviceSessionHost.ts`, 2026-11-16].
- Three Android sessions failed right after the 0.24.0 release: `latest` already resolved to 0.24.0, but the tarball download returned 404. It worked later [confirmed: SJ Kim, Slack, relayed 2026-11-16]. New releases of both packages take some time to pass the npm security scan [confirmed: Gabe Debes, Slack, relayed 2026-11-16].
- Cache the packages like the scrcpy server: the bucket first, then npm, and keep `latest` for now because releases are frequent; pinning can come later [confirmed: Krystof Woldrich, Slack, relayed 2026-11-16].

## Rejected options

- **Retry npm with a backoff.** The scan can take longer than a session can wait, and it does not help in an npm outage.
- **Use the newest version that npm serves.** It covers the scan delay but not an outage. It can be added to the npm fallback later.
- **Pin a version in EAS or in the worker image.** Every release would need an EAS change [confirmed: Krystof Woldrich, Slack, relayed 2026-11-16].
- **A pull-through npm proxy.** It passes the 404 of a new version through.

<a id="bucket-layout"></a>

## Bucket layout

The release workflow writes, under `NPM_MIRROR_URL` (for example `gs://turtle-v2/npm`, read at `https://storage.googleapis.com/turtle-v2/npm`):

| Object                        | Content                                    | Written                           | Cache-Control                         |
| ----------------------------- | ------------------------------------------ | --------------------------------- | ------------------------------------- |
| `<name>/-/<npm tarball name>` | The tarball, the same bytes as on npm      | Once, never replaced              | `public, max-age=31536000, immutable` |
| `<name>/<version>.json`       | The pointer of that version                | Once, never replaced              | `public, max-age=31536000, immutable` |
| `<name>/latest.json`          | The pointer of the newest mirrored release | Each release, only to a newer one | `no-cache, max-age=0`                 |

`<name>` is the npm name, so `@expo/serve-sim` is a directory. The tarball name is the one in npm's `dist.tarball`, for example `serve-sim-0.14.3.tgz`. A pointer is JSON with `name`, `version`, `tarball` (relative to `<name>/`), `integrity` (npm's sha512 `dist.integrity`) and `shasum`. EAS must check the downloaded tarball against `integrity`.

## Guarantees

- **The mirror has npm's bytes.** The release packs the package after `changeset publish`, and the upload stops if the sha512 is not npm's `dist.integrity`. The packed tarball and npm's tarball had the same sha512 for `expo-device-hub@0.24.0` and `@expo/serve-sim@0.14.3` [observed: the GitHub release assets from `scripts/create-github-releases.ts` against `npm view … dist`, 2026-11-16].
- **The pointer never names a missing or wrong tarball.** It is written last, after the public tarball reads back with the same sha512. One object write is atomic.
- **The pointer never moves back.** The upload skips an older version, and it writes with the generation it read, so two releases at the same time cannot replace a newer pointer with an older one.
- **Public objects are cached for an hour by default** [observed: `cache-control: public, max-age=3600` on `turtle-v2` objects, 2026-11-16], so the pointer sets `no-cache`.

## Limits

- Only the package is mirrored. Its dependencies still come from npm. They are released less often, so a new version of them is rarely missing.
- The mirror follows npm's `latest` only through releases. To roll back, move the npm dist-tag and copy `<old version>.json` over `latest.json`; `RELEASING.md` has the commands.
- The release needs write access to the bucket path. `turtle-v2` looks like it uses fine-grained ACLs, because the scrcpy copy changed its metadata after the upload [inferred: `metageneration` 2 on `scrcpy/v4.0/scrcpy-server-v4.0`, 2026-11-16]. In that case the upload sets `NPM_MIRROR_PREDEFINED_ACL=publicRead`, and an IAM condition cannot limit the write access to the `npm/` prefix.
