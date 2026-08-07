import { type DeviceClient } from '@expo/hub-client';
import { bg, radius, text, textSize } from '../primitives';

const APP_ICON_SIZE = 32;
const CURRENT_APP_CONTENT_MIN_HEIGHT = 129;

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
        app.build ? { label: 'Build Number', value: app.build } : null,
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
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          minHeight: APP_ICON_SIZE,
        }}>
        <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>Current app</span>
        <AppIcon iconDataUrl={app?.iconDataUrl} />
      </div>
      <div style={{ minHeight: CURRENT_APP_CONTENT_MIN_HEIGHT, minWidth: 0 }}>
        {app && name ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span
                title={name}
                style={{
                  ...textSize.sm,
                  fontWeight: 500,
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
            {details.map((detail) => (
              <AppDetailLine key={detail.label} detail={detail} />
            ))}
          </div>
        ) : (
          <span style={{ ...textSize.xs, fontWeight: 500, color: text.tertiary }}>
            No foreground app detected yet.
          </span>
        )}
      </div>
    </section>
  );
}

/** Keeps a stable heading slot while only rendering real app artwork. */
function AppIcon({ iconDataUrl }: { iconDataUrl?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'block',
        width: APP_ICON_SIZE,
        height: APP_ICON_SIZE,
        flexShrink: 0,
      }}>
      {iconDataUrl && (
        <img
          src={iconDataUrl}
          alt=""
          width={APP_ICON_SIZE}
          height={APP_ICON_SIZE}
          style={{ display: 'block', borderRadius: radius.md }}
        />
      )}
    </span>
  );
}

function AppDetailLine({ detail }: { detail: AppDetail }) {
  const fullText = `${detail.label} ${detail.value}`;
  return (
    <span
      title={fullText}
      style={{
        ...textSize.xs,
        color: text.secondary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      }}>
      {fullText}
    </span>
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
