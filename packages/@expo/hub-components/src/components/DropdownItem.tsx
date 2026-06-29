import { type DropdownMenuItemProps, Item } from '@radix-ui/react-dropdown-menu';
import { type ComponentType, type ReactNode } from 'react';

import { cx } from './cx';

/**
 * A menu row — a port of the website's `DropdownItem`, kept 1:1 with the
 * original classes and structure. Trimmed of the link / loading variants Hub
 * doesn't use (`href`/`LinkBase`, `ActivityIndicator`, `isLoading`). The only
 * other change: our icon components take `size`/`color` rather than a
 * `className`, so the icon's color class lives on a wrapping span.
 */
type Props = Omit<DropdownMenuItemProps, 'onClick'> & {
  label: ReactNode;
  description?: ReactNode;
  Icon?: ComponentType<{ size?: number; color?: string }>;
  rightSlot?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  preventAutoClose?: boolean;
};

export function DropdownItem({
  label,
  description,
  Icon,
  rightSlot,
  disabled,
  destructive,
  onSelect,
  preventAutoClose,
  ...rest
}: Props) {
  return (
    <Item
      aria-disabled={disabled}
      className={cx(
        'relative z-40 flex cursor-pointer items-center justify-between rounded-lg p-2 transition select-none',
        'hocus:bg-hover',
        'hover:outline-0',
        !disabled && 'active:scale-98',
        disabled && 'cursor-default opacity-60 hocus:bg-default'
      )}
      onSelect={(event) => {
        // note(fiberjw): prevent default behavior of closing the menu without using pointer-events-none on the whole item
        if (disabled) {
          event.preventDefault();
          return;
        }

        if (preventAutoClose) {
          event.preventDefault();
        }
        onSelect?.(event);
      }}
      {...rest}>
      <div className="flex flex-1 flex-col gap-0.5">
        <div className={cx('flex items-center justify-between', disabled && 'pointer-events-none')}>
          <div className="flex items-center gap-2">
            {Icon && (
              <span className={cx('flex', destructive ? 'text-icon-danger' : 'text-icon-default')}>
                <Icon size={16} />
              </span>
            )}
            {typeof label === 'string' ? (
              <p className={cx(destructive ? 'text-danger' : 'text-default', 'text-sm font-medium')}>
                {label}
              </p>
            ) : (
              label
            )}
          </div>
          {typeof rightSlot === 'string' ? (
            <p className="text-xs text-secondary">{rightSlot}</p>
          ) : (
            rightSlot
          )}
        </div>
        {description && typeof description === 'string' ? (
          <p className="text-xs leading-4.5 text-tertiary">{description}</p>
        ) : null}
        {description && typeof description !== 'string' ? description : null}
      </div>
    </Item>
  );
}
