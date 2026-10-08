import { describe, expect, test } from 'bun:test';
import { type DeviceClient, type DeviceHinge } from '@expo/hub-client';
import { renderToStaticMarkup } from 'react-dom/server';

import { PhoneFrame } from '../dashboard/PhoneFrame';
import { type Device } from '../dashboard/data';

const device: Device = {
  id: 'duo-1',
  name: 'iPhone Duo',
  version: 'iOS 27.1',
  platform: 'ios',
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: null,
};

function client(
  hinge: Partial<DeviceHinge> | null,
  displayCorners: DeviceClient['displayCorners'] = null,
): DeviceClient {
  return {
    status: 'streaming',
    screen: { width: 1398, height: 2034, orientation: 'portrait', screenId: 1 },
    displayCorners,
    hinge: hinge && {
      faceDown: false,
      activeScreenId: 1,
      pending: false,
      error: null,
      commands: { pending: false, coverDepartures: 0, innerDepartures: 0 },
      view: { rotation: [0, 0, 0, 1] },
      modelActive: false,
      modelUrl: null,
      panels: null,
      setControl: () => {},
      sendModelTouch: () => {},
      sendModelMultiTouch: () => {},
      sendModelScroll: () => {},
      ...hinge,
    },
  } as unknown as DeviceClient;
}

const FlatScreen = () => <div data-testid="flat-screen" />;
const ModelScreen = ({ sizeMode }: { sizeMode?: string }) => (
  <div data-testid="model-screen" data-size-mode={sizeMode} />
);

describe('PhoneFrame with an iPhone Duo', () => {
  test('uses serve-sim sizing for the flat cover and landscape inner display, with an animated handoff', () => {
    const render = (width: number, height: number) =>
      renderToStaticMarkup(
        <PhoneFrame
          device={device}
          client={{ ...client({ modelActive: false }), screen: { width, height } }}
          DeviceScreen={FlatScreen}
          displayScreen={(screen) => screen ?? null}
        />,
      );
    expect(render(1398, 2034)).toContain('width:min(320px,');
    expect(render(2853, 2007)).toContain('width:min(620px,');
    expect(render(2853, 2007)).toContain('aspect-ratio 250ms ease');
  });
  test('renders the injected 3D screen on a square stage without a screen clip', () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={device}
        client={client({ modelActive: true })}
        DeviceScreen={FlatScreen}
        FoldableDeviceScreen={ModelScreen}
        foldPreview={{ cacheScreenOnFold: false, sizeMode: 'physical', onUnavailable: () => {} }}
        displayScreen={(screen) => screen ?? null}
      />,
    );
    expect(markup).toContain('data-device-frame-kind="duo-model"');
    expect(markup).toContain('data-testid="model-screen"');
    expect(markup).toContain('data-size-mode="physical"');
    expect(markup).not.toContain('data-testid="flat-screen"');
    expect(markup).not.toContain('clip-path');
    expect(markup).toContain('aspect-ratio:1');
  });

  test('keeps the flat screen for the 2D preview and for consumers without the model', () => {
    for (const props of [
      { client: client({ modelActive: false }), FoldableDeviceScreen: ModelScreen },
      { client: client({ modelActive: true }), FoldableDeviceScreen: undefined },
      { client: client(null), FoldableDeviceScreen: ModelScreen },
    ]) {
      const markup = renderToStaticMarkup(
        <PhoneFrame
          device={device}
          DeviceScreen={FlatScreen}
          displayScreen={(screen) => screen ?? null}
          {...props}
        />,
      );
      expect(markup).toContain('data-testid="flat-screen"');
      expect(markup).not.toContain('duo-model');
      // The cover's own aspect ratio sizes the flat frame.
      expect(markup).toContain(`aspect-ratio:${1398 / 2034}`);
    }
  });
});

describe('PhoneFrame with a display that describes its own glass', () => {
  test('clips the flat Duo cover to its DeviceKit corners instead of the generic iPhone squircle', () => {
    const corners = {
      topLeft: 8 / 466,
      topRight: 59 / 466,
      bottomRight: 59 / 466,
      bottomLeft: 8 / 466,
    };
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={device}
        client={client({ modelActive: false }, corners)}
        DeviceScreen={FlatScreen}
        displayScreen={(screen) => screen ?? null}
      />,
    );
    expect(markup).toContain('data-display-corners="device"');
    // Hinge-side corners nearly square, outer corners round, all in container-width units.
    expect(markup).toContain('shape(from 1.717cqw -0.5px');
    expect(markup).toContain('calc(100% - 12.661cqw)');
    expect(markup).toContain('border-radius:1.717cqw 12.661cqw 12.661cqw 1.717cqw');
    // Circular corners: the control points are the circle's (0.5523 of the
    // radius), not the iOS superellipse's.
    expect(markup).toContain('with 6.992cqw 0 from start / 0 -6.992cqw from end');
    expect(markup).not.toContain('with 7.556cqw');
  });

  test('keeps the generic shape when the client describes no corners', () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame device={device} client={client(null)} DeviceScreen={FlatScreen} displayScreen={(screen) => screen ?? null} />,
    );
    expect(markup).not.toContain('data-display-corners');
    expect(markup).toContain('shape(from 14.066cqw -0.5px');
  });
});
