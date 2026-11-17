import { Close, Content, Description, Overlay, Portal, Root, Title } from "@radix-ui/react-dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { type ReactNode, type RefObject } from "react";

import { bg, border, font, heading, layer, shadow, text } from "../theme/tokens";
import { IconButton } from "./IconButton";
import { CloseIcon } from "./icons";

/** Corner radius of the modal in the dashboard design. */
const MODAL_RADIUS = 40;
/** Space between the modal's edge and its content. */
export const MODAL_PADDING = 24;

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  /** The heading of the modal, and its accessible name. */
  title: string;
  /** Width of the modal in px. It shrinks to fit a narrow window. */
  width?: number;
  /**
   * The element that takes the focus when the modal opens, such as the first
   * field of a form. Without it, the focus goes to the close button, the first
   * control in the modal.
   */
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
};

/**
 * A dialog over the dashboard, from the dashboard design: a card with large
 * round corners, its title at the top left, and a round close button at the
 * top right. Radix Dialog gives it the focus trap, the scroll lock, and
 * dismissal with Escape or a click outside. The `.hub-modal` rules in
 * `theme.css` hold its open and close animations.
 */
export function Modal({ open, onClose, title, width = 500, initialFocus, children }: ModalProps) {
  return (
    <Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Portal>
        <Overlay
          className="hub-modal-overlay"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: layer.dialogOverlay,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            boxSizing: "border-box",
            overflowY: "auto",
          }}
        >
          {/* The content is inside the overlay, so that a menu opened from it stacks above both. */}
          <Content
            className="hub-modal"
            onOpenAutoFocus={(event) => {
              const target = initialFocus?.current;
              if (!target) return;
              event.preventDefault();
              target.focus();
            }}
            style={{
              position: "relative",
              zIndex: layer.dialogContent,
              width: `min(${width}px, 100%)`,
              maxHeight: "100%",
              boxSizing: "border-box",
              overflowY: "auto",
              padding: MODAL_PADDING,
              border: `1px solid ${border.default}`,
              borderRadius: MODAL_RADIUS,
              outline: "none",
              backgroundColor: bg.screen,
              boxShadow: shadow.sm,
              color: text.default,
              fontFamily: font.sans,
            }}
          >
            <VisuallyHidden asChild>
              <Description />
            </VisuallyHidden>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                marginBottom: 24,
              }}
            >
              <Title asChild>
                <h2 style={{ ...heading.xl, margin: 0 }}>{title}</h2>
              </Title>
              <Close asChild>
                <IconButton
                  label="Close"
                  size={32}
                  icon={<CloseIcon size={16} strokeWidth={2} />}
                  variant="filled"
                />
              </Close>
            </div>
            {children}
          </Content>
        </Overlay>
      </Portal>
    </Root>
  );
}
