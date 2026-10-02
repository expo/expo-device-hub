---
'@expo/hub-client': minor
---

Add `DeviceClient.inputError`. On iOS it reports when serve-sim refuses the
input socket (too many clients or a full input queue) or reports
`inputUnavailable`, and clears when input works again. On Android it reports
a down WebRTC input socket.
