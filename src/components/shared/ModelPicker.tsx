import { useId, useLayoutEffect, useEffect, useRef, useState, useCallback, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { calcAnchoredPosition } from '../../utils/popupPosition';

export interface ModelPickerItem {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  title?: string;
  icon?: ReactNode;
}

export interface ModelPickerGroup {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  badgeText?: string;
  tone?: 'brand' | 'success' | 'info' | 'danger' | 'warning';
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
  items: ModelPickerItem[];
}

export interface ModelMenuProps {
  groups: ModelPickerGroup[];
  value?: string;
  onChange: (value: string) => void;
  expandedGroupIds: readonly string[];
  onGroupToggle: (id: string) => void;
  emptyText?: string;
  onClose?: () => void;
}

function Chevron({ collapsed = false }: { collapsed?: boolean }) {
  return <svg className={`ui-model-menu__chevron model-group-chevron${collapsed ? ' collapsed' : ''}`}
    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>;
}

function ModelBadge({ group }: { group: ModelPickerGroup }) {
  return group.icon ?? <span className={`ui-model-menu__badge ui-model-menu__badge--${group.tone ?? 'brand'}`} aria-hidden="true">
    {group.badgeText || Array.from(group.label).slice(0, 2).join('')}
  </span>;
}

function focusModelMenuControl(menu: HTMLElement | null, control?: HTMLButtonElement) {
  if (!control) return;
  control.focus({ preventScroll: true });
  const surface = menu?.closest<HTMLElement>('.ui-model-menu__surface, .model-dropdown');
  if (!surface) return;
  const viewport = surface.getBoundingClientRect();
  const rect = control.getBoundingClientRect();
  const scale = surface.offsetHeight > 0 ? viewport.height / surface.offsetHeight : 1;
  if (scale <= 0) return;
  if (rect.top < viewport.top) surface.scrollTop += (rect.top - viewport.top) / scale;
  else if (rect.bottom > viewport.bottom) surface.scrollTop += (rect.bottom - viewport.bottom) / scale;
}

/** 公共菜单不读取配置、凭据或默认偏好；折叠与选择均由调用方控制。 */
export function ModelMenu({ groups, value, onChange, expandedGroupIds, onGroupToggle,
  emptyText = '暂无可用模型', onClose }: ModelMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const focusGroupRef = useRef<string | null>(null);
  const initialFocusRef = useRef(false);
  const menuId = useId();
  const visibleGroups = groups.filter((group) => group.items.length > 0);

  const focusControl = useCallback((control?: HTMLButtonElement) => {
    focusModelMenuControl(menuRef.current, control);
  }, []);

  useLayoutEffect(() => {
    if (initialFocusRef.current) return;
    const root = menuRef.current;
    const scope = root?.closest<HTMLElement>('.ui-model-menu__surface') ?? root;
    const controls = Array.from(scope?.querySelectorAll<HTMLButtonElement>('[data-model-menu-control]:not(:disabled)') ?? []);
    const selectedGroup = visibleGroups.find((group) => group.items.some((item) => item.value === value));
    const target = controls.find((control) => control.getAttribute('aria-checked') === 'true')
      ?? (selectedGroup ? controls.find((control) => control.dataset.modelMenuGroup === selectedGroup.id) : undefined)
      ?? controls[0];
    if (!target) { root?.focus({ preventScroll: true }); return; }
    initialFocusRef.current = true;
    focusControl(target);
  });

  useLayoutEffect(() => {
    const groupId = focusGroupRef.current;
    if (!groupId || !expandedGroupIds.includes(groupId)) return;
    focusGroupRef.current = null;
    const controls = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-menu-control]:not(:disabled)') ?? []);
    focusControl(controls.find((control) => control.dataset.modelMenuOwner === groupId && !control.dataset.modelMenuGroup));
  }, [expandedGroupIds, focusControl]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
      return;
    }
    const menu = menuRef.current;
    const scope = menu?.closest<HTMLElement>('.ui-model-menu__surface') ?? menu;
    const controls = Array.from(scope?.querySelectorAll<HTMLButtonElement>('[data-model-menu-control]:not(:disabled)') ?? []);
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-model-menu-control]');
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!controls.length) return;
      const index = target ? controls.indexOf(target) : -1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
        : index < 0 ? (event.key === 'ArrowUp' ? controls.length - 1 : 0)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
      focusControl(controls[next]);
      return;
    }
    if (!target || !menu?.contains(target) || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
    event.preventDefault();
    const groupId = target.dataset.modelMenuGroup || target.dataset.modelMenuOwner;
    const group = visibleGroups.find((candidate) => candidate.id === groupId);
    if (!group || group.disabled) return;
    const expanded = expandedGroupIds.includes(group.id);
    if (event.key === 'ArrowRight' && target.dataset.modelMenuGroup) {
      if (expanded) focusControl(controls.find((control) => control.dataset.modelMenuOwner === group.id && !control.dataset.modelMenuGroup));
      else { focusGroupRef.current = group.id; onGroupToggle(group.id); }
    } else if (event.key === 'ArrowLeft') {
      focusGroupRef.current = null;
      focusControl(controls.find((control) => control.dataset.modelMenuGroup === group.id));
      if (expanded) onGroupToggle(group.id);
    }
  };

  return <div ref={menuRef} className="ui-model-menu" role="menu" aria-label="模型与工作流" tabIndex={-1}
    data-ui-select-portal="" onKeyDown={handleKeyDown}>
    {visibleGroups.length === 0 ? <p className="ui-model-menu__empty" role="status">{emptyText}</p>
      : visibleGroups.map((group, groupIndex) => {
        const expanded = !group.disabled && expandedGroupIds.includes(group.id);
        const headerId = `${menuId}-group-${groupIndex}`;
        const itemsId = `${headerId}-items`;
        return <section key={group.id} className={`ui-model-menu__group model-group${group.items.some((item) => item.value === value) ? ' has-active' : ''} ${group.className ?? ''}`}>
          <button type="button" id={headerId} className={`ui-model-menu__header model-group-header${group.disabled ? ' disabled' : ''}`}
            role="menuitem" tabIndex={-1} disabled={group.disabled} aria-expanded={expanded} aria-controls={expanded ? itemsId : undefined}
            title={group.disabledReason || group.label} data-model-menu-control="" data-model-menu-group={group.id}
            onClick={(event) => { event.stopPropagation(); if (!group.disabled) onGroupToggle(group.id); }}>
            <ModelBadge group={group} />
            <span className="ui-model-menu__group-info model-group-info">
              <span className="ui-model-menu__group-name model-group-name">{group.label}</span>
              {group.description && <span className="ui-model-menu__group-description model-group-desc">{group.description}</span>}
            </span>
            {group.disabled ? <svg className="model-lock-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg> : <Chevron collapsed={!expanded} />}
          </button>
          {expanded && <div id={itemsId} role="group" aria-labelledby={headerId} className="ui-model-menu__items model-group-items model-group-items-models">
            {group.items.map((item) => <button key={item.value} type="button"
              className={`ui-model-menu__item model-item model-item-model${item.value === value ? ' active' : ''}${item.disabled ? ' disabled' : ''}`}
              role="menuitemradio" aria-checked={item.value === value} tabIndex={-1} disabled={item.disabled}
              title={item.title || item.description || item.label} data-model-menu-control="" data-model-menu-owner={group.id}
              onClick={(event) => { event.stopPropagation(); if (!item.disabled && !group.disabled) onChange(item.value); }}>
              {item.icon}
              <span className="ui-model-menu__item-info model-item-info">
                <span className="ui-model-menu__item-name model-item-name" title={item.label}>{item.label}</span>
                {item.description && <span className="ui-model-menu__item-description model-item-desc" title={item.description}>{item.description}</span>}
              </span>
              <span className="ui-model-menu__status model-item-status" aria-hidden="true">
                {item.value === value && <svg className="model-item-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>}
              </span>
            </button>)}
          </div>}
        </section>;
      })}
  </div>;
}

export interface ModelPickerProps {
  groups: ModelPickerGroup[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  name?: string;
  'aria-label'?: string;
  className?: string;
  defaultExpandedGroupIds?: string[];
  clearLabel?: string;
}

/** 表单入口与视口内 Portal；模型目录、连接状态和选择副作用始终留在宿主。 */
export default function ModelPicker({ groups, value, onChange, placeholder = '选择模型', emptyText,
  disabled = false, name, 'aria-label': ariaLabel, className = '', defaultExpandedGroupIds = [], clearLabel }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  if (disabled && open) setOpen(false);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set(defaultExpandedGroupIds));
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const expanded = open && !disabled;
  const currentGroup = groups.find((group) => group.items.some((item) => item.value === value));
  const current = currentGroup?.items.find((item) => item.value === value);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!expanded) return;
    const pointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!wrapRef.current?.contains(target) && !portalRef.current?.contains(target)) setOpen(false);
    };
    const keyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as Node;
      if (event.key !== 'Escape' && !wrapRef.current?.contains(target) && !portalRef.current?.contains(target)) return;
      if (event.isComposing || event.keyCode === 229) { event.stopImmediatePropagation(); return; }
      if (event.key === 'Escape' || event.key === 'Tab') {
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); }
      }
    };
    document.addEventListener('mousedown', pointerDown, true);
    window.addEventListener('keydown', keyDown, true);
    return () => {
      document.removeEventListener('mousedown', pointerDown, true);
      window.removeEventListener('keydown', keyDown, true);
    };
  }, [expanded]);

  useLayoutEffect(() => {
    const portal = portalRef.current;
    const trigger = triggerRef.current;
    if (!expanded || !portal || !trigger) return;
    const update = () => {
      const rect = trigger.getBoundingClientRect();
      const availableHeight = Math.max(rect.top - 12, window.innerHeight - rect.bottom - 12, 0);
      portal.style.width = `${Math.min(380, Math.max(0, window.innerWidth - 16))}px`;
      portal.style.maxHeight = `${Math.min(360, availableHeight)}px`;
      let layer = 300;
      for (let parent: HTMLElement | null = wrapRef.current; parent; parent = parent.parentElement) {
        const value = Number.parseInt(window.getComputedStyle(parent).zIndex, 10);
        if (Number.isFinite(value)) layer = Math.max(layer, value + 1);
      }
      portal.style.zIndex = String(layer);
      const position = calcAnchoredPosition(rect, portal.offsetWidth, portal.offsetHeight, 4, 8);
      portal.style.left = `${position.left}px`;
      portal.style.top = `${position.top}px`;
      portal.dataset.placement = position.placement;
    };
    update();
    const target = portal.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)')
      ?? portal.querySelector<HTMLButtonElement>('[data-model-menu-control]:not(:disabled)');
    focusModelMenuControl(portal, target ?? undefined);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(portal);
    observer?.observe(trigger);
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [expanded]);

  return <div ref={wrapRef} className={`ui-select ui-select--custom ui-model-picker nodrag nopan ${className}`}>
    {name && <input type="hidden" name={name} value={value ?? ''} disabled={disabled} />}
    <button ref={triggerRef} type="button" className="ui-select__control ui-select__trigger ui-model-picker__trigger"
      disabled={disabled} title={current?.label || placeholder} aria-label={ariaLabel || placeholder}
      aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded ? menuId : undefined}
      onClick={(event) => { event.stopPropagation(); setOpen((state) => !state); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !expanded) return;
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
      }}>
      {currentGroup && <ModelBadge group={currentGroup} />}
      <span className={`ui-model-picker__label${current ? '' : ' is-placeholder'}`}>{current?.label || placeholder}</span>
      <Chevron collapsed={!expanded} />
    </button>
    {expanded && createPortal(<div id={menuId} ref={portalRef} className="ui-model-menu__surface nowheel nodrag nopan" data-ui-select-portal="">
      {clearLabel && <button type="button" className="ui-model-picker__clear ui-menu__item" tabIndex={-1} data-model-menu-control=""
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const controls = Array.from(portalRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-menu-control]:not(:disabled)') ?? []);
            const next = event.key === 'Home' ? controls[0] : event.key === 'ArrowDown' ? controls[1] : controls[controls.length - 1];
            focusModelMenuControl(portalRef.current, next);
          }
        }} onClick={(event) => { event.stopPropagation(); close(true); onChange(''); }}>{clearLabel}</button>}
      <ModelMenu groups={groups} value={value} expandedGroupIds={[...expandedGroupIds]} emptyText={emptyText}
        onChange={(next) => { close(true); onChange(next); }} onClose={() => close(true)}
        onGroupToggle={(id) => setExpandedGroupIds((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        })} />
    </div>, document.body)}
  </div>;
}
