---
"@expo/serve-sim": patch
"expo-device-hub": patch
---

A route that throws now answers 500 with the CORS headers of its server, as a returned error does, so an allowed page can read the status instead of a network error. This covers serve-sim's middleware, serve-emu's router, and the Hub around both backends. The body is a fixed `Internal Server Error`; the error goes to the log. Standalone serve-sim's fallback 500 no longer sends the error message.
