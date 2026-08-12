import { icon, radius, text, textSize } from '../theme/tokens';

/** Reserved device-row status that appears without shifting the device name. */
export function AgentDeviceStatus({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden={!active}
      data-agent-device-status={active ? 'active' : 'inactive'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        flexShrink: 0,
        visibility: active ? 'visible' : 'hidden',
        color: text.info,
        ...textSize['2xs'],
      }}>
      <span
        data-agent-device-badge
        style={{
          width: 7,
          height: 7,
          flexShrink: 0,
          borderRadius: radius.full,
          backgroundColor: icon.info,
        }}
      />
      Used by agent
    </span>
  );
}
