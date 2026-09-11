import { expect, mock, spyOn, test } from 'bun:test';
import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import {
  reconcileDeviceList,
  type DeviceList,
} from '../../../../expo-device-hub/src/dashboard/useDevices';
import { DeviceListItem } from '../components/DeviceListItem';
import * as compactStatus from '../components/useCompactAgentDeviceStatus';
import { DeviceSection } from '../dashboard/DeviceSection';
import { type Device } from '../dashboard/data';

const IPHONE: Device = {
  id: 'first-ios',
  name: 'First iPhone',
  version: 'iOS 27.0',
  platform: 'ios',
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: 'ios:iphone-17-pro',
};

test('device snapshots render only rows whose device data changes', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;

  // This hook runs inside the actual DeviceListItem render. Count its stable
  // row refs without substituting the row component or its memo boundary.
  const renders = spyOn(compactStatus, 'useCompactAgentDeviceStatus').mockReturnValue(false);
  const onSelect = mock((_id: string) => {});
  const recent: Device[] = [];
  const options = { runtimes: [] };
  let devices: DeviceList = {
    simulators: [IPHONE, { ...IPHONE, id: 'second-ios', name: 'Second iPhone' }],
    emulators: [],
  };
  let renderer: ReactTestRenderer | undefined;

  const section = () => (
    <DeviceSection
      title="Simulators"
      addLabel="Add simulator"
      kind="simulator"
      emptyLabel="No simulators"
      devices={devices.simulators}
      recent={recent}
      options={options}
      selectedId={IPHONE.id}
      onSelect={onSelect}
    />
  );
  const update = async (snapshot: DeviceList) => {
    devices = reconcileDeviceList(devices, snapshot);
    await act(() => renderer!.update(section()));
  };
  const rowNames = () => renderer!.root.findAllByType(DeviceListItem).map((row) => row.props.name);
  const renderCount = (ref: object) =>
    renders.mock.calls.filter(([props]) => props.buttonRef === ref).length;

  try {
    await act(() => {
      renderer = create(section());
    });
    expect(rowNames()).toEqual(['First iPhone', 'Second iPhone']);
    expect(renders).toHaveBeenCalledTimes(2);
    const firstRef = renders.mock.calls[0][0].buttonRef;
    const secondRef = renders.mock.calls[1][0].buttonRef;

    await update(JSON.parse(JSON.stringify(devices)));
    expect(renderCount(firstRef)).toBe(1);
    expect(renderCount(secondRef)).toBe(1);

    const renamed = structuredClone(devices);
    renamed.simulators[1].name = 'Renamed iPhone';
    await update(renamed);
    expect(rowNames()).toEqual(['First iPhone', 'Renamed iPhone']);
    expect(renderCount(firstRef)).toBe(1);
    expect(renderCount(secondRef)).toBe(2);

    const third: Device = { ...IPHONE, id: 'third-ios', name: 'Third iPhone' };
    await update({
      ...structuredClone(devices),
      simulators: [{ ...third }, ...structuredClone(devices.simulators)],
    });
    expect(rowNames()).toEqual(['Third iPhone', 'First iPhone', 'Renamed iPhone']);
    expect(renders).toHaveBeenCalledTimes(4);
    const thirdRef = renders.mock.calls[3][0].buttonRef;
    expect(renderCount(firstRef)).toBe(1);
    expect(renderCount(secondRef)).toBe(2);
    expect(renderCount(thirdRef)).toBe(1);

    await update({
      ...structuredClone(devices),
      simulators: structuredClone(
        devices.simulators.filter((device) => device.id !== 'second-ios')
      ),
    });
    expect(rowNames()).toEqual(['Third iPhone', 'First iPhone']);
    expect(renders).toHaveBeenCalledTimes(4);
    expect(renderCount(firstRef)).toBe(1);
    expect(renderCount(thirdRef)).toBe(1);

    await update({ ...structuredClone(devices), simulators: [...devices.simulators].reverse() });
    expect(rowNames()).toEqual(['First iPhone', 'Third iPhone']);
    expect(renders).toHaveBeenCalledTimes(4);

    renderer!.root.findAllByType(DeviceListItem)[1].props.onClick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('third-ios');
  } finally {
    await act(() => renderer?.unmount());
    renders.mockRestore();
    if (previousActEnvironment === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
