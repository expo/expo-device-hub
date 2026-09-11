import { type AddDeviceOutcome, type AddDeviceTarget, type Device } from '@expo/hub-components';

import { bootDevice, createDevice } from './deviceActions';
import { selectedDeviceRoute, selectDeviceRoute } from './deviceRoute';
import {
  useDeviceSessionStore,
  type createDeviceSessionStore,
  type LocalDeviceStartup,
} from './deviceSessionStore';

type Dependencies = {
  store: ReturnType<typeof createDeviceSessionStore>;
  boot: typeof bootDevice;
  create: typeof createDevice;
  navigate: typeof selectDeviceRoute;
  currentRoute: () => string;
  newRequestId: () => string;
};

/** The operation outlives its dialog. Only the request that started it owns its result. */
export function createDeviceStarter({
  store,
  boot,
  create,
  navigate,
  currentRoute,
  newRequestId,
}: Dependencies) {
  return async (target: AddDeviceTarget): Promise<AddDeviceOutcome> => {
    const duplicate = Object.values(store.getState().startups).some(
      (entry) =>
        entry.device.startup?.phase !== 'failed' &&
        entry.target.device.platform === target.device.platform &&
        (entry.target.kind === 'recent' && target.kind === 'recent'
          ? entry.target.device.id === target.device.id ||
            (target.device.platform === 'android' &&
              entry.target.device.name === target.device.name)
          : entry.target.device.name === target.device.name)
    );
    if (duplicate) return { ok: false, error: 'This device is already starting.' };

    const requestId = newRequestId();
    let action: 'create' | 'boot' = target.kind === 'new' ? 'create' : 'boot';
    const device: Device =
      target.kind === 'recent'
        ? { ...target.device, startup: { phase: 'booting' } }
        : {
            id: `pending-${requestId}`,
            name: target.device.name,
            version: target.device.version,
            platform: target.device.platform,
            physical: false,
            booted: false,
            supported: target.device.supported,
            deviceFrame: target.device.deviceFrame,
            startup: { phase: 'creating' },
          };
    let entry: LocalDeviceStartup = { requestId, device, target, pending: true };
    // Replace a previous failure for the same device rather than leaving a ghost row.
    const failed = Object.values(store.getState().startups).find(
      (item) =>
        item.device.startup?.phase === 'failed' &&
        item.device.platform === device.platform &&
        (item.device.id === device.id ||
          (device.platform === 'android' && item.device.name === device.name) ||
          (target.kind === 'new' &&
            item.target.kind === 'new' &&
            item.target.device.name === target.device.name &&
            item.target.device.runtime === target.device.runtime &&
            item.target.device.deviceType === target.device.deviceType))
    );
    if (failed) entry.requestId = failed.requestId;
    store.getState().putStartup(entry, true);
    navigate(device.id);

    const publish = (next: LocalDeviceStartup) => {
      const previousId = entry.device.id;
      entry = next;
      store.getState().putStartup(entry);
      // A background completion must not pull the viewer away from another device.
      if (previousId !== entry.device.id && currentRoute() === previousId) {
        navigate(entry.device.id, { replace: true });
      }
    };
    const fail = (message: string): AddDeviceOutcome => {
      publish({
        ...entry,
        pending: false,
        device: { ...entry.device, startup: { phase: 'failed', action, message } },
      });
      return { ok: false, error: message };
    };

    try {
      if (target.kind === 'new') {
        const created = await create(target.device, { boot: false });
        if (!created.id) return fail(created.error ?? 'The device could not be created.');
        action = 'boot';
        const createdDevice: Device = {
          ...entry.device,
          id: created.id,
          startup: { phase: 'booting' },
        };
        publish({
          ...entry,
          device: createdDevice,
          target: { kind: 'recent', device: createdDevice },
        });
      }
      const discovered = store.getState().discovery.booted;
      const alreadyRunning = [...discovered.simulators, ...discovered.emulators].find(
        (device) =>
          device.platform === entry.device.platform &&
          (device.id === entry.device.id ||
            (device.platform === 'android' && device.name === entry.device.name))
      );
      const result = alreadyRunning
        ? { id: alreadyRunning.id, error: null }
        : await boot(entry.device);
      if (!result.id) return fail(result.error ?? 'The device did not come online.');
      const bootedDevice: Device = {
        ...entry.device,
        id: result.id,
        booted: true,
        lastUsedAt: Date.now(),
      };
      publish({
        ...entry,
        pending: false,
        device: bootedDevice,
        target: { kind: 'recent', device: { ...bootedDevice, startup: undefined } },
      });
      return { ok: true };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}

export const startDevice = createDeviceStarter({
  store: useDeviceSessionStore,
  boot: bootDevice,
  create: createDevice,
  navigate: selectDeviceRoute,
  currentRoute: selectedDeviceRoute,
  newRequestId: () =>
    Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
      value.toString(16).padStart(8, '0')
    ).join(''),
});
