import { type DeviceClient } from '@expo/hub-client';
import { bg, border, font, radius, text, textSize } from '../primitives';

/**
 * The selected device's foreground app — label (or bundle/package id), the id +
 * pid detail line, and a React Native badge when the backend detected one.
 * Reads {@link DeviceClient.foregroundApp}, which is best-effort: a placeholder
 * shows until the backend reports an app.
 */
export function CurrentAppSection({ client }: { client?: DeviceClient }) {
  const app = client?.foregroundApp ?? null;

  // Secondary line: the raw id (when a friendlier label is shown above) + pid.
  const details = app
    ? [app.label ? app.id : null, app.pid != null ? `pid ${app.pid}` : null].filter(Boolean)
    : [];

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>Current app</span>
      {app ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            padding: '8px 12px',
            background: bg.default,
            border: `1px solid ${border.default}`,
            borderRadius: radius.md,
            minWidth: 0,
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span
              style={{
                ...textSize.sm,
                fontWeight: 500,
                color: text.default,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
              {app.label ?? app.id}
            </span>
            {app.isReactNative && (
              <span
                style={{
                  ...textSize['2xs'],
                  color: text.info,
                  background: bg.info,
                  borderRadius: radius.full,
                  padding: '0 8px',
                  flexShrink: 0,
                }}>
                React Native
              </span>
            )}
          </div>
          {details.length > 0 && (
            <span
              style={{
                ...textSize.xs,
                fontFamily: font.mono,
                color: text.secondary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
              {details.join(' · ')}
            </span>
          )}
        </div>
      ) : (
        <span style={{ ...textSize.xs, fontWeight: 500, color: text.tertiary }}>
          No foreground app detected yet.
        </span>
      )}
    </section>
  );
}
