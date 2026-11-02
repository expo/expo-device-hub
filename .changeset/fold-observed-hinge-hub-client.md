---
"@expo/hub-client": patch
---

On the iPhone Duo, `client.fold` now shows the fold angle, pose, Table Mode, face down state, and active display that the simulator reports, so a fold made in Simulator's own controls shows up too. It updates as soon as the simulator reports a change, and a change you request shows right away until the simulator confirms it, for up to about half a second.
