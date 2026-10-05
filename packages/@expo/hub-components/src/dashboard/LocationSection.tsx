import { FeatureNotice } from "./FeatureNotice";
import { useId, useState } from "react";

import { type DeviceClient, type DeviceGeoFix } from "@expo/hub-client";
import { Button, Select } from "../primitives";
import { CollapsibleSection } from "./CollapsibleSection";
import { SectionNote } from "./SectionNote";
import { SidebarRow } from "./SidebarRow";
import { SidebarTextInput } from "./SidebarTextInput";
import {
  type CoordinateDraft,
  type CoordinateField,
  type GeoFixInputError,
  PRESET_OPTIONS,
  draftFromFix,
  formatFix,
  parseGeoFixInput,
  pastedPair,
  presetFix,
  presetFor,
} from "./geoFixInput";

/** Point the device at one coordinate: a preset, or a latitude/longitude typed by hand. */
export function LocationSection({
  client,
  defaultOpen = false,
}: {
  client: DeviceClient;
  /** Whether the section is initially expanded. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState<CoordinateDraft | null>(null);
  const [inputError, setInputError] = useState<GeoFixInputError | null>(null);
  const inputErrorId = useId();

  const capabilities =
    client.location.status !== "unsupported" ? { clear: client.location.canClear } : false;
  if (capabilities === false) return null;

  const shown = draft ?? draftFromFix(client.location.data ?? null);
  const pending = client.location.writes.pending.has("fix");
  const disabled = pending || client.location.status !== "ready";

  function edit(field: CoordinateField, value: string) {
    setInputError(null);
    setDraft({ ...shown, [field]: value });
  }

  function paste(text: string) {
    const pair = pastedPair(text);
    if (!pair) return false;
    setInputError(null);
    setDraft(pair);
    return true;
  }

  function apply(fix: DeviceGeoFix) {
    setInputError(null);
    client.location.set(fix);
  }

  function applyDraft() {
    const parsed = parseGeoFixInput(shown);
    if (!parsed.ok) {
      setInputError(parsed.error);
      return;
    }
    apply(parsed.fix);
  }

  return (
    <CollapsibleSection title="Location" open={open} onOpenChange={setOpen}>
      {client && <FeatureNotice feature={client.location} />}
      <SidebarRow label="Preset">
        <Select
          ariaLabel="Location preset"
          value={presetFor(shown)}
          options={PRESET_OPTIONS}
          disabled={disabled}
          onChange={(value) => {
            const fix = presetFix(value);
            if (!fix) return;
            setDraft(draftFromFix(fix));
            apply(fix);
          }}
        />
      </SidebarRow>
      <SidebarRow label="Latitude">
        <SidebarTextInput
          ariaLabel="Latitude"
          value={shown.latitude}
          disabled={disabled}
          invalid={inputError?.field === "latitude"}
          describedBy={inputError?.field === "latitude" ? inputErrorId : undefined}
          onChange={(value) => edit("latitude", value)}
          onPasteText={paste}
          onSubmit={applyDraft}
        />
      </SidebarRow>
      <SidebarRow label="Longitude">
        <SidebarTextInput
          ariaLabel="Longitude"
          value={shown.longitude}
          disabled={disabled}
          invalid={inputError?.field === "longitude"}
          describedBy={inputError?.field === "longitude" ? inputErrorId : undefined}
          onChange={(value) => edit("longitude", value)}
          onPasteText={paste}
          onSubmit={applyDraft}
        />
      </SidebarRow>
      <div style={{ display: "flex", gap: 8, padding: "4px 0 8px" }}>
        <Button theme="secondary" size="xs" disabled={disabled} onClick={applyDraft}>
          Set location
        </Button>
        {capabilities.clear && (
          <Button
            theme="tertiary"
            size="xs"
            disabled={disabled}
            onClick={() => client.location.clear()}
          >
            Clear
          </Button>
        )}
      </div>
      {pending && <SectionNote role="status">Updating location…</SectionNote>}
      {inputError && (
        <SectionNote id={inputErrorId} role="alert">
          {inputError.message}
        </SectionNote>
      )}
      {(client.location.writes.errors.get("fix")?.message ?? client.location.error?.message) && (
        <SectionNote role="alert">
          {(client.location.writes.errors.get("fix")?.message ?? client.location.error?.message)!}
        </SectionNote>
      )}
      {client.location.data !== undefined && (
        <SectionNote>
          {client.location.data
            ? `Last set: ${formatFix(client.location.data)}`
            : "No fix set in this session."}
        </SectionNote>
      )}
    </CollapsibleSection>
  );
}
