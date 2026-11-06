---
"@expo/hub-client": patch
---

On Android, `client.fold` reads the hinge again as soon as the stream switches displays, instead of waiting up to 5 seconds for the next poll.
