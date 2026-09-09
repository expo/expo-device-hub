import { useState } from "react";

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

  const capabilities = client.capabilities.location;
  if (capabilities === false) return null;

  const shown = draft ?? draftFromFix(client.location);
  const pending = client.locationPending;

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
    client.setLocation(fix);
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
      <SidebarRow label="Preset">
        <Select
          ariaLabel="Location preset"
          value={presetFor(shown)}
          options={PRESET_OPTIONS}
          disabled={pending}
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
          disabled={pending}
          invalid={inputError?.field === "latitude"}
          onChange={(value) => edit("latitude", value)}
          onPasteText={paste}
          onSubmit={applyDraft}
        />
      </SidebarRow>
      <SidebarRow label="Longitude">
        <SidebarTextInput
          ariaLabel="Longitude"
          value={shown.longitude}
          disabled={pending}
          invalid={inputError?.field === "longitude"}
          onChange={(value) => edit("longitude", value)}
          onPasteText={paste}
          onSubmit={applyDraft}
        />
      </SidebarRow>
      <div style={{ display: "flex", gap: 8, padding: "4px 0 8px" }}>
        <Button theme="secondary" size="xs" disabled={pending} onClick={applyDraft}>
          Set location
        </Button>
        {capabilities.clear && (
          <Button
            theme="tertiary"
            size="xs"
            disabled={pending}
            onClick={() => client.clearLocation()}
          >
            Clear
          </Button>
        )}
      </div>
      {pending && <SectionNote role="status">Updating location…</SectionNote>}
      {inputError && <SectionNote role="alert">{inputError.message}</SectionNote>}
      {client.locationError && <SectionNote role="alert">{client.locationError}</SectionNote>}
      <SectionNote>
        {client.location
          ? `Last set: ${formatFix(client.location)}`
          : "No fix set in this session."}
      </SectionNote>
    </CollapsibleSection>
  );
}
