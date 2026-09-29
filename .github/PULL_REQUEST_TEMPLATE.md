## What

<!-- Describe the change and link relevant issues or context. -->

## Why

<!-- Explain the important decisions, alternatives, and trade-offs. -->

## Authorship and LLM use

<!-- Cover code, tests, documentation, and this PR description. A short, accurate account is enough; a session transcript is optional. Do not claim human review or testing that has not happened. -->

- **LLM involvement:** None / assisted / primarily LLM-generated. Name the tool and the parts it produced or changed.
- **Process and decisions:** What was the initial request? What approach was chosen, what alternatives or suggestions were rejected or corrected, and who made those decisions?
- **Iterations:** Briefly trace the initial draft and each meaningful review or refinement round. For each, name who requested, made, and reviewed the change (human or LLM). Update this after further PR edits.
- **Human involvement:** Who set the direction, edited the result, inspected the diff, or ran the tests? If a step had no human involvement, say "none."
- **Review status:** Has a human reviewed the final diff? If not, say "human review pending." Who can answer questions and maintain this change?

## Evidence

<!-- Match the evidence to the change. "Builds and typechecks" is not evidence. List checks and manual tests actually run, their results, and who ran them. Clearly mark anything still planned. -->

Check every line. Where a line does not apply, write `n/a` and why after it.

- [ ] `bun run lint` is green.
- [ ] `bun run build --filter='!@expo/serve-sim' --only` and `bunx turbo run typecheck --only` are green.
- [ ] `bun run test` is green.
- [ ] Device-backed tests for the touched area ran on a simulator or emulator you booted. Tests, device, and tool versions:
- [ ] The failing test came first. Commit:
- [ ] Evidence for this change type is below. UI: screenshot or video. CLI or native: the command and its output. Docs only: say so.

```
paste the command and its output here
```

## Rollback

<!-- Say "Plain revert" or explain what else a reverter needs to do. -->
