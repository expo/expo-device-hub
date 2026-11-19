---
"@expo/hub-client": minor
---

`@expo/hub-client/models` shows a device as its 3D model with the live screen: `DeviceModelScreen` takes the place of `DeviceScreen` for the iPhone Duo, the iPhone 18 Pro, the Pixel 9 Pro, and the Pixel 9 Pro Fold. `@expo/hub-client/models/catalog` tells which devices have a model without loading three.js, and its `useDeviceModelScreenClient` reads the part of the client that the 3D screen needs, as `useDeviceScreenClient` does for the flat screen, and the package has each model's GLB file as `@expo/hub-client/models/<file>.glb`. The entry needs `three` 0.186 or later and `three-mesh-bvh`, which are optional peer dependencies. An app that does not import it bundles neither three.js nor the models.
