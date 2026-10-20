# LLP 0014: serve-sim Xcode support and CI

**Type:** Decision
**Status:** Draft
**Systems:** ServeSim, CI, Release
**Author:** Gabe Debes
**Date:** 2026-10-17
**Related:** LLP 0000, LLP 0004, LLP 0010

## Summary

serve-sim is published from an Xcode 26 build and supports Xcode 26 and Xcode 27. A PR that is ready for review tests the published build on the iOS 26 and iOS 27 Simulators; a draft does so only with the `ci-ready` label. An Xcode 27 build, for users who build from source, is tested every night and on a PR with the `xcode-27` label.

## Support statement

| Build                                            | Built with                                      | Tested on                                                                                                 | When                                                                                 |
| ------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Published package (`latest` and `canary` on npm) | Xcode 26.6, image `macos-tahoe-26.5-xcode-26.6` | iOS 26.5 Simulator (Xcode 26 image) and iOS 27.0 Simulator (Xcode 27 image `macos-tahoe-26.6-xcode-27.1`) | Every push to a PR that is ready for review, or to a draft with the `ci-ready` label |
| Source build                                     | Xcode 27.1, image `macos-tahoe-26.6-xcode-27.1` | iOS 27.0 Simulator                                                                                        | Every night on `main`, and every push to a PR with the `xcode-27` label              |

- Releases are built with Xcode 26, so that the published package runs for users on Xcode 26 [confirmed: Gabe Debes, 2026-10-17].
- Xcode 27 is supported too: the published package must pass on the iOS 27 Simulator, and the source must build and pass with Xcode 27 [confirmed: Gabe Debes, 2026-10-17].
- Fixture apps adopt the scene lifecycle. UIKit stops an app linked with the iOS 27 SDK at launch if it does not; the crash report shows SIGTRAP in `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` [observed: Xcode 27.1 on iOS 27.0, 2026-10-17].

## Release build pin

The release build uses the image above, not `image: latest`. With `latest`, an EAS image update changed the SDK that compiles serve-sim's native code without a change in this repository [observed: `main`'s `sim-test.yml` used `image: latest`, which became the Xcode 27 image, 2026-10-17]. The pinned EAS builder runs `bun run build --force` to write fresh cache entries. The Ubuntu release job waits for that build and reads those entries with normal `bun run build` [observed: `.eas/workflows/build-release-cache.yml`, `.github/workflows/release.yml`]. `RELEASING.md` says how to move releases to a new image.

## When CI runs

- **Checks** (lint and typecheck) run on every PR push [observed: `.eas/workflows/checks.yml`].
- **serve-sim tests** run on every push to a PR that is ready for review, and when a draft becomes ready. A draft runs them only with the `ci-ready` label: adding the label starts a run, and each later push runs again while the label stays. Iterate on a draft without the label [confirmed: Gabe Debes, 2026-10-17; observed: the `types` and `if` of the `pull_request` trigger in `.eas/workflows/sim-test.yml`]. A run builds the package and fixtures once with Xcode 26, then runs the unit shards and two Simulator jobs on each runtime: one job runs `*.slow.e2e.test.ts`, the other runs the rest. `.eas/functions/test-sim-runtime` selects each group.
- **serve-sim Xcode 27 build** runs every night at 06:17 GMT, and on any PR, draft or ready, while it has the `xcode-27` label: adding the label starts a run [confirmed: Gabe Debes, 2026-10-17; observed: `.eas/workflows/sim-test-xcode27.yml`]. EAS runs scheduled workflows only from the default branch [observed: EAS Workflows syntax reference, `on.schedule.cron`].
- A ready PR cannot skip the serve-sim checks, but GitHub blocks a merge on a failed or missing check only if the repository requires it, and `main` requires none [observed: GitHub API, no required status checks on `main`, 2026-10-17].

## Why

- **Time.** The e2e files run one at a time, and one runtime took up to 19 minutes on one machine. With the two-way split, the run on `db6d746` took 14.0 minutes of wall time, against 23.5 minutes before [observed: EAS workflow runs, 2026-10-17].
- **Cost.** A serve-sim run uses 6 macOS jobs: the build, the unit shards, and four Simulator jobs. The Xcode 27 build adds 3 more, which is why it runs nightly. AI-assisted PRs get many pushes while they are drafts, so drafts skip the run by default, and a ready PR always runs it [confirmed: Gabe Debes, 2026-10-17].
- **Xcode 27 source builds.** They matter only to users who build from source, and their failures come from SDK changes, not from most PRs. A nightly run finds them within a day, and the `xcode-27` label tests a PR that changes native code [confirmed: Gabe Debes, 2026-10-17].

## Changing this

- **New Xcode for releases:** change the release image in `sim-test.yml` and `build-release-cache.yml` together, as `RELEASING.md` says, and update the table above.
- **Add or remove a Simulator runtime:** add or remove its two jobs (`group: slow` and `group: rest`) in `.eas/workflows/sim-test.yml`, and update the table above.
- **Rebalance the split:** add or remove the `.slow` marker in the e2e filename. A new e2e file without that marker lands in the "rest" job.
