---
"@expo/hub-client": patch
---

On the iPhone Duo, `fold` now shows the hinge state that serve-sim reads from the simulator, so a fold made with the Simulator's own controls appears in `fold.angle`, `fold.pose`, `fold.tableMode`, and `fold.physical`. Before, `fold` showed only the state of the last command sent through serve-sim. A command's preview now holds until serve-sim reads the new state, or for at most 500 ms, and its `confirmed` event comes then.
