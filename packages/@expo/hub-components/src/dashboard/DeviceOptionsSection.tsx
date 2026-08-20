import { type DeviceClient, type DeviceStreamMode } from '@expo/hub-client';

import { KeyboardSection } from './KeyboardSection';
import { OutputSection } from './OutputSection';
import { SidebarSectionHeading } from './SidebarRow';
import { StreamSection, type StreamModeAvailability } from './StreamSection';

/** All controls and output associated with the selected device. */
export function DeviceOptionsSection({
  client,
  streamMode,
  streamModeAvailability,
  onStreamModeChange,
}: {
  client?: DeviceClient;
  streamMode?: DeviceStreamMode;
  streamModeAvailability?: StreamModeAvailability;
  onStreamModeChange?: (mode: DeviceStreamMode) => void;
}) {
  return (
    <section
      aria-label="Device options"
      style={{
        display: 'flex',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        flexDirection: 'column',
      }}>
      <div style={{ padding: '8px 0' }}>
        <SidebarSectionHeading>Device options</SidebarSectionHeading>
      </div>
      {client?.platform === 'ios' && <KeyboardSection client={client} />}
      {streamMode &&
        streamModeAvailability &&
        onStreamModeChange &&
        client?.platform === 'ios' && (
          <StreamSection
            mode={streamMode}
            availability={streamModeAvailability}
            onChange={onStreamModeChange}
          />
        )}
      <OutputSection client={client} />
    </section>
  );
}
