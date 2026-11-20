import { type DeviceClient } from "@expo/hub-client";
import { SidebarActionButton } from "./SidebarActionButton";
import { SidebarRow } from "./SidebarRow";

/** iOS keyboard connection controls. Browser HID forwarding stays independent. */
export function KeyboardSection({
  client,
  disabledReason,
}: {
  client: DeviceClient;
  disabledReason?: string;
}) {
  const connected = client.hardwareKeyboardConnected;

  return (
    <>
      <SidebarRow label="Hardware keyboard">
        <SidebarActionButton
          disabled={connected === null}
          disabledReason={disabledReason}
          onClick={() => client.setHardwareKeyboardConnected(!connected)}
        >
          Toggle
        </SidebarActionButton>
      </SidebarRow>
      <SidebarRow label="Software keyboard">
        <SidebarActionButton
          disabled={connected === null}
          disabledReason={disabledReason}
          onClick={() => client.toggleSoftwareKeyboard()}
        >
          Toggle
        </SidebarActionButton>
      </SidebarRow>
    </>
  );
}
