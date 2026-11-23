import { Content, Item, Portal, Root, Trigger } from "@radix-ui/react-dropdown-menu";
import { useRef, useState } from "react";

import {
  ActivityIndicator,
  IconButton,
  PlusIcon,
  bg,
  border,
  icon,
  layer,
  opacity,
  radius,
  shadow,
  text,
  textSize,
  truncate,
} from "../primitives";
import { type Device } from "./data";

/** Height of a row of the menu in the dashboard design. */
const ITEM_HEIGHT = 44;
/** The list shows this many devices before it scrolls. */
const VISIBLE_ITEMS = 8;
/** Width of the menu: the width of the device rows of a sidebar at its default width. */
const MENU_WIDTH = 288;

export type AddDeviceMenuProps = {
  /** The accessible name of the add button, such as "Add simulator". */
  label: string;
  /** The noun of the device kind: "simulator" or "emulator". */
  kind: "simulator" | "emulator";
  /** The shut-down devices that the menu offers, most recently used first. */
  recents: Device[];
  /** Boot a recent device. The menu stays open, with a spinner on its row, until this settles. */
  onBoot: (device: Device) => Promise<void>;
  /** The viewer chose to create a new device. */
  onCreate: () => void;
};

/**
 * The add button of a device list and its menu, from the dashboard design.
 * The menu lists the recent devices, each with its OS version; a click boots
 * one. Its last row opens the form that creates a new device.
 */
export function AddDeviceMenu({ label, kind, recents, onBoot, onCreate }: AddDeviceMenuProps) {
  const [open, setOpen] = useState(false);
  const [bootingId, setBootingId] = useState<string | null>(null);
  const booting = bootingId !== null;
  // The viewer chose to create a device. The form opens when the menu has closed, and takes
  // the focus then. A menu that closes gives the focus back to its button; two focus scopes
  // that are open at the same time would also pull the focus from each other.
  const createRequested = useRef(false);

  async function boot(device: Device) {
    if (booting) return;
    setBootingId(device.id);
    try {
      await onBoot(device);
    } finally {
      setBootingId(null);
      setOpen(false);
    }
  }

  return (
    <Root
      open={open}
      // A boot in flight keeps the menu open, so that its row shows the progress.
      onOpenChange={(next) => setOpen(next || booting)}
    >
      <Trigger asChild>
        <IconButton
          size={24}
          label={label}
          icon={<PlusIcon size={16} strokeWidth={2} />}
          // The plus glyph, not the button's box, lines up with the right edge of the rows.
          style={{ marginRight: -4 }}
        />
      </Trigger>
      <Portal>
        <Content
          align="end"
          // The button's box ends 4px past the rows, and the menu ends with the rows.
          alignOffset={4}
          sideOffset={8}
          collisionPadding={8}
          aria-label={`Recent ${kind}s`}
          onCloseAutoFocus={(event) => {
            if (!createRequested.current) return;
            createRequested.current = false;
            event.preventDefault();
            onCreate();
          }}
          className="hub-menu"
          style={{
            zIndex: layer.popover,
            display: "flex",
            width: `min(${MENU_WIDTH}px, calc(100vw - 16px))`,
            // On a short screen the menu takes the height that is free, and its list scrolls,
            // so the create row stays in reach.
            maxHeight: "var(--radix-dropdown-menu-content-available-height)",
            flexDirection: "column",
            gap: 4,
            boxSizing: "border-box",
            padding: "14px 8px",
            border: `0.5px solid ${border.default}`,
            borderRadius: radius.xl,
            outline: "none",
            backgroundColor: bg.default,
            boxShadow: shadow.md,
            color: text.default,
            fontFamily: "inherit",
          }}
        >
          <div
            className="hub-menu-scroll"
            style={{
              flex: "0 1 auto",
              minHeight: 0,
              maxHeight: ITEM_HEIGHT * VISIBLE_ITEMS,
              overflowY: "auto",
            }}
          >
            {recents.length === 0 ? (
              <p
                style={{
                  ...textSize.sm,
                  display: "flex",
                  height: ITEM_HEIGHT,
                  margin: 0,
                  alignItems: "center",
                  padding: "0 16px",
                  color: text.tertiary,
                }}
              >
                No recent {kind}s.
              </p>
            ) : (
              recents.map((device) => (
                <Item
                  key={device.id}
                  disabled={booting && device.id !== bootingId}
                  aria-busy={device.id === bootingId || undefined}
                  onSelect={(event) => {
                    event.preventDefault();
                    void boot(device);
                  }}
                  className="hub-menu-item"
                  style={{
                    ...textSize.sm,
                    display: "flex",
                    height: ITEM_HEIGHT,
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    boxSizing: "border-box",
                    padding: "0 16px",
                    borderRadius: radius.lg,
                    cursor: booting ? "default" : "pointer",
                    opacity: booting && device.id !== bootingId ? opacity.disabled : 1,
                    userSelect: "none",
                  }}
                >
                  <span title={device.name} style={{ ...truncate, minWidth: 0, fontWeight: 500 }}>
                    {device.name}
                  </span>
                  {device.id === bootingId ? (
                    <ActivityIndicator size={16} label={`Booting ${device.name}`} />
                  ) : (
                    <span style={{ flexShrink: 0, color: text.secondary }}>{device.version}</span>
                  )}
                </Item>
              ))
            )}
          </div>
          <Item
            disabled={booting}
            onSelect={() => {
              createRequested.current = true;
            }}
            className="hub-menu-item"
            style={{
              ...textSize.sm,
              display: "flex",
              height: ITEM_HEIGHT,
              flexShrink: 0,
              alignItems: "center",
              gap: 8,
              boxSizing: "border-box",
              padding: "0 16px",
              borderRadius: radius.lg,
              color: text.secondary,
              fontWeight: 500,
              cursor: booting ? "default" : "pointer",
              opacity: booting ? opacity.disabled : 1,
              userSelect: "none",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "flex",
                width: 24,
                height: 24,
                flexShrink: 0,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: radius.full,
                backgroundColor: bg.selected,
                color: icon.default,
              }}
            >
              <PlusIcon size={16} strokeWidth={2} />
            </span>
            Create new {kind}
          </Item>
        </Content>
      </Portal>
    </Root>
  );
}
