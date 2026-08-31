/**
 * Select — 统一风格的自定义下拉选择组件
 *
 * 视觉与 ui-kit 的 .ui-menu 保持一致：圆角卡片、暗色底、分组/悬停/选中态。
 * 底层保留隐藏的原生 <select>，用于表单提交和无 JS 回退。
 *
 * 支持普通选项与 optgroup 分组两种数据形式。
 * 尺寸不强制：通过 size prop 提供 sm/md/lg 三档，也可传 className / triggerClassName 完全自定义。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectOptionGroup<T extends string = string> {
  label: ReactNode;
  options: SelectOption<T>[];
}

export type SelectOptions<T extends string = string> = (SelectOption<T> | SelectOptionGroup<T>)[];

interface SelectProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOptions<T>;
  placeholder?: string;
  disabled?: boolean;
  /** 尺寸；不指定时走 md（32px） */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** 单独控制触发器样式，用于覆盖默认高度/字号等 */
  triggerClassName?: string;
  /** 直接设置触发器内联样式，可精确覆盖高度等 */
  triggerStyle?: CSSProperties;
  id?: string;
  title?: string;
  'aria-label'?: string;
  /** 菜单使用 fixed 定位，可突破父级 overflow:hidden 裁剪 */
  fixedMenu?: boolean;
}

function isOptionGroup<T extends string>(
  item: SelectOption<T> | SelectOptionGroup<T>,
): item is SelectOptionGroup<T> {
  return 'options' in item && Array.isArray(item.options);
}

function optionLabelString(label: ReactNode): string {
  if (label === null || label === undefined) return '';
  if (typeof label === 'string' || typeof label === 'number' || typeof label === 'boolean') {
    return String(label);
  }
  return '';
}

export default function Select<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = '请选择',
  disabled = false,
  size = 'md',
  className = '',
  triggerClassName = '',
  triggerStyle,
  id,
  title,
  'aria-label': ariaLabel,
  fixedMenu = false,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.flatMap((item) => (isOptionGroup(item) ? item.options : [item]))
    .find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideTrigger = wrapRef.current?.contains(target) ?? false;
      const insideMenu = menuRef.current?.contains(target) ?? false;
      if (!insideTrigger && !insideMenu) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !fixedMenu || !menu) {
      menu?.removeAttribute('style');
      return;
    }
    const updatePosition = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect || !menu) return;
      menu.style.position = 'fixed';
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.left = `${rect.left}px`;
      menu.style.minWidth = `${rect.width}px`;
      menu.style.maxHeight = `calc(100vh - ${rect.bottom + 12}px)`;
      menu.style.zIndex = '300';
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', updatePosition, true);
      menu.removeAttribute('style');
    };
  }, [open, fixedMenu]);

  const sizeClass = size === 'sm' ? 'ui-select--sm' : size === 'lg' ? 'ui-select--lg' : '';
  const rootClass = `ui-select ui-select--custom ${sizeClass} ${className}`.trim();
  const triggerClass = `ui-select__trigger ${triggerClassName}`.trim();

  const renderOption = (option: SelectOption<T>, key: string | number) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={value === option.value}
      disabled={option.disabled}
      className={`ui-menu__item${value === option.value ? ' is-active' : ''}${option.disabled ? ' is-disabled' : ''}`}
      onClick={() => {
        onChange(option.value);
        setOpen(false);
      }}
    >
      {option.label}
    </button>
  );

  const menu = open ? (
    <div className="ui-menu" role="listbox" ref={menuRef}>
      {options.map((item, index) => {
        if (isOptionGroup(item)) {
          return (
            <div key={`group-${index}`}>
              <span className="ui-menu__label">{item.label}</span>
              {item.options.map((option, optIndex) => renderOption(option, `${index}-${optIndex}`))}
            </div>
          );
        }
        return renderOption(item, index);
      })}
    </div>
  ) : null;

  return (
    <div className={rootClass} ref={wrapRef} title={title}>
      <button
        id={id}
        type="button"
        className={triggerClass}
        style={triggerStyle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ui-select__trigger-text">{selected?.label ?? placeholder}</span>
        <svg
          className="ui-select__chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <select
        className="ui-select__native"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        tabIndex={-1}
        aria-hidden="true"
      >
        {options.map((item, index) => {
          if (isOptionGroup(item)) {
            return (
              <optgroup key={`group-${index}`} label={optionLabelString(item.label)}>
                {item.options.map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>
                    {optionLabelString(o.label)}
                  </option>
                ))}
              </optgroup>
            );
          }
          return (
            <option key={item.value} value={item.value} disabled={item.disabled}>
              {optionLabelString(item.label)}
            </option>
          );
        })}
      </select>
      {fixedMenu ? (menu ? createPortal(menu, document.body) : null) : menu}
    </div>
  );
}
