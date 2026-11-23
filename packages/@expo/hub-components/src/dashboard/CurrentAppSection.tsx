import { useState } from "react";

import { type DeviceClient } from "@expo/hub-client";
import {
  bg,
  font,
  heading,
  icon,
  radius,
  text,
  textSize,
  tone,
  type Tone,
  truncate,
} from "../primitives";
import { ActivityCharts } from "./ActivityCharts";
import { CollapsibleSection } from "./CollapsibleSection";

/** Width and height of the app icon: the website's `size-15`. */
const APP_ICON_SIZE = 60;
const UNKNOWN_VALUE = "unknown";
/** What the card says while no app is in the foreground, as on the website. */
export const NO_APP_TEXT = "Open an app to view its details.";

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
 * The app is in a card in the look of the website's current app
 * (`SimulatorPreviewApp`): the icon, then the name over the app ID.
 */
export function CurrentAppSection({ client }: { client?: DeviceClient }) {
  const [open, setOpen] = useState(true);
  const app = client?.foregroundApp ?? null;
  const name = app ? (app.label ?? app.id) : null;

  const details: AppDetail[] = [
    { label: "App ID", value: app?.id ?? UNKNOWN_VALUE },
    { label: "Version", value: app?.version ?? UNKNOWN_VALUE },
    { label: "Build number", value: app?.build ?? UNKNOWN_VALUE },
  ];

  return (
    <CollapsibleSection title="Current app" open={open} onOpenChange={setOpen}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          margin: "8px 0",
          padding: "8px 16px 8px 8px",
          borderRadius: radius["2xl"],
          backgroundColor: bg.subtle,
        }}
      >
        <AppIcon iconDataUrl={app?.iconDataUrl} />
        <div style={{ display: "flex", minWidth: 0, flex: 1, flexDirection: "column", gap: 2 }}>
          <span
            title={name ?? undefined}
            style={
              name
                ? { ...heading.sm, ...truncate, color: text.default }
                : { ...textSize.xs, fontWeight: 500, color: text.default }
            }
          >
            {name ?? NO_APP_TEXT}
          </span>
          {app && app.label && (
            <span
              title={app.id}
              style={{ ...textSize.xs, ...truncate, lineHeight: 1.375, color: text.secondary }}
            >
              {app.id}
            </span>
          )}
          {(app?.isReactNative || app?.debuggable) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
              {app?.isReactNative && <Badge tone="info">React Native</Badge>}
              {app?.debuggable && <Badge tone="warning">debuggable</Badge>}
            </div>
          )}
        </div>
      </div>
      <dl style={{ margin: 0 }}>
        {details.map((detail) => (
          <AppDetailRow key={detail.label} detail={detail} />
        ))}
      </dl>
      {client?.capabilities.activity && <ActivityCharts client={client} />}
    </CollapsibleSection>
  );
}

function AppIcon({ iconDataUrl }: { iconDataUrl?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: APP_ICON_SIZE,
        height: APP_ICON_SIZE,
        flexShrink: 0,
        boxSizing: "border-box",
        overflow: "hidden",
        borderRadius: radius.xl,
        backgroundColor: bg.element,
      }}
    >
      {iconDataUrl ? (
        <img
          src={iconDataUrl}
          alt=""
          width={APP_ICON_SIZE}
          height={APP_ICON_SIZE}
          style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="2" y="4" width="20" height="16" rx="2" stroke={icon.secondary} strokeWidth={2} />
          <path d="M10 4v4h12" stroke={icon.secondary} strokeWidth={2} />
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
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "8px 0",
      }}
    >
      <dt
        style={{ ...textSize.sm, fontWeight: 500, flexShrink: 0, margin: 0, color: text.secondary }}
      >
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
          textAlign: "right",
          ...truncate,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {detail.value}
      </dd>
    </div>
  );
}

function Badge({ tone: badgeTone, children }: { tone: Tone; children: string }) {
  return (
    <span
      style={{
        ...textSize.xs,
        color: tone[badgeTone].text,
        background: tone[badgeTone].bg,
        borderRadius: radius.full,
        padding: "0 8px",
        fontWeight: 500,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}
