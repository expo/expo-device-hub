import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { type AccessibilityRead } from '../accessibility';
import { useAccessibility } from '../useAccessibility';

let renderer: ReactTestRenderer | undefined;

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

function harness(load: (signal: AbortSignal) => Promise<AccessibilityRead>, timeoutMs: number) {
  const state = { current: undefined as ReturnType<typeof useAccessibility> | undefined };
  function Harness() {
    state.current = useAccessibility(load, timeoutMs);
    return null;
  }
  return { state, Harness };
}

test('reports a timeout when the backend never answers', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const never = (signal: AbortSignal) =>
    new Promise<AccessibilityRead>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error(signal.reason?.name ?? 'aborted')));
    });
  const { state, Harness } = harness(never, 20);

  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    state.current!.refreshAccessibility();
  });
  expect(state.current!.accessibilityPending).toBe(true);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  expect(state.current!.accessibilityError).toBe('The device did not answer in time');
  expect(state.current!.accessibilityPending).toBe(false);
  expect(state.current!.accessibility).toBeNull();
});
