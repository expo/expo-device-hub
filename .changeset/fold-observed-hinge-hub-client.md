---
"@expo/hub-client": patch
---

On the iPhone Duo, `client.fold` shows the fold angle, pose, Table Mode, face down state, and active display that the simulator reports, so a fold made in Simulator's own controls shows up too. A change you request shows right away and holds until the simulator reports it, or for at most 500 ms after the command's config. The `confirmed` fold event has `observed: false` when that limit ran out before the simulator reported the change.
