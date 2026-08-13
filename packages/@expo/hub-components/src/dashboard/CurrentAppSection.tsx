import { type DeviceClient } from '@expo/hub-client';
import { bg, border, font, heading, icon, radius, text, textSize } from '../primitives';

const APP_ICON_SIZE = 52;

type AppDetail = {
  label: string;
  value: string;
};

/**
 * The selected device's foreground app — icon, label, versions, and a React
 * Native badge when the backend detected one. Reads
 * {@link DeviceClient.foregroundApp}, which is best-effort: a placeholder
 * shows until the backend reports an app, and the detail fields fill in as
 * the client resolves them (iOS fetches them over the exec channel after the
 * id arrives).
 */
export function CurrentAppSection({ client }: { client?: DeviceClient }) {
  const app = client?.foregroundApp ?? null;
  const name = app ? (app.label ?? app.id) : null;

  const details: AppDetail[] = app
    ? [
        app.version ? { label: 'Version', value: app.version } : null,
        app.build ? { label: 'Build number', value: app.build } : null,
        app.pid != null ? { label: 'PID', value: String(app.pid) } : null,
        app.label ? { label: 'App ID', value: app.id } : null,
        app.minOS
          ? { label: 'Minimum iOS', value: app.minOS }
          : app.minSdk != null
            ? { label: 'Minimum SDK', value: String(app.minSdk) }
            : null,
      ].filter((detail): detail is AppDetail => detail != null)
    : [];

  return (
    <section style={{ padding: '18px 20px 20px', borderBottom: `1px solid ${border.default}` }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 18,
        }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span style={{ ...textSize.xs, fontFamily: font.mono, color: text.tertiary }}>
            Current app
          </span>
          {app && name ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <span
                title={name}
                style={{
                  ...heading.xl,
                  color: text.default,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                {name}
              </span>
              {app.isReactNative && <Badge color="info">React Native</Badge>}
              {app.debuggable && <Badge color="warning">debuggable</Badge>}
            </div>
          ) : (
            <span style={{ ...heading.xl, color: text.tertiary }}>No app detected</span>
          )}
        </div>
        <AppIcon iconDataUrl={app?.iconDataUrl} />
      </div>
      {details.length > 0 && (
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr)',
            rowGap: 10,
            columnGap: 16,
            margin: 0,
          }}>
          {details.map((detail) => (
            <AppDetailLine key={detail.label} detail={detail} />
          ))}
        </dl>
      )}
    </section>
  );
}

function AppIcon({ iconDataUrl }: { iconDataUrl?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: APP_ICON_SIZE,
        height: APP_ICON_SIZE,
        flexShrink: 0,
        boxSizing: 'border-box',
        overflow: 'hidden',
        border: `1px solid ${border.default}`,
        borderRadius: radius.lg,
        backgroundColor: bg.element,
      }}>
      {iconDataUrl ? (
        <img
          src={iconDataUrl}
          alt=""
          width={APP_ICON_SIZE}
          height={APP_ICON_SIZE}
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="2" y="4" width="20" height="16" rx="2" stroke={icon.quaternary} />
          <path d="M10 4v4h12" stroke={icon.quaternary} />
        </svg>
      )}
    </span>
  );
}

function AppDetailLine({ detail }: { detail: AppDetail }) {
  return (
    <>
      <dt style={{ ...textSize.xs, color: text.tertiary }}>{detail.label}</dt>
      <dd
        title={detail.value}
        style={{
          ...textSize.xs,
          minWidth: 0,
          margin: 0,
          color: text.default,
          fontFamily: font.mono,
          textAlign: 'right',
          overflowWrap: 'anywhere',
          fontVariantNumeric: 'tabular-nums',
        }}>
        {detail.value}
      </dd>
    </>
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
