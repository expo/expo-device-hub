# Recording PR reviewer evidence

This separate evidence branch contains measurement inputs, diagnostic harnesses
and reviewer instructions. It does not change the production PR branches.

- [recording-keyframes/](recording-keyframes/README.md): original per-run file-size/timestamp data and the method for
  checking the keyframe policy and rerunning the scenario comparison.
- [254-hid/](254-hid/README.md): raw-HID close-delivery diagnostic results, portable source-level
  harness and the committed regression/E2E commands.
- [251-loading/](251-loading/README.md): every browser loading trial, packet identity proof and the
  loopback range-server/browser harness.

Follow the commit-pinned links in the PR descriptions. To download the tools,
clone this branch, then detach at the evidence commit linked by the PR:

```sh
git clone --single-branch --branch gwdp/recording-reviewer-evidence https://github.com/expo/expo-device-hub.git recording-evidence
git -C recording-evidence switch --detach EVIDENCE_COMMIT_FROM_PR
```

Product checkouts and evidence tools are separate. Each folder states its source
head, dependencies, exact commands, metric definitions, expected contract and
measurement limits. Recompute original summaries first; use the replication
commands to collect new local data. A race frequency or timing observed locally
is not a promised result on every machine.

Prepared/personal MP4s and runtime state are deliberately excluded from this
branch. No tokens or Simulator credentials are required to inspect the data.
