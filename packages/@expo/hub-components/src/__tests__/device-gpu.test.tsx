import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeviceOptionsSection } from '../dashboard/DeviceOptionsSection';
import { LogSidebar } from '../dashboard/LogSidebar';

test('shows the runtime name, description, and full renderer tooltip', () => {
  const html = renderToStaticMarkup(<DeviceOptionsSection gpuBackend={{
    name: 'SwiftShader', renderer: 'ANGLE (Google, SwiftShader Device)', description: 'Software · ANGLE / Vulkan',
  }} />);
  expect(html).toContain('GPU backend');
  expect(html).toContain('>SwiftShader</span>');
  expect(html).toContain('Software · ANGLE / Vulkan');
  expect(html).toContain('title="ANGLE (Google, SwiftShader Device)"');
});

test('shows Unknown for an unavailable renderer and hides the row when omitted', () => {
  expect(renderToStaticMarkup(<DeviceOptionsSection gpuBackend={null} />)).toContain('>Unknown</span>');
  expect(renderToStaticMarkup(<DeviceOptionsSection />)).not.toContain('GPU backend');
});

test.each([
  ['ios', false, false],
  ['android', true, false],
  ['android', false, true],
] as const)('only shows GPU information for emulators (%s, physical=%s)', (platform, physical, visible) => {
  const html = renderToStaticMarkup(<LogSidebar
    device={{ id: 'test-device', name: 'Device', version: '1', platform, physical, booted: true, supported: true, deviceFrame: null }}
    gpuBackend={null}
  />);
  expect(html.includes('GPU backend')).toBe(visible);
});
