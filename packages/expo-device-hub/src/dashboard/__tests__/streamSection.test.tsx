import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { StreamSection } from '../../../../@expo/hub-components/src/dashboard/StreamSection';

test('shows the configured codec while WebRTC is selected', () => {
  const html = renderToStaticMarkup(
    <StreamSection
      mode="webrtc"
      availability={{ mjpeg: true, h264: true, webrtc: true }}
      onChange={() => {}}
      webRtcCodec="vp8"
      onWebRtcCodecChange={() => {}}
    />,
  );

  expect(html).toContain('aria-label="WebRTC codec"');
  expect(html).toMatch(/aria-pressed="true"[^>]*>VP8<\/button>/);
});
