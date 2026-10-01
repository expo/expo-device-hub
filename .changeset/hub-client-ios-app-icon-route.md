---
'@expo/hub-client': patch
---

Read the iOS foreground app icon from serve-sim's `/api/apps/icon` route when `/api` advertises `appIconEndpoint`, so a tunneled server shows the icon without the exec-ws socket. Older servers still get the icon over exec-ws.
