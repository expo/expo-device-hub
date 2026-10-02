---
"expo-device-hub": patch
---

Keep the Node server running when middleware rejects a POST and cancels its unread body. Return the rejection response and drain the remaining upload without closing the response socket.
