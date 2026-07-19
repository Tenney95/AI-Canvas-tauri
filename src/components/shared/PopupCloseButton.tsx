import { Icon } from '@iconify/react';
import type { ButtonHTMLAttributes } from 'react';

interface PopupCloseButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  ariaLabel?: string;
}

export default function PopupCloseButton({
  ariaLabel = '关闭',
  className = '',
  type = 'button',
  ...props
}: PopupCloseButtonProps) {
  return (
    <button
      {...props}
      type={type}
      aria-label={ariaLabel}
      className={`chat-panel-close-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-lg
                  text-canvas-text-muted transition-[color,background-color,box-shadow,transform] duration-150
                  hover:bg-red-500/10 hover:text-red-400 active:scale-95
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50
                  disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transform-none ${className}`}
    >
      <Icon icon="mdi:close" width={18} height={18} aria-hidden="true" />
    </button>
  );
}
