import { expect, mock, spyOn, test } from 'bun:test';
import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';

import * as dialog from '../components/Dialog';
import { type AddDeviceOutcome, type Device, type NewDeviceOptions } from '../dashboard/data';
import { RecentDevicesModal } from '../dashboard/RecentDevicesModal';
import { PhoneFrame } from '../dashboard/PhoneFrame';
import { DeviceTitle } from '../dashboard/DeviceTitle';
import { DeviceSection } from '../dashboard/DeviceSection';
import { createDeviceStarter } from '../../../../expo-device-hub/src/dashboard/startDevice';
import { createDeviceSessionStore } from '../../../../expo-device-hub/src/dashboard/deviceSessionStore';
import { type StartDeviceOutcome } from '../../../../expo-device-hub/src/dashboard/deviceActions';

const device: Device = {
  id: 'ios-udid',
  name: 'iPhone',
  version: 'iOS 27',
  platform: 'ios',
  booted: false,
  physical: false,
  supported: true,
  deviceFrame: 'ios:iphone-17-pro',
};
const options: NewDeviceOptions = { runtimes: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('closing the boot dialog leaves an immediate local device and its later failure', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  // Only replace the DOM portal; exercise the real form and its submission lifecycle.
  const content = spyOn(dialog, 'DialogContent').mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const store = createDeviceSessionStore();
  const booted = deferred<StartDeviceOutcome>();
  let route = '';
  const start = createDeviceStarter({
    store,
    boot: () => booted.promise,
    create: async () => {
      throw new Error('Unexpected create');
    },
    navigate: (id) => {
      route = id;
    },
    currentRoute: () => route,
    newRequestId: () => 'request',
  });
  const close = mock(() => {});
  let renderer: ReactTestRenderer | undefined;
  let submitted!: Promise<void>;
  try {
    await act(() => {
      renderer = create(
        <RecentDevicesModal
          open
          kind="simulator"
          devices={[device]}
          options={options}
          onAdd={start}
          onClose={close}
        />
      );
    });
    await act(() => {
      submitted = renderer!.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    expect(store.getState().simulators).toHaveLength(1);
    expect(store.getState().selectedDevice?.startup?.phase).toBe('booting');
    const cancel = renderer!.root
      .findAllByType('button')
      .find((button) =>
        button.children.some(
          (child) =>
            typeof child === 'object' && 'children' in child && child.children.includes('Close')
        )
      );
    expect(cancel).toBeDefined();
    expect(cancel!.props.disabled).toBeFalsy();
    await act(() => {
      renderer!.root.findByType(dialog.DialogRoot).props.onOpenChange(false);
    });
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => {
      booted.resolve({ id: null, error: 'Unable to start: device is unavailable' });
      await submitted;
    });
    expect(store.getState().selectedDevice?.startup).toEqual({
      phase: 'failed',
      action: 'boot',
      message: 'Unable to start: device is unavailable',
    });
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await act(() => renderer?.unmount());
    content.mockRestore();
    environment.IS_REACT_ACT_ENVIRONMENT = previousEnvironment;
  }
});

test.each([true, false])(
  'a dismissed request (success=%s) cannot affect a reopened dialog',
  async (success) => {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    const content = spyOn(dialog, 'DialogContent').mockImplementation(({ children }) => (
      <>{children}</>
    ));
    const first = deferred<AddDeviceOutcome>();
    const second = deferred<AddDeviceOutcome>();
    const onAdd = mock().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const close = mock(() => {});
    const view = (open: boolean) => (
      <RecentDevicesModal
        open={open}
        kind="simulator"
        devices={[device]}
        options={options}
        onAdd={onAdd}
        onClose={close}
      />
    );
    let renderer: ReactTestRenderer | undefined;
    let firstSubmission!: Promise<void>;
    let secondSubmission!: Promise<void>;
    try {
      await act(() => {
        renderer = create(view(true));
      });
      await act(() => {
        firstSubmission = renderer!.root.findByType('form').props.onSubmit({ preventDefault() {} });
      });
      await act(() => renderer!.update(view(false)));
      await act(() => renderer!.update(view(true)));
      await act(() => {
        secondSubmission = renderer!.root
          .findByType('form')
          .props.onSubmit({ preventDefault() {} });
      });
      await act(async () => {
        first.resolve(success ? { ok: true } : { ok: false, error: 'Old request failed' });
        await firstSubmission;
      });
      expect(close).not.toHaveBeenCalled();
      expect(renderer!.root.findByProps({ type: 'submit' }).props.disabled).toBe(true);
      await act(async () => {
        second.resolve({ ok: false, error: 'Second device failed' });
        await secondSubmission;
      });
      expect(renderer!.root.findByProps({ role: 'alert' }).children.join('')).toBe(
        'Second device failed'
      );
      expect(close).not.toHaveBeenCalled();
    } finally {
      await act(() => renderer?.unmount());
      content.mockRestore();
      environment.IS_REACT_ACT_ENVIRONMENT = previousEnvironment;
    }
  }
);

test('creation, boot and failure are visible in the frame, title and device row', () => {
  for (const startup of [
    { phase: 'creating' } as const,
    { phase: 'booting' } as const,
    {
      phase: 'failed',
      action: 'boot',
      message: 'The emulator exited before coming online.',
    } as const,
  ]) {
    const local = { ...device, startup };
    const label =
      startup.phase === 'creating'
        ? 'Creating…'
        : startup.phase === 'booting'
          ? 'Booting…'
          : 'Boot failed';
    const frame = renderToStaticMarkup(
      <PhoneFrame
        device={local}
        available={false}
        DeviceScreen={() => null}
        displayScreen={() => null}
        onRetry={() => {}}
      />
    );
    expect(frame).toContain(label);
    expect(frame).not.toContain('Device unavailable');
    expect(renderToStaticMarkup(<DeviceTitle device={local} status="idle" />)).toContain(label);
    const sidebar = renderToStaticMarkup(
      <DeviceSection
        title="Simulators"
        kind="simulator"
        addLabel="Add"
        emptyLabel="Empty"
        devices={[local]}
        recent={[]}
        options={options}
        selectedId={local.id}
        offlineDeviceId={local.id}
        onSelect={() => {}}
      />
    );
    expect(sidebar).toContain(label);
    expect(sidebar).not.toContain('Offline');
    if (startup.phase === 'failed') {
      expect(frame).toContain('role="alert"');
      expect(frame).toContain(startup.message);
      expect(frame).toContain('Try again');
    }
  }
});
