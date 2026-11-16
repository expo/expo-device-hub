import { Content, Description, Root, Title, Trigger } from "@radix-ui/react-dialog";
import { useState } from "react";

import { bg, border, heading, layer, radius, shadow, text, textSize, tone } from "../theme/tokens";
import { Button, BUTTON_HEIGHTS } from "./Button";
import { WarningIcon } from "./icons";

/** A separate, non-modal details trigger beside the device's selection button. */
export function UnsupportedDeviceWarning({ name }: { name: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Root open={open} onOpenChange={setOpen} modal={false}>
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
            // Row border + padding + platform mark + gap: align with its reserved slot.
            left: 29,
            width: BUTTON_HEIGHTS["2xs"],
            padding: 0,
            borderWidth: 0,
            color: tone.warning.icon,
          }}
        />
      </Trigger>
      {open && (
        <Content
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            zIndex: layer.popover,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            width: "100%",
            maxWidth: 280,
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
          <Title style={{ ...heading.sm, margin: 0, color: text.default }}>
            Unsupported or untested device
          </Title>
          <Description
            style={{ ...textSize.xs, fontWeight: 400, margin: 0, color: text.secondary }}
          >
            This device type is unsupported or has not been tested with Expo Device Hub. You can
            still try using it, but screen streaming and device controls may not work as expected.
          </Description>
        </Content>
      )}
    </Root>
  );
}
