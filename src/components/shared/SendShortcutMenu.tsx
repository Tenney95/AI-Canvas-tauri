import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import type { PromptSubmitShortcut } from '../../types';
import { useT } from '../../i18n';
import { calcAnchoredPosition } from '../../utils/popupPosition';
import { PROMPT_SUBMIT_SHORTCUT_OPTIONS } from '../../utils/promptSubmitShortcut';

interface SendShortcutMenuProps {
  anchor: HTMLElement;
  value: PromptSubmitShortcut;
  onChange: (value: PromptSubmitShortcut) => void;
  onClose: () => void;
  disabled?: boolean;
}

/** UI Kit 受控发送快捷键菜单；配置保存由宿主负责，预览可使用局部状态。 */
export default function SendShortcutMenu({ anchor, value, onChange, onClose, disabled = false }: SendShortcutMenuProps) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const close = useCallback((restoreFocus = false) => {
    onClose();
    if (restoreFocus) {
      const trigger = anchor.matches('button') ? anchor : anchor.querySelector<HTMLButtonElement>('button');
      trigger?.focus({ preventScroll: true });
    }
  }, [anchor, onClose]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = anchor.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const { left, top } = calcAnchoredPosition({ left: rect.right - size.width, top: rect.top, bottom: rect.bottom }, size.width, size.height);
    setPosition({ left, top });
    const selected = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
    (selected ?? menu).focus({ preventScroll: true });
  }, [anchor]);

  useEffect(() => {
    const dismiss = () => close();
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [close]);

  return createPortal(
    <div ref={menuRef} className="ui-menu w-52" style={{ position: 'fixed', ...position, zIndex: 10000 }}
      role="menu" aria-label={t('发送快捷键')} tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => {
        if (event.key === 'Tab') { close(); return; }
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        if (!items.length) return;
        const index = items.findIndex((item) => item === document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      <span className="ui-menu__label">{t('发送快捷键')}</span>
      {PROMPT_SUBMIT_SHORTCUT_OPTIONS.map((option) => (
        <button key={option.value} type="button" role="menuitemradio" disabled={disabled}
          className={`ui-menu__item${value === option.value ? ' is-active' : ''}`} aria-checked={value === option.value}
          onClick={() => { onChange(option.value); close(true); }}>
          <span className="flex-1 font-mono">{option.label}</span>
          {value === option.value && <Icon icon="lucide:check" width={14} aria-hidden="true" />}
        </button>
      ))}
    </div>, document.body,
  );
}
