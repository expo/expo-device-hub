import { PhoneIcon, bg, border, heading, icon, radius, shadow, text, textSize } from '../primitives';
import { type Platform } from './data';

/**
 * Shown in the stream panel when no devices are available — i.e. there are no
 * booted simulators, emulators, or connected physical devices to mirror. Points
 * the user at the sidebar's + buttons to boot one.
 */
export function EmptyState({ platform }: { platform?: Platform }) {
  const title =
    platform === 'ios'
      ? 'No booted simulators'
      : platform === 'android'
        ? 'No booted emulators'
        : 'No booted devices';
  const description =
    platform === 'ios'
      ? 'There are no booted simulators. Use the + button to add one.'
      : platform === 'android'
        ? 'There are no booted emulators or connected devices. Use the + button to add one.'
        : 'There are no booted simulators, emulators, or connected devices. Use the + button to add a simulator or emulator.';

  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 40,
        // Match StreamPanel: half margin on the sides so the card sits closer to
        // the resize seams; full top/bottom margin keeps its vertical framing.
        margin: '16px 8px',
        boxSizing: 'border-box',
        backgroundColor: bg.default,
        border: `1px solid ${border.secondary}`,
        borderRadius: radius.lg,
        boxShadow: shadow.sm,
        overflow: 'hidden',
        textAlign: 'center',
      }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 56,
          height: 56,
          borderRadius: radius.full,
          border: `1px solid ${border.secondary}`,
          backgroundColor: bg.subtle,
        }}>
        <PhoneIcon size={28} color={icon.secondary} />
      </div>
      <h2 style={{ ...heading.lg, color: text.default, margin: 0 }}>{title}</h2>
      <p style={{ ...textSize.sm, color: text.secondary, margin: 0, maxWidth: 320 }}>
        {description}
      </p>
    </section>
  );
}
