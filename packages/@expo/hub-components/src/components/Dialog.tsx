import {
  Close,
  Content,
  Description,
  type DialogProps,
  Overlay,
  Portal,
  Root,
  Title,
} from '@radix-ui/react-dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { type ComponentPropsWithoutRef, type PropsWithChildren } from 'react';

import { heading } from '../theme/tokens';
import { cx } from './cx';
import { CloseIcon } from './icons';

/**
 * Dialog — a port of the universe website's `Dialog` (`ui/components/Dialog/*`),
 * using Radix `@radix-ui/react-dialog` + Tailwind classes, exactly like the
 * ported `Dropdown`. Radix gives us the overlay, focus trap, scroll lock,
 * Escape/click-outside dismissal and the `data-state` driven animations for
 * free. The styleguide classes it relies on (`bg-default`, `border-default`,
 * `z-dialogOverlay-600`, `animate-fadeIn`, …) are defined in global.css; the
 * only swap from the original is `mergeClasses` → `cx` (no @expo/styleguide here).
 */

/** Controls open/close state — wrap your `DialogContent` in this. */
export function DialogRoot({ children, open, onOpenChange }: DialogProps) {
  return (
    <Root open={open} onOpenChange={onOpenChange}>
      {children}
    </Root>
  );
}

type DialogContentProps = ComponentPropsWithoutRef<typeof Content> & {
  className?: string;
  containerClassName?: string;
  overlayClassName?: string;
};

export function DialogContent({
  children,
  className,
  containerClassName,
  overlayClassName,
  ...restProps
}: DialogContentProps) {
  return (
    <Portal>
      <Overlay className="dialog-overlay group absolute z-dialogOverlay-600">
        <div
          className={cx(
            'fixed inset-0 bg-[#000000]/50',
            'group-data-[state=open]:animate-fadeIn group-data-[state=closed]:animate-fadeOut',
            overlayClassName
          )}
        />
        {/* Nesting the content inside the overlay fixes nested-portal/select issues
            (see the website's DialogContent for the upstream Radix reference). */}
        <div className="fixed top-0 left-0 z-dialogContent-601 flex h-dvh w-dvw items-center justify-center">
          <Content
            className={cx(
              'overflow-hidden rounded-lg shadow-md outline-0',
              'data-[state=open]:animate-largeSlideUpAndFadeIn data-[state=closed]:animate-fadeOut',
              containerClassName
            )}
            {...restProps}>
            <VisuallyHidden asChild>
              <Description />
            </VisuallyHidden>
            <div
              className={cx(
                'w-[90vw] max-w-125 overflow-hidden rounded-lg border border-default bg-default text-default outline-0',
                className
              )}>
              {children}
            </div>
          </Content>
        </div>
      </Overlay>
    </Portal>
  );
}

/** Header row: title (wired to the dialog for screen readers) + close button. */
export function DialogTitle({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between gap-2.5 border-b border-b-default px-6 py-4">
      <Title asChild>
        <h2 style={{ ...heading.base, margin: 0 }}>{title}</h2>
      </Title>
      <DialogClose>
        <button type="button" aria-label="Close" className="dialog-close-button">
          <CloseIcon size={20} />
        </button>
      </DialogClose>
    </div>
  );
}

/** Scrollable content area (the website's `DialogContentContainer`). */
export function DialogContentContainer({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <div
      className={cx(
        'flex max-h-[calc(90vh-69px-53px)] flex-col gap-1.5 overflow-y-auto p-6 pt-4 outline-0',
        className
      )}>
      {children}
    </div>
  );
}

/** Right-aligned action bar pinned to the bottom of the dialog. */
export function DialogFooter({ children }: PropsWithChildren) {
  return (
    <div className="flex items-center justify-end gap-3 border-t border-t-default bg-subtle px-3 py-4 max-md:py-2">
      {children}
    </div>
  );
}

/** Closes the dialog when its child is activated (Radix injects the handler). */
export function DialogClose({ children }: PropsWithChildren) {
  return <Close asChild>{children}</Close>;
}
