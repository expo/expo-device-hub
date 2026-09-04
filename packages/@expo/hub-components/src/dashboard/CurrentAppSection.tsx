import { type DeviceClient } from '@expo/hub-client';
import { bg, border, font, heading, icon, radius, text, textSize } from '../primitives';
import { SIDEBAR_SECTION_INSET } from './CollapsibleSection';

const APP_ICON_SIZE = 40;
const UNKNOWN_VALUE = 'unknown';

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
 *
 * Laid out like the collapsible inspector sections: a section title row, then
 * label/value rows in the same type scale.
 */
export function CurrentAppSection({ client }: { client?: DeviceClient }) {
  const app = client?.foregroundApp ?? null;
  const name = app ? (app.label ?? app.id) : UNKNOWN_VALUE;

  const details: AppDetail[] = [
    { label: 'App ID', value: app?.id ?? UNKNOWN_VALUE },
    { label: 'Version', value: app?.version ?? UNKNOWN_VALUE },
    { label: 'Build number', value: app?.build ?? UNKNOWN_VALUE },
    client?.platform === 'android'
      ? {
          label: 'Minimum SDK',
          value: app?.minSdk != null ? String(app.minSdk) : UNKNOWN_VALUE,
        }
      : { label: 'Minimum iOS', value: app?.minOS ?? UNKNOWN_VALUE },
    { label: 'PID', value: app?.pid != null ? String(app.pid) : UNKNOWN_VALUE },
  ];

  return (
    <section
      aria-label="Current app"
      style={{ minWidth: 0, boxSizing: 'border-box', padding: `0 ${SIDEBAR_SECTION_INSET}px 12px` }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '18px 0' }}>
        <span style={{ ...heading.sm, color: text.default }}>Current app</span>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '4px 0 12px',
        }}>
        <div style={{ display: 'flex', minWidth: 0, flexDirection: 'column', gap: 4 }}>
          <span
            title={name}
            style={{
              ...heading.base,
              color: app ? text.default : text.tertiary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
            {name}
          </span>
          {(app?.isReactNative || app?.debuggable) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {app?.isReactNative && <Badge color="info">React Native</Badge>}
              {app?.debuggable && <Badge color="warning">debuggable</Badge>}
            </div>
          )}
        </div>
        <AppIcon iconDataUrl={app?.iconDataUrl} />
      </div>
      <dl style={{ margin: 0 }}>
        {details.map((detail) => (
          <AppDetailRow key={detail.label} detail={detail} />
        ))}
      </dl>
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
        border: iconDataUrl ? undefined : `1px solid ${border.default}`,
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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="2" y="4" width="20" height="16" rx="2" stroke={icon.quaternary} />
          <path d="M10 4v4h12" stroke={icon.quaternary} />
        </svg>
      )}
    </span>
  );
}

/** One label/value line, in the same scale as the other sections' rows. */
function AppDetailRow({ detail }: { detail: AppDetail }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '8px 0',
      }}>
      <dt style={{ ...textSize.sm, flexShrink: 0, margin: 0, color: text.secondary }}>
        {detail.label}
      </dt>
      <dd
        title={detail.value}
        style={{
          ...textSize.sm,
          minWidth: 0,
          margin: 0,
          color: text.default,
          fontFamily: font.mono,
          textAlign: 'right',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
        }}>
        {detail.value}
      </dd>
    </div>
  );
}

function Badge({ color, children }: { color: 'info' | 'warning'; children: string }) {
  return (
    <span
      style={{
        ...textSize.xs,
        color: text[color],
        background: bg[color],
        borderRadius: radius.full,
        padding: '0 8px',
        fontWeight: 500,
        flexShrink: 0,
      }}>
      {children}
    </span>
  );
}
