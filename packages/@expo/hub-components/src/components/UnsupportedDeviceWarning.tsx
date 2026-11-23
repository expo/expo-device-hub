import { Content, Portal, Root, Trigger } from "@radix-ui/react-popover";
import { useId } from "react";

import { bg, border, heading, layer, radius, shadow, text, textSize, tone } from "../theme/tokens";
import { Button, BUTTON_HEIGHTS } from "./Button";
import { WarningIcon } from "./icons";

// Row border + padding + platform mark + gap: align with its reserved slot.
const TRIGGER_LEFT = 29;

/** A separate, non-modal details trigger beside the device's selection button. */
export function UnsupportedDeviceWarning({ name }: { name: string }) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Root modal={false}>
      <Trigger asChild>
        <Button
          theme="tertiary"
          size="2xs"
          aria-label={`Unsupported or untested device: ${name}. Show details`}
          leftSlot={<WarningIcon size={16} />}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            marginBlock: "auto",
            left: TRIGGER_LEFT,
            width: BUTTON_HEIGHTS["2xs"],
            padding: 0,
            borderWidth: 0,
            color: tone.warning.icon,
          }}
        />
      </Trigger>
      <Portal>
        <Content
          align="start"
          sideOffset={12}
          alignOffset={-TRIGGER_LEFT}
          collisionPadding={16}
          hideWhenDetached
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          style={{
            zIndex: layer.popover,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            width: 280,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "var(--radix-popover-content-available-height)",
            overflowY: "auto",
            boxSizing: "border-box",
            padding: "12px 16px",
            border: `1px solid ${border.default}`,
            borderRadius: radius.lg,
            boxShadow: shadow.md,
            backgroundColor: bg.default,
            textAlign: "left",
            whiteSpace: "normal",
            outline: "none",
          }}
        >
          <h2 id={titleId} style={{ ...heading.sm, margin: 0, color: text.default }}>
            Unsupported or untested device
          </h2>
          <p
            id={descriptionId}
            style={{ ...textSize.xs, fontWeight: 400, margin: 0, color: text.secondary }}
          >
            This device type is unsupported or has not been tested with Expo Device Hub. You can
            still try using it, but screen streaming and device controls may not work as expected.
          </p>
        </Content>
      </Portal>
    </Root>
  );
}
