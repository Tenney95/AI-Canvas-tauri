import { Icon } from '@iconify/react';
import { useId, useLayoutEffect, useRef, type KeyboardEventHandler } from 'react';

/** 受控展开搜索：只管理焦点和外观，查询来源与结果由调用方提供。 */
export interface ExpandableSearchProps {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  listId?: string;
  activeDescendant?: string;
  /** 收起时交回编辑器光标；未提供时聚焦搜索按钮。 */
  onCollapse?: () => void;
  disabled?: boolean;
  className?: string;
}

export default function ExpandableSearch({
  expanded,
  onExpandedChange,
  value,
  onChange,
  placeholder = '节点编号、文件名、角色、场景或道具',
  label = '搜索资源',
  onKeyDown,
  listId,
  activeDescendant,
  onCollapse,
  disabled = false,
  className = '',
}: ExpandableSearchProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const composingRef = useRef(false);
  const collapsedOnPointerDownRef = useRef(false);

  useLayoutEffect(() => {
    if (expanded && !disabled) inputRef.current?.focus({ preventScroll: true });
  }, [disabled, expanded]);

  const collapse = () => {
    composingRef.current = false;
    onChange('');
    onExpandedChange(false);
    if (onCollapse) onCollapse();
    else triggerRef.current?.focus({ preventScroll: true });
  };

  const handleKeyDown: KeyboardEventHandler<HTMLInputElement> = (event) => {
    // 搜索键盘不交给画布/弹窗快捷键；IME 仍保留原生默认行为。
    event.stopPropagation();
    if (disabled || composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      collapse();
      return;
    }
    onKeyDown?.(event);
  };

  return (
    <div className={`ui-expandable-search${expanded ? ' is-expanded' : ''} ${className}`}>
      <div className="ui-input-group ui-expandable-search__field" aria-hidden={!expanded} inert={!expanded}>
        <span className="ui-input-affix" aria-hidden="true">
          <Icon icon="lucide:search" width={16} height={16} />
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          className="ui-input"
          aria-label={label}
          role={listId ? 'combobox' : undefined}
          aria-autocomplete={listId ? 'list' : undefined}
          aria-controls={expanded ? listId : undefined}
          aria-expanded={listId ? expanded : undefined}
          aria-activedescendant={expanded ? activeDescendant : undefined}
          tabIndex={expanded ? 0 : -1}
          disabled={disabled || !expanded}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <button
        ref={triggerRef}
        type="button"
        className="ui-icon-btn ui-icon-btn--ghost ui-expandable-search__trigger"
        aria-label={expanded ? '收起搜索' : label}
        title={expanded ? '收起搜索 · Esc' : label}
        aria-controls={inputId}
        aria-expanded={expanded}
        disabled={disabled}
        onPointerDown={(event) => {
          collapsedOnPointerDownRef.current = false;
          if (disabled || event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.stopPropagation();
          // 关闭会改变弹层的位置：在按下时处理，避免按钮移出鼠标下方后丢失 click。
          if (expanded) {
            collapsedOnPointerDownRef.current = true;
            collapse();
          }
        }}
        onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onKeyDown={(event) => {
          collapsedOnPointerDownRef.current = false;
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          // 保留键盘/辅助技术的 click；指针按下已关闭时不再次打开。
          if (event.detail > 0 && collapsedOnPointerDownRef.current) {
            collapsedOnPointerDownRef.current = false;
            return;
          }
          if (disabled) return;
          if (expanded) collapse();
          else onExpandedChange(true);
        }}
      >
        <Icon icon={expanded ? 'lucide:x' : 'lucide:search'} width={18} height={18} aria-hidden="true" />
      </button>
    </div>
  );
}
