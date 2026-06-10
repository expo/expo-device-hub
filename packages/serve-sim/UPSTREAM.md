# Upstream sync

This package is a vendored copy of [EvanBacon/serve-sim](https://github.com/EvanBacon/serve-sim).

The last synced upstream commit is recorded in [`.upstream-commit`](./.upstream-commit).

## Pulling upstream commits

From a local clone of the upstream repo, export a commit as a patch and apply it into this monorepo under `packages/serve-sim`:

```sh
# in the upstream serve-sim clone
git format-patch -1 <commit-sha> --stdout > /tmp/serve-sim.patch

# in this monorepo root
git am --directory=packages/serve-sim /tmp/serve-sim.patch
```

Or as a single pipeline (run from the monorepo root, with upstream added as a remote or via a sibling clone):

```sh
git -C ../serve-sim format-patch -1 <commit-sha> --stdout | git am --directory=packages/serve-sim
```

After applying, update `.upstream-commit` with the new short hash:

```sh
git -C ../serve-sim rev-parse --short <commit-sha> > packages/serve-sim/.upstream-commit
```
