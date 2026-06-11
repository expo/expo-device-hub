# expo-serve-sim

Expo DevTools plugin that serves the [`serve-sim`](../serve-sim) iOS Simulator
preview directly from the Expo CLI dev server.

## How it works

`expo-module.config.json` registers a `devtools` plugin with no `webpageRoot`.
Instead it points `serverEntryPoint` at `server/index.js`, a fetch-style
`handler(request)` that the Expo CLI invokes for every request under
`/_expo/plugins/expo-serve-sim/*`.

The entry point bridges serve-sim's Connect-style `simMiddleware((req, res, next))`
to the CLI's fetch `Request`/`Response` contract, streaming the middleware's
output (including its SSE routes) back through the fetch boundary.

`cliBanner` is enabled with `bannerTitle: "Simulator"`, so the dev server prints:

```
Simulator: http://localhost:8081/_expo/plugins/expo-serve-sim
```

## Usage

Add the package as a dependency of your Expo app; autolinking discovers the
DevTools plugin and the CLI serves it automatically when you run `expo start`.
