import { Content, Portal, Provider, Root, Trigger } from "@radix-ui/react-tooltip";
import { type ComponentProps, type ReactElement, type ReactNode } from "react";

import { bg, layer, radius, shadow, text, textSize } from "../theme/tokens";

export type TooltipProps = {
  /** The text of the tooltip. Without it, the child renders alone. */
  content?: ReactNode;
  /** The element that the tooltip describes. It must take a ref and pointer and focus handlers. */
  children: ReactElement;
  side?: ComponentProps<typeof Content>["side"];
  align?: ComponentProps<typeof Content>["align"];
  /** Distance from the child in px. */
  sideOffset?: number;
  /** Time the pointer rests on the child before the tooltip opens, in ms. */
  delayMs?: number;
};

/**
 * A short label that appears next to its child while the pointer is over it
 * or it has keyboard focus. Every tooltip in the Hub uses this component, so
 * they share one look. It is not an accessible name: give the child its own
 * `aria-label` or `aria-description`.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  sideOffset = 8,
  delayMs = 0,
}: TooltipProps) {
  if (content === undefined || content === null || content === "") return children;

  return (
    <Provider delayDuration={delayMs}>
      <Root>
        <Trigger asChild>{children}</Trigger>
        <Portal>
          <Content
            side={side}
            align={align}
            sideOffset={sideOffset}
            collisionPadding={8}
            style={{
              ...textSize.xs,
              zIndex: layer.top,
              maxWidth: "min(260px, calc(100vw - 16px))",
              padding: "4px 8px",
              borderRadius: radius.md,
              backgroundColor: text.default,
              color: bg.default,
              boxShadow: shadow.md,
            }}
          >
            {content}
          </Content>
        </Portal>
      </Root>
    </Provider>
  );
}
