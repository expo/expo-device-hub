# serve-sim in the monorepo

`@expo/serve-sim` is a regular Bun workspace at `packages/serve-sim`. Its source
was imported from `expo/serve-sim` commit
`55fec25295316e9757bf376c136275b59aea3df5`, the revision pinned by
`expo-device-hub`. The import commit preserves that snapshot; the next commit
flattens the old nested package and removes its Bun lockfile. Dependencies and
development tools now resolve through the repository's root `bun.lock`.

## CI

The root [GitHub workflow](../../../.github/workflows/ci.yml) runs on pull
requests and pushes to `main`:

- The Ubuntu `check` job runs `serve-sim` lint and typechecking with the other
  workspaces. `--only` lets typechecking run without the macOS native build.
- The `serve-sim (EAS)` job checks out the monorepo, including the `serve-emu`
  workspace, then calls EAS CLI from `packages/serve-sim`. It runs
  `.eas/workflows/sim-test.yml` and waits for the result. EAS failure or
  cancellation makes the GitHub job fail; a successful submission alone does
  not pass CI. [EAS CLI workflow commands](https://github.com/expo/eas-cli#eas-workflowrun-file)
- On EAS, an Apple silicon macOS worker installs the root lockfile, builds
  `serve-sim`, packs and uploads `serve-sim-npm-package`, starts an iOS simulator,
  and runs the package's tests serially. The existing reboot-and-retry behavior
  is retained. The artifact is uploaded before testing so it remains available
  when tests fail.

The general root `bun run test` command continues to exclude `serve-sim`'s
native/simulator suite. The EAS job runs it explicitly with the required build
and simulator available. Each PR supplies its number as a concurrency input to
cancel superseded EAS runs; main pushes supply distinct GitHub run IDs. The old
standalone EAS lint/typecheck workflow is replaced by the Ubuntu job.

## How EAS finds the project and sources

EAS configuration stays next to the package's `app.json` in
`packages/serve-sim/.eas/workflows`. The existing `expo/serve-sim` EAS project ID
(`ba780de8-b202-4d47-ba03-832008afedfd`) stays in `app.json`. Commands run from this
project directory; the dependency-install step explicitly uses `../..` to
install at the monorepo root. Build, test, and pack commands run in the
`serve-sim` package. The pack step passes an absolute artifact path to
`eas/upload_artifact`, whose relative paths otherwise resolve from the checkout
root. [EAS monorepo setup](https://docs.expo.dev/build-reference/build-with-monorepos/),
[workflow working directories](https://docs.expo.dev/eas/workflows/syntax/#defaultsrunworking_directory)

CI deliberately omits `--ref`. EAS CLI uploads the checked-out repository,
including both device-server workspaces, and records `packages/serve-sim` as the
project directory. EAS therefore builds the same source checkout as GitHub CI,
without needing to change the EAS project's current GitHub repository link.
With `--ref`, EAS instead loads the source from the repository connected to the
EAS project. [EAS CLI source selection](https://github.com/expo/eas-cli#eas-workflowrun-file)

The EAS workflows use `workflow_dispatch`; GitHub Actions owns automatic
triggers. If switching to direct EAS GitHub triggers later, connect the EAS
project to `expo/expo-device-hub`, set its **Base directory** to
`packages/serve-sim`, and replace the GitHub dispatch job with EAS event
triggers to avoid duplicate runs. [Expo GitHub configuration](https://docs.expo.dev/build/building-from-github/#configure-your-repository-settings)

## Credentials and manual runs

Make the existing organization secret
`EXPO_DEV_EXPO_GITHUB_ROBOT_ACCESS_TOKEN` available to `expo/expo-device-hub`, or
create a repository secret with that name. Its Expo account must have access to
the `expo/serve-sim` EAS project. The GitHub job maps it to `EXPO_TOKEN` and fails
with a setup error when it is missing. Fork PRs run lint/typechecking but skip
the token-dependent EAS job. A maintainer can run the workflow from a reviewed
checkout using their EAS login or `EXPO_TOKEN`.

From the monorepo root:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck --only

# Local macOS build and tests (boot an iOS simulator first).
bun run --filter '@expo/serve-sim' build
bun run --filter '@expo/serve-sim' test

# Upload this checkout and run the macOS suite on EAS.
cd packages/serve-sim
npx eas-cli@23.2.0 workflow:run .eas/workflows/sim-test.yml --wait --non-interactive
```

The manual `.eas/workflows/build-release.yml` workflow also installs from the
monorepo root and produces the same npm artifact, without publishing it. Run it
from `packages/serve-sim` with `eas workflow:run` as above. The old nested GitHub
release workflow is removed because GitHub does not discover workflows under
packages. `@expo/serve-sim` remains excluded from Changesets publishing; moving
its npm publishing configuration is separate from this CI migration.
