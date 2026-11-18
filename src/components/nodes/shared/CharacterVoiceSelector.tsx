/**
 * CharacterVoiceSelector — 提供角色参考音色选择界面与交互。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import { calcAnchoredPosition } from '../../../utils/popupPosition';
import { useT } from '../../../i18n';
import { useCharacterVoicePreview } from '../../../hooks/useCharacterVoicePreview';

export interface CharacterVoiceChoice {
  id: string;
  scope: 'project' | 'global';
  label: string;
  value: string;
  url: string;
}

interface CharacterVoiceSelectorProps {
  choices: CharacterVoiceChoice[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onPlaybackError: () => void;
}

/** 主声音选择与试听分开操作；播放器仅属于当前展开的列表。 */
export default function CharacterVoiceSelector({ choices, value, disabled, onChange, onPlaybackError }: CharacterVoiceSelectorProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const active = choices.find((choice) => choice.value === value);
  const expanded = open && !disabled;
  const { playingId, toggle: preview, stop: stopPreview } = useCharacterVoicePreview(
    JSON.stringify([expanded, choices.map(({ id, url }) => [id, url])]),
    { showPending: true, onError: onPlaybackError },
  );

  const close = useCallback(() => {
    stopPreview();
    setOpen(false);
  }, [stopPreview]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [expanded, close]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    const position = () => {
      const next = calcAnchoredPosition(trigger.getBoundingClientRect(), menu.offsetWidth, menu.offsetHeight, 6);
      menu.style.left = `${next.left}px`;
      menu.style.top = `${next.top}px`;
    };
    position();
    menu.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    observer.observe(trigger);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [expanded]);

  const select = (next: string) => {
    onChange(next);
    close();
    triggerRef.current?.focus();
  };

  return (
    <div className="ui-select ui-select--custom ui-select--sm min-w-0 max-w-40 shrink">
      <button ref={triggerRef} type="button" className="ui-select__trigger" disabled={disabled}
        aria-label={t('角色主声音')} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? menuId : undefined}
        title={active?.label ?? t('选择角色主声音')}
        onClick={(event) => { event.stopPropagation(); if (open) close(); else setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
          if (event.key === 'Escape') close();
        }}>
        <span className="truncate">{active?.label ?? t(value ? '当前参考音频' : '选择角色主声音')}</span>
        <Icon className="ui-select__chevron" icon="lucide:chevron-down" width={13} />
      </button>
      {expanded && createPortal(
        <div ref={menuRef} id={menuId} role="dialog" aria-label={t('角色主声音列表')}
          className="ui-menu w-72 max-w-[calc(100vw-16px)] max-h-[min(360px,calc(100vh-16px))]"
          style={{ position: 'fixed', zIndex: 300 }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.stopPropagation(); close(); triggerRef.current?.focus(); }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
          }}>
          <div className="flex items-center justify-between px-2 py-2 text-xs text-canvas-text-secondary">
            <span>{t('角色主声音')}</span><span className="text-[10px] text-canvas-text-muted">{t('点击右侧试听')}</span>
          </div>
          <button type="button" className={`ui-menu__item ${!value ? 'is-active' : ''}`} aria-pressed={!value} onClick={() => select('')}>
            <Icon icon="lucide:unlink" width={14} />{t('使用 @ 或连线参考')}
          </button>
          {(['project', 'global'] as const).map((scope) => {
            const group = choices.filter((choice) => choice.scope === scope);
            return group.length ? <section key={scope} aria-label={t(scope === 'project' ? '本项目' : '全局角色')}>
              <div className="ui-menu__label">{t(scope === 'project' ? '本项目' : '全局角色')}</div>
              {group.map((choice) => (
                <div key={choice.id} className="flex items-center gap-1 rounded-md hover:bg-canvas-hover">
                  <button type="button" className={`ui-menu__item min-w-0 flex-1 ${value === choice.value ? 'is-active' : ''}`}
                    aria-pressed={value === choice.value} title={choice.label} onClick={() => select(choice.value)}>
                    <Icon icon={value === choice.value ? 'lucide:check' : 'lucide:audio-lines'} width={14} className="shrink-0" />
                    <span className="truncate">{choice.label}</span>
                  </button>
                  <button type="button" className={`ui-btn ui-btn--ghost ui-btn--sm mr-1 shrink-0 ${playingId === choice.id ? 'is-active' : ''}`}
                    aria-label={t(playingId === choice.id ? '停止试听 {label}' : '试听 {label}', { label: choice.label })}
                    title={t(playingId === choice.id ? '停止试听' : '试听')}
                    onClick={() => void preview(choice.id, choice.url)}>
                    <Icon icon={playingId === choice.id ? 'lucide:square' : 'lucide:play'} width={14} />
                  </button>
                </div>
              ))}
            </section> : null;
          })}
          {!choices.length ? <p className="px-2 py-4 text-xs text-canvas-text-muted">{t('暂无可用主声音，请先在角色库设置。')}</p> : null}
        </div>, document.body,
      )}
    </div>
  );
}
