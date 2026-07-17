import { type DeviceClient } from '@expo/hub-client';
import { bg, border, font, radius, text, textSize } from '../primitives';

/**
 * The selected device's foreground app — icon (or a letter avatar while none
 * is available), label, versions, and a React Native badge when the backend
 * detected one. Reads {@link DeviceClient.foregroundApp}, which is
 * best-effort: a placeholder shows until the backend reports an app, and the
 * detail fields fill in as the client resolves them (iOS fetches them over
 * the exec channel after the id arrives).
 */
export function CurrentAppSection({ client }: { client?: DeviceClient }) {
  const app = client?.foregroundApp ?? null;

  // Secondary line: the raw id (when a friendlier label is shown above) + pid.
  const details = app
    ? [app.label ? app.id : null, app.pid != null ? `pid ${app.pid}` : null].filter(Boolean)
    : [];

  // Meta line: marketing version (+ build) and the app's minimum OS.
  const meta = app
    ? [
        app.version ? `v${app.version}${app.build ? ` (${app.build})` : ''}` : null,
        app.minOS ? `min iOS ${app.minOS}` : null,
        app.minSdk != null ? `min SDK ${app.minSdk}` : null,
      ].filter(Boolean)
    : [];

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>Current app</span>
      {app ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '10px 12px',
            background: bg.default,
            border: `1px solid ${border.default}`,
            borderRadius: radius.md,
            minWidth: 0,
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <AppIcon iconDataUrl={app.iconDataUrl} name={app.label ?? app.id} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
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
                {app.isReactNative && <Badge color="info">React Native</Badge>}
                {app.debuggable && <Badge color="warning">debuggable</Badge>}
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
          </div>
          {meta.length > 0 && (
            <span
              style={{
                ...textSize.xs,
                color: text.tertiary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
              {meta.join(' · ')}
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

/** App icon, falling back to a letter avatar until a `data:` URL resolves. */
function AppIcon({ iconDataUrl, name }: { iconDataUrl?: string; name: string }) {
  const size = 32;
  if (iconDataUrl) {
    return (
      <img
        src={iconDataUrl}
        alt=""
        width={size}
        height={size}
        style={{ borderRadius: radius.md, flexShrink: 0 }}
      />
    );
  }
  // Letter avatar: the app label's first character, or the last bundle-id
  // segment's when only an id is known (com.apple.Preferences → "P").
  const initial = (name.includes('.') ? (name.split('.').pop() ?? name) : name)
    .charAt(0)
    .toUpperCase();
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius.md,
        background: bg.element,
        border: `1px solid ${border.default}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        ...textSize.sm,
        fontWeight: 600,
        color: text.secondary,
      }}>
      {initial}
    </div>
  );
}

function Badge({ color, children }: { color: 'info' | 'warning'; children: string }) {
  return (
    <span
      style={{
        ...textSize['2xs'],
        color: text[color],
        background: bg[color],
        borderRadius: radius.full,
        padding: '0 8px',
        flexShrink: 0,
      }}>
      {children}
    </span>
  );
}
