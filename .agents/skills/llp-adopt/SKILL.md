---
name: llp-adopt
description: Bring LLP to a repository or package and keep installed skills current. Scaffold, retrofit (survey + maintainer interview + provenance-tagged drafts), install from a tagged release, update without clobbering forks. Use when the user runs /llp-adopt, asks to set up LLP in a repo or package, or update the LLP skills.
source: ccheever/llp@v0.5.2
---

# llp-adopt

<!-- @ref https://github.com/ccheever/llp/blob/v0.5.2/llp/0001-adopting-llp.guide.md — the workflow this automates -->
<!-- @ref https://github.com/ccheever/llp/blob/v0.5.2/llp/0001.000-retrofit-interview.guide.md — survey + interview recipe -->
<!-- @ref https://github.com/ccheever/llp/blob/v0.5.2/llp/0010.000-skill-installation-and-updates.spec.md — install/update, receipts -->
<!-- @ref https://github.com/ccheever/llp/blob/v0.5.2/llp/0000-linked-literate-programming.explainer.md#provenance-for-generated-rationale — generated-doc tags -->

`/llp-adopt` (auto-detect scaffold / retrofit / scoped-package), `--mode scaffold|retrofit`, `--scope cwd|repo|<path>`, `--resume`, `--skip-interview`, or `/llp-adopt update`.

## Trigger

"Set up / bring LLP to this repo or package"; "update the LLP skills."

## Invariants — adoption

- MUST resolve an adoption root per LLP 0001 §Unit of adoption (walk up from cwd: nearest `llp/` to extend, else nearest package root, else git root) and write `llp/` there. MUST extend an existing `llp/` on the walk unless `--scope` explicitly nests. Never a second setup layer at the same root.
- MUST confirm the resolved root, mode, and interview on/off in one line before any write or full survey.
- MUST NOT survey a resolved root above LLP 0001's file-count brake without re-asking scope.
- MUST write only new files and marked managed blocks; never overwrite user prose or the run journal without a diff and ask. Reruns and `--resume` MUST be idempotent.
- MUST NOT draft retrofit LLPs until the maintainer interview has run, or `--skip-interview` was explicit (then *why* stays `[observed]`/`[inferred]` only).
- MUST ground every retrofit interview question in a named evidence card (LLP 0001). Ungrounded questions are a defect.
- MUST keep generated docs `Draft` and provenance-tagged: `[observed]` (say where), `[confirmed]` (named human + date), or `[inferred]` — `[inferred]` never proposed for promotion.
- MUST persist survey + interview state at the adoption root so a mid-run abort resumes.
- MUST propose `@ref`s and apply only after approval — no mass annotation.
- MUST NOT create a batch of speculative LLPs; first pass is the root plus at most two subsystem docs, then hand off.
- When a tool expects `CLAUDE.md`, symlink it to `AGENTS.md` when safe.

## Invariants — install and update (LLP 0010.000)

- MUST install only from a tagged release, as copies never symlinks, and write a receipt (origin, tag, resolved commit, profile flags, per-file hashes). The receipt — not `source:` — is the trust root for updates. Receipts and `.llp/policy.json` resolve at the git root or the user-global install, never at a scoped adoption root.
- MUST confirm before writing user/global skill directories; project-local may proceed more freely.
- Update MUST three-way-check each file against the receipt hash. A mismatch is a fork: abort the coupled update, never clobber, offer discard or detach.
- Update MUST present the profile changeset as one diff, revalidate before mutation, and be recoverable to either endpoint (receipt write is the commit point). Single-flight per installation.
- If upstream is unreachable, a tag moved or vanished, or content can't be verified: report exactly that and write nothing. Cannot-verify never degrades to guess.

## Workflow

> **Recipe (advisory)** — Inspect (`llp/`? package-in-monorepo? how much to mine?) then scaffold or retrofit; scope per LLP 0001. Spine: `llp/` + overlays, root 0000 (`Explainer`, `**Role:** Root`, `Draft` in `current/`), `AGENTS.md` at the adoption root. Retrofit: survey → interview → draft (LLP 0001.000). Install/update/release: LLP 0010.000.

## Artifact

Scaffold: `llp/` with overlays, LLP 0000 skeleton, managed blocks. Retrofit: those plus `.llp/adopt-run.md`, interview-backed `Draft` docs, a proposed `@ref` list, an adoption plan. Install/update: pinned copies, the receipt, optional repo policy file.

## Hand-offs

- Corpus exists → `llp-orient` daily (nearest `llp/` walking up from the path in scope); follow-on docs via `llp-create` against that root.
- Ratify with `llp-review` or `llp-super-refine` where stakes warrant; `llp-maintain` for health and stale pins → `/llp-adopt update`.
