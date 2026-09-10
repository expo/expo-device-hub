import { describe, expect, test } from 'bun:test';

import {
  type AccessibilityRead,
  loadAndroidAccessibility,
  loadIosAccessibility,
  parseAndroidAccessibility,
  parseIosAccessibility,
} from '../accessibility';
import { type SseFetch } from '../sse';
import { type AccessibilitySnapshot } from '../types';

const CAPTURED_AT = '2026-09-09T10:00:00.000Z';
const CAPTURED_AT_MS = Date.parse(CAPTURED_AT);

function snapshotOf(read: AccessibilityRead): AccessibilitySnapshot {
  if (!read.ok) throw new Error(read.error);
  return read.snapshot;
}

function androidNode(overrides: Record<string, unknown>) {
  return {
    id: 'n',
    text: '',
    contentDescription: '',
    resourceId: '',
    className: 'android.widget.TextView',
    packageName: 'com.app',
    clickable: false,
    enabled: true,
    bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    ...overrides,
  };
}

const ANDROID_ROOT = androidNode({
  id: 'root',
  className: 'android.widget.FrameLayout',
  bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
});

function androidBody(nodes: unknown) {
  return { ok: true, capturedAt: CAPTURED_AT, nodes };
}

function iosBody(elements: readonly unknown[], errors?: readonly string[]) {
  return { screen: { width: 390, height: 844 }, elements, ...(errors ? { errors } : {}) };
}

function iosElement(overrides: Record<string, unknown>) {
  return {
    id: 'e',
    path: '0/1',
    label: '',
    value: '',
    role: '',
    type: 'Other',
    enabled: true,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  };
}

describe('parseAndroidAccessibility', () => {
  test('normalizes bounds against the widest node and reads capturedAt', () => {
    const read = parseAndroidAccessibility(
      androidBody([
        ANDROID_ROOT,
        androidNode({ text: 'Sign in', bounds: { left: 108, top: 240, right: 540, bottom: 480 } }),
      ]),
    );
    const snapshot = snapshotOf(read);
    expect(snapshot.capturedAt).toBe(CAPTURED_AT_MS);
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]?.frame).toEqual({ x: 0.1, y: 0.1, width: 0.4, height: 0.1 });
  });

  test('prefers contentDescription, then text, then the resourceId tail', () => {
    const read = parseAndroidAccessibility(
      androidBody([
        ANDROID_ROOT,
        androidNode({ contentDescription: 'Close', text: 'X', resourceId: 'com.app:id/close' }),
        androidNode({ text: 'Body copy', resourceId: 'com.app:id/body' }),
        androidNode({ resourceId: 'com.app:id/submit_button' }),
      ]),
    );
    expect(snapshotOf(read).nodes.map((node) => node.label)).toEqual([
      'Close',
      'Body copy',
      'submit_button',
    ]);
  });

  test('drops nodes with no name and nodes with unusable bounds', () => {
    const read = parseAndroidAccessibility(
      androidBody([ANDROID_ROOT, androidNode({ text: 'Kept' }), androidNode({ bounds: null })]),
    );
    expect(snapshotOf(read).nodes.map((node) => node.label)).toEqual(['Kept']);
  });

  test('reads the class-name tail as the role and carries clickable and enabled', () => {
    const read = parseAndroidAccessibility(
      androidBody([
        ANDROID_ROOT,
        androidNode({ text: 'Tap me', className: 'android.widget.Button', clickable: true }),
        androidNode({ text: 'Dimmed', enabled: false }),
      ]),
    );
    const nodes = snapshotOf(read).nodes;
    expect(nodes[0]).toMatchObject({ role: 'Button', clickable: true, enabled: true });
    expect(nodes[1]).toMatchObject({ role: 'TextView', clickable: false, enabled: false });
  });

  test('returns an empty snapshot when the dump has no usable extent', () => {
    expect(snapshotOf(parseAndroidAccessibility(androidBody([]))).nodes).toEqual([]);
  });

  test('reports the message out of serve-emu\'s ApiFailure body', () => {
    const failure = {
      ok: false,
      error: { code: 'downstream_failed', message: 'read accessibility tree: adb timed out' },
    };
    expect(parseAndroidAccessibility(failure)).toEqual({
      ok: false,
      error: 'read accessibility tree: adb timed out',
    });
  });

  test('passes a flat string failure through', () => {
    expect(parseAndroidAccessibility({ ok: false, error: 'uiautomator timed out' })).toEqual({
      ok: false,
      error: 'uiautomator timed out',
    });
  });

  test('clamps a node scrolled off the top left', () => {
    const nodes = snapshotOf(
      parseAndroidAccessibility(
        androidBody([
          ANDROID_ROOT,
          androidNode({ text: 'Scrolled out', bounds: { left: -40, top: -20, right: 200, bottom: 100 } }),
        ]),
      ),
    ).nodes;
    expect(nodes[0].frame).toEqual({ x: 0, y: 0, width: 200 / 1080, height: 100 / 2400 });
  });

  test('drops nodes with no visible area', () => {
    const read = parseAndroidAccessibility(
      androidBody([
        ANDROID_ROOT,
        androidNode({ text: 'Collapsed', bounds: { left: 0, top: 300, right: 1080, bottom: 300 } }),
        androidNode({ text: 'Kept' }),
      ]),
    );
    expect(snapshotOf(read).nodes.map((node) => node.label)).toEqual(['Kept']);
  });

  test('rejects a malformed body', () => {
    for (const body of [null, 'nope', {}, { ok: true, nodes: [] }, androidBody('x')]) {
      expect(parseAndroidAccessibility(body)).toEqual({
        ok: false,
        error: 'Malformed accessibility response',
      });
    }
  });
});

describe('parseIosAccessibility', () => {
  test('normalizes frames against the reported screen and stamps capturedAt', () => {
    const read = parseIosAccessibility(
      iosBody([iosElement({ label: 'Sign in', frame: { x: 39, y: 84.4, width: 195, height: 42.2 } })]),
      CAPTURED_AT_MS,
    );
    const snapshot = snapshotOf(read);
    expect(snapshot.capturedAt).toBe(CAPTURED_AT_MS);
    expect(snapshot.nodes[0]?.frame).toMatchObject({ x: 0.1, y: 0.1, width: 0.5 });
    expect(snapshot.nodes[0]?.frame.height).toBeCloseTo(0.05);
  });

  test('falls back from label to value and from role to type', () => {
    const read = parseIosAccessibility(
      iosBody([
        iosElement({ label: 'Email', value: 'a@b.c', role: 'text field' }),
        iosElement({ value: 'Only a value', type: 'StaticText' }),
        iosElement({ label: 'Nameless sibling has none' }),
        iosElement({}),
      ]),
      CAPTURED_AT_MS,
    );
    const nodes = snapshotOf(read).nodes;
    expect(nodes.map((node) => node.label)).toEqual([
      'Email',
      'Only a value',
      'Nameless sibling has none',
    ]);
    expect(nodes[1]?.role).toBe('StaticText');
  });

  test('marks tappable roles clickable regardless of case', () => {
    const read = parseIosAccessibility(
      iosBody([
        iosElement({ label: 'Go', role: 'Button' }),
        iosElement({ label: 'Heading', role: 'StaticText' }),
      ]),
      CAPTURED_AT_MS,
    );
    expect(snapshotOf(read).nodes.map((node) => node.clickable)).toEqual([true, false]);
  });

  test('clamps an element that hangs off the screen', () => {
    const nodes = snapshotOf(
      parseIosAccessibility(
        iosBody([iosElement({ label: 'Sheet', frame: { x: -10, y: 800, width: 410, height: 120 } })]),
        CAPTURED_AT_MS,
      ),
    ).nodes;
    expect(nodes[0].frame).toEqual({ x: 0, y: 800 / 844, width: 1, height: 1 - 800 / 844 });
  });

  test('keeps only the visible part of a cell scrolled under the top edge', () => {
    const nodes = snapshotOf(
      parseIosAccessibility(
        iosBody([iosElement({ label: 'Cell', frame: { x: 0, y: -30, width: 390, height: 44 } })]),
        CAPTURED_AT_MS,
      ),
    ).nodes;
    expect(nodes[0].frame).toEqual({ x: 0, y: 0, width: 1, height: 14 / 844 });
  });

  test('drops an element scrolled fully off the screen', () => {
    const nodes = snapshotOf(
      parseIosAccessibility(
        iosBody([
          iosElement({ label: 'Gone', frame: { x: 0, y: -50, width: 390, height: 44 } }),
          iosElement({ label: 'Here' }),
        ]),
        CAPTURED_AT_MS,
      ),
    ).nodes;
    expect(nodes.map((node) => node.label)).toEqual(['Here']);
  });

  test('surfaces the helper errors instead of an empty tree', () => {
    expect(
      parseIosAccessibility(
        { screen: { width: 1, height: 1 }, elements: [], errors: ['Accessibility unavailable on this simulator.'] },
        CAPTURED_AT_MS,
      ),
    ).toEqual({ ok: false, error: 'Accessibility unavailable on this simulator.' });
  });

  test('rejects a malformed payload', () => {
    for (const body of [null, [], { elements: [] }, { screen: { width: 0, height: 0 }, elements: [] }]) {
      expect(parseIosAccessibility(body, CAPTURED_AT_MS)).toEqual({
        ok: false,
        error: 'Malformed accessibility response',
      });
    }
  });
});

describe('loadAndroidAccessibility', () => {
  test('reads the given URL without a cache and parses the body', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: SseFetch = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(Response.json(androidBody([ANDROID_ROOT, androidNode({ text: 'Hi' })])));
    };
    const read = await loadAndroidAccessibility(
      'http://emu/api/accessibility?device=emulator-5554',
      new AbortController().signal,
      fetchImpl,
    );
    expect(calls[0]?.url).toBe('http://emu/api/accessibility?device=emulator-5554');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(snapshotOf(read).nodes.map((node) => node.label)).toEqual(['Hi']);
  });

  test('reports the status when the body is not JSON', async () => {
    const fetchImpl: SseFetch = () => Promise.resolve(new Response('Bad Gateway', { status: 502 }));
    const read = await loadAndroidAccessibility(
      'http://emu/api/accessibility',
      new AbortController().signal,
      fetchImpl,
    );
    expect(read).toEqual({ ok: false, error: 'Accessibility read failed (HTTP 502)' });
  });
});

describe('loadIosAccessibility', () => {
  function axFetch(payloads: readonly unknown[]): SseFetch {
    return () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          for (const payload of payloads) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          }
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream));
    };
  }

  test('parses the newest block and stamps the read time', async () => {
    const read = await loadIosAccessibility(
      'http://sim/ax',
      new AbortController().signal,
      axFetch([
        iosBody([iosElement({ label: 'Stale' })]),
        iosBody([iosElement({ label: 'Fresh' })]),
      ]),
      () => CAPTURED_AT_MS,
    );
    const snapshot = snapshotOf(read);
    expect(snapshot.capturedAt).toBe(CAPTURED_AT_MS);
    expect(snapshot.nodes.map((node) => node.label)).toEqual(['Fresh']);
  });

  test('reports nothing when the signal is already aborted', async () => {
    const read = await loadIosAccessibility(
      'http://sim/ax',
      AbortSignal.abort(),
      axFetch([iosBody([])]),
      () => CAPTURED_AT_MS,
    );
    expect(read).toEqual({ ok: false, error: 'No accessibility snapshot received' });
  });

  test('rejects a block that is not JSON', async () => {
    const fetchImpl: SseFetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode('data: not-json\n\n'));
              controller.close();
            },
          }),
        ),
      );
    const read = await loadIosAccessibility(
      'http://sim/ax',
      new AbortController().signal,
      fetchImpl,
      () => CAPTURED_AT_MS,
    );
    expect(read).toEqual({ ok: false, error: 'Malformed accessibility response' });
  });
});
