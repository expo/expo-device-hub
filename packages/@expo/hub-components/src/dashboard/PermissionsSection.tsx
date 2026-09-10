import { useEffect, useState } from "react";

import { type AppPermissionState, type DeviceClient } from "@expo/hub-client";
import { Button } from "../primitives";
import { CollapsibleSection } from "./CollapsibleSection";
import { SectionNote } from "./SectionNote";
import { SidebarRow } from "./SidebarRow";

const STATE_LABELS: Record<AppPermissionState, string> = {
  granted: "Granted",
  denied: "Denied",
  limited: "Limited",
  undetermined: "Not asked",
};

/** Runtime permissions of the foreground app, with grant, revoke, and reset. */
export function PermissionsSection({
  client,
  defaultOpen = false,
}: {
  client: DeviceClient;
  /** Whether the section is initially expanded. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { permissions, permissionsPending, permissionsError, refreshPermissions } = client;
  const appId = client.foregroundApp?.id ?? null;

  useEffect(() => {
    if (open && appId) refreshPermissions();
  }, [open, appId, refreshPermissions]);

  return (
    <CollapsibleSection title="Permissions" open={open} onOpenChange={setOpen}>
      {appId === null ? (
        <SectionNote>No app is in the foreground.</SectionNote>
      ) : permissions === null ? (
        <SectionNote>Reading permissions…</SectionNote>
      ) : permissions.length === 0 ? (
        <SectionNote>This app declares no runtime permissions.</SectionNote>
      ) : (
        <>
          {permissions.map((permission) => {
            const pending = permissionsPending.has(permission.id);
            return (
              <SidebarRow
                key={permission.id}
                label={permission.label}
                description={pending ? "Updating…" : STATE_LABELS[permission.state]}
              >
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <Button
                    theme="secondary"
                    size="xs"
                    disabled={pending || permission.state === "granted"}
                    onClick={() => client.setPermission(permission.id, "grant")}
                  >
                    Grant
                  </Button>
                  <Button
                    theme="tertiary"
                    size="xs"
                    disabled={pending || permission.state === "denied"}
                    onClick={() => client.setPermission(permission.id, "revoke")}
                  >
                    Revoke
                  </Button>
                </div>
              </SidebarRow>
            );
          })}
          <div style={{ padding: "4px 0 12px" }}>
            <Button
              theme="tertiary"
              size="xs"
              disabled={permissionsPending.size > 0}
              onClick={client.resetPermissions}
            >
              Reset all
            </Button>
          </div>
        </>
      )}
      {permissionsError && <SectionNote role="alert">{permissionsError}</SectionNote>}
    </CollapsibleSection>
  );
}
