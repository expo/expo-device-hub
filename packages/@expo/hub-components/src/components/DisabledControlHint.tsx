import * as Tooltip from '@radix-ui/react-tooltip';
import { type ReactNode, useState } from 'react';

import { bg, border, radius, shadow, text, textSize } from '../theme/tokens';
import { isFocusVisible } from './focusVisible';

/** Keeps a disabled control's explanation reachable by pointer and keyboard. */
export function DisabledControlHint({
  reason,
  label,
  children,
}: {
  reason?: string;
  label?: string;
  children: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  if (!reason) return children;

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            tabIndex={0}
            role="group"
            aria-label={label}
            aria-description={reason}
            aria-disabled
            onFocus={(event) => setFocused(isFocusVisible(event))}
            onBlur={() => setFocused(false)}
            style={{
              display: 'inline-flex',
              maxWidth: '100%',
              borderRadius: radius.lg,
              outline: 'none',
              boxShadow: focused ? `0 0 0 2px ${border.secondary}` : shadow.none,
              cursor: 'not-allowed',
            }}>
            <span style={{ display: 'inline-flex', maxWidth: '100%', pointerEvents: 'none' }}>
              {children}
            </span>
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            align="end"
            sideOffset={6}
            collisionPadding={8}
            style={{
              ...textSize.xs,
              zIndex: 610,
              maxWidth: 'min(260px, calc(100vw - 16px))',
              padding: '6px 10px',
              borderRadius: radius.md,
              backgroundColor: text.default,
              color: bg.default,
              boxShadow: shadow.md,
            }}>
            {reason}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
