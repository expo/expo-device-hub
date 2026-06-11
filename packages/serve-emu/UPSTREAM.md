# Upstream sync

This package is a vendored copy of [jiunshinn/serve-emu](https://github.com/jiunshinn/serve-emu).

The last synced upstream commit is recorded in [`.upstream-commit`](./.upstream-commit).

## Pulling upstream commits

From a local clone of the upstream repo, export a commit as a patch and apply it into this monorepo under `packages/serve-emu`:

```sh
# in the upstream serve-emu clone
git format-patch -1 <commit-sha> --stdout > /tmp/serve-emu.patch

# in this monorepo root
git am --directory=packages/serve-emu /tmp/serve-emu.patch
```

Or as a single pipeline (run from the monorepo root, with upstream added as a remote or via a sibling clone):

```sh
git -C ../serve-emu format-patch -1 <commit-sha> --stdout | git am --directory=packages/serve-emu
```

After applying, update `.upstream-commit` with the new short hash:

```sh
git -C ../serve-emu rev-parse --short <commit-sha> > packages/serve-emu/.upstream-commit
```
