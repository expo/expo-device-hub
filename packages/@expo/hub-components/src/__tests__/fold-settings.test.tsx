import { describe, expect, test } from 'bun:test';
import { type DeviceHinge } from '@expo/hub-client';
import { renderToStaticMarkup } from 'react-dom/server';

import { FoldSettings, type FoldPreviewOption, MODEL_UNAVAILABLE_DESCRIPTION } from '../dashboard/FoldSettings';

function hinge(overrides: Partial<DeviceHinge> = {}): DeviceHinge {
  return {
    faceDown: false,
    activeScreenId: 1,
    pending: false,
    error: null,
    commands: { pending: false, coverDepartures: 0, innerDepartures: 0 },
    view: { rotation: [0, 0, 0, 1] },
    modelActive: true,
    modelUrl: 'http://hub.test/vendor/serve-sim/grid/api/devicekit-model',
    panels: null,
    setControl: () => {},
    sendModelTouch: () => {},
    sendModelMultiTouch: () => {},
    sendModelScroll: () => {},
    ...overrides,
  };
}

function preview(overrides: Partial<FoldPreviewOption> = {}): FoldPreviewOption {
  return {
    mode: '3d',
    onModeChange: () => {},
    cacheScreenOnFold: false,
    onCacheScreenOnFoldChange: () => {},
    sizeMode: 'fill',
    onSizeModeChange: () => {},
    ...overrides,
  };
}

function rowLabels(markup: string) {
  return [...markup.matchAll(/<span style="[^"]*font-weight:500[^"]*">([^<]+)<\/span>/g)].map((match) => match[1]);
}

describe('FoldSettings', () => {
  test('lists the fold rows in serve-sim order with the model options while 3D is shown', () => {
    const markup = renderToStaticMarkup(<FoldSettings hinge={hinge()} preview={preview()} />);
    expect(rowLabels(markup)).toEqual([
      'Fold pose',
      'Hinge angle',
      'Table Mode',
      'Preview mode',
      'Cache screen on fold',
      'Preview size',
    ]);
    expect(markup).toContain('aria-label="Fold settings"');
    expect(markup).toContain('>Unknown<');
    expect(markup).toContain('aria-valuetext="Unknown"');
    expect(markup).toMatch(/type="number"[^>]*value=""/);
    expect(markup).toContain('>3D<');
    expect(markup).toContain('>Fill available space<');
  });

  test('2D keeps the native fold controls and hides options that only affect the model', () => {
    const markup = renderToStaticMarkup(
      <FoldSettings hinge={hinge({ modelActive: false })} preview={preview({ mode: '2d' })} />,
    );
    expect(rowLabels(markup)).toEqual(['Fold pose', 'Hinge angle', 'Table Mode', 'Preview mode']);
    expect(markup).toContain('>2D<');
  });

  test('omits the preview rows when the consumer offers no 3D model', () => {
    const markup = renderToStaticMarkup(<FoldSettings hinge={hinge({ modelActive: false })} />);
    expect(rowLabels(markup)).toEqual(['Fold pose', 'Hinge angle', 'Table Mode']);
  });

  test("shows each named pose with serve-sim's labels and infers endpoints only without a reported pose", () => {
    for (const [pose, label] of [
      ['closed', 'Fully folded'],
      ['book', 'Partially open'],
      ['open', 'Fully open'],
      ['laptop', 'Laptop'],
      ['tent', 'Tent'],
    ] as const) {
      const markup = renderToStaticMarkup(<FoldSettings hinge={hinge({ angle: 90, pose })} />);
      expect(markup).toContain(`>${label}<`);
      expect(markup).not.toContain('>Custom<');
    }
    expect(renderToStaticMarkup(<FoldSettings hinge={hinge({ angle: 180 })} />)).toContain('>Fully open<');
    expect(renderToStaticMarkup(<FoldSettings hinge={hinge({ angle: 180, pose: null })} />)).toContain('>Custom<');
    expect(renderToStaticMarkup(<FoldSettings hinge={hinge({ angle: 42.5 })} />)).toContain('>Custom<');
  });

  test('offers an accessible slider and a decimal degree input', () => {
    const markup = renderToStaticMarkup(<FoldSettings hinge={hinge({ angle: 42.5 })} />);
    const slider = markup.match(/<input[^>]*aria-label="Hinge angle"[^>]*>/)?.[0];
    expect(slider).toBeDefined();
    for (const attribute of ['type="range"', 'min="0"', 'max="180"', 'step="1"', 'value="42.5"']) {
      expect(slider).toContain(attribute);
    }
    expect(markup).toContain('aria-valuetext="42.5 degrees"');
    const degrees = markup.match(/<input[^>]*aria-label="Hinge angle in degrees"[^>]*>/)?.[0];
    expect(degrees).toBeDefined();
    for (const attribute of ['type="number"', 'min="0"', 'max="180"', 'step="any"', 'value="42.5"']) {
      expect(degrees).toContain(attribute);
    }
  });

  test('makes Table Mode available only when supported in the current pose, but always lets it turn off', () => {
    const unavailable = renderToStaticMarkup(<FoldSettings hinge={hinge({ angle: 0 })} />);
    expect(unavailable).toMatch(/role="switch"[^>]*aria-label="Table Mode"[^>]* disabled=""/);
    const available = renderToStaticMarkup(
      <FoldSettings hinge={hinge({ angle: 80, pose: 'tent', tableMode: true, tableModeAvailable: true })} />,
    );
    expect(available).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*aria-label="Table Mode"/);
    expect(available).not.toMatch(/role="switch"[^>]*aria-label="Table Mode"[^>]* disabled=""/);
    const stuckOn = renderToStaticMarkup(<FoldSettings hinge={hinge({ tableMode: true, tableModeAvailable: false })} />);
    expect(stuckOn).not.toMatch(/role="switch"[^>]*aria-label="Table Mode"[^>]* disabled=""/);
    // The row is only its label and switch, with no description under it.
    for (const markup of [unavailable, available]) {
      expect(markup).not.toMatch(/aria-label="Table Mode"[^>]*aria-describedby/);
      expect(markup).not.toContain('rests on a table');
      expect(markup).not.toContain('not available in the current pose');
    }
  });

  test('keeps controls enabled while a change is pending and announces errors', () => {
    const pending = renderToStaticMarkup(
      <FoldSettings hinge={hinge({ angle: 90, pose: 'laptop', tableModeAvailable: true, pending: true })} preview={preview()} />,
    );
    expect(pending).toContain('aria-busy="true"');
    expect(pending).not.toMatch(/<(input|button)[^>]* disabled=""/);
    const failed = renderToStaticMarkup(
      <FoldSettings hinge={hinge({ error: 'Simulator could not change the device pose.' })} />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Simulator could not change the device pose.');
  });

  test('explains an unavailable model next to the preview choice', () => {
    const markup = renderToStaticMarkup(
      <FoldSettings hinge={hinge({ modelActive: false })} preview={preview({ unavailable: true })} />,
    );
    expect(markup).toContain(MODEL_UNAVAILABLE_DESCRIPTION);
    expect(markup).toContain('>2D<');
  });
});
