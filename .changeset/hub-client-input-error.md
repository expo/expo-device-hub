---
'@expo/hub-client': minor
---

Report when touch and keyboard input cannot reach the device, on `client.input`. On iOS it
reports when serve-sim refuses the input socket (too many clients or a full input queue) or
reports `inputUnavailable`, and clears when input works again. On Android it reports a down
WebRTC input socket.
