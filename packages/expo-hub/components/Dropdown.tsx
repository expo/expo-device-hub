import {
  Arrow,
  Content,
  type DropdownMenuContentProps,
  Portal,
  Root,
  Trigger,
} from '@radix-ui/react-dropdown-menu';
import { type ReactNode } from 'react';

import { cx } from './cx';

/**
 * Popup menu — a port of the website's `Dropdown` (`ui/components/Dropdown`),
 * using Radix DropdownMenu and Tailwind. Kept 1:1 with the original; the only
 * change is `mergeClasses` → `cx` (no @expo/styleguide dependency here). The
 * styleguide classes it uses (`z-overDialog-605`, `border-secondary`,
 * `bg-default`, `animate-slide*AndFade`) are defined in global.css.
 */
type Props = DropdownMenuContentProps & {
  trigger: ReactNode;
  disabled?: boolean;
};

export function Dropdown({
  children,
  trigger,
  className,
  sideOffset = 8,
  collisionPadding = { left: 16, right: 16 },
  side = 'bottom',
  disabled = false,
  ...rest
}: Props) {
  return (
    <Root>
      <Trigger disabled={disabled} asChild>
        {trigger}
      </Trigger>
      <Portal>
        <Content
          className={cx(
            'z-overDialog-605 flex min-w-55 flex-col gap-1 rounded-xl border border-secondary bg-default p-2 shadow-md',
            'will-change-[opacity,transform]',
            'data-[side=bottom]:animate-slideUpAndFade data-[side=left]:animate-slideRightAndFade data-[side=right]:animate-slideLeftAndFade data-[side=top]:animate-slideDownAndFade',
            className
          )}
          side={side}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          {...rest}>
          <Arrow asChild>
            <div className="relative -top-1 size-2.5 rotate-45 border-r border-b border-secondary bg-default" />
          </Arrow>
          {children}
        </Content>
      </Portal>
    </Root>
  );
}
