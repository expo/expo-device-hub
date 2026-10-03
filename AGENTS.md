# Pull requests

Complete the PR template's Authorship and LLM use section factually. Distinguish human direction from human inspection and approval; an agent-authored PR may say `human review pending`. Report which checks and manual tests actually ran, who ran them, and what remains planned.

Write PR descriptions for reviewers, not as chat transcripts. Summarize meaningful rounds in order: who set or changed the direction, what the LLM made, what review found, and what changed next. Skip minor wording exchanges and distinguish review of an earlier draft from review of the final diff.

# Linked Literate Programming (LLP)

This repo uses [LLP v0.5.2](https://github.com/ccheever/llp/tree/v0.5.2). One corpus at the repo root covers all packages, because the packages are tightly coupled. The spec is [LLP 0000](https://github.com/ccheever/llp/blob/v0.5.2/llp/0000-linked-literate-programming.explainer.md).

## LLP documents

- Documents live flat in `llp/` and are named `NNNN-slug.type.md`, for example `0003-serve-sim-input.explainer.md`. Sub-LLPs use dotted numbers: `0003.000-input-protocol.spec.md`. Never reuse a number, and never rename a document to move it.
- `llp/current/` and `llp/foundation/` hold relative symlinks only. `current/` is the work in progress: link a document when work starts and remove the link when the work is done. `foundation/` is the smallest set of `Active` documents from which the design could be recreated.
- Start with [LLP 0000](llp/0000-expo-device-hub.explainer.md), the root document. Then orient in this order: `llp/foundation/`, then `llp/current/`, then the `@ref`s in the code you touch.
- Every document starts with a header: `Type`, `Status`, `Systems`, `Author`, `Date`; optional `Role`, `Revised`, `Related`.
- Use these `Systems` names every time: `Hub`, `HubClient`, `HubComponents`, `AppleUtils`, `AndroidUtils`, `ServeSim`, `ServeEmu`, `Example`, `CI`, `Release`, `LLP`. LLP 0000 maps each name to its package. Add a name here before you use a new one.
- Types: RFC, Spec, Decision, Plan, Explainer, Principles, Guide, Issue, Research.
- Documents are living. When the design changes, update the document, or mark it `Superseded` or `Tombstoned` in the header. Do not leave a stale document unmarked.
- When an agent writes a "why" that it found by reading code, tag the claim `[observed]` (say where), `[confirmed]` (a named human and a date), or `[inferred]`. A document with `[inferred]` claims stays `Draft`.
- Write a Plan or RFC only when a human tells you about the future direction. Do not write speculative documents.

## @ref annotations

- When code implements a non-obvious decision documented in an LLP, add `// @ref LLP NNNN#section — short gloss`.
- When you change code that has a `@ref`, check that the section still applies. Update or remove the `@ref` if it does not.
- Do not annotate mechanically. A `@ref` must tell the reader something that the code and the file name do not.
- Land LLP updates in the same commit as the code change that caused them.
- Run `bun run llp:check` before you push. It runs `.llp/ref-check` (copied from LLP v0.5.2), a deterministic script that validates `@ref` targets, LLP headers, numbers, and the `current/` and `foundation/` links. CI runs it right after checkout, before any build. It also scans git-ignored build output such as `packages/expo-device-hub/vendor/`, so stale build output from another branch can make it fail locally; delete that output or run it on a clean checkout.

## Agent skills

The core LLP skills are installed once, in `.agents/skills/`, which Codex and other Agent Skills clients read. `.claude/skills` is a symlink to `../.agents/skills`, because Claude Code reads only `.claude/skills/`. `.llp/skills-receipt.json` records the release and the hash of each skill file and of `.llp/ref-check`. Do not edit the installed skill files. Run `/llp-adopt update` to update them.

The symlink is a deliberate exception to the LLP rule that installs are copies, never symlinks. Our reading of that rule is that it stops a skill from changing when an upstream checkout outside the repo changes, without a diff or a receipt update. Here the link target is a committed copy in this repo, so every change still goes through a git diff and the receipt hashes. When `/llp-adopt update` runs, write only to `.agents/skills/` and keep the symlink.

<!-- BEGIN LLP SKILLS MANAGED BLOCK -->
Before editing a subsystem with documented design, orient first: read its
governing LLP, and for non-trivial work invoke `llp-orient` to assemble a
context pack of the constraints the change must respect.

Skills: orient = context before coding · create = author one LLP · review = LLP 0005 loop, scaled to stakes · adopt = set up LLP in any repo, install/update the skills · maintain = drift / pre-PR / reconcile / retire / curate (promote → archive → realign, LLP 0011.000)
<!-- END LLP SKILLS MANAGED BLOCK -->
