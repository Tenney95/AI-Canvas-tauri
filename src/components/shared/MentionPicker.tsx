/**
 * MentionPicker — @ 选中器的公用外观：分段 Tab + 筛选芯片 + 图片卡片网格。
 *
 * 纯展示组件：数据来源、过滤和「选中后往编辑器里插什么」都留在调用方
 * （MentionEditor 用于节点提示词，ChatInput 用于聊天）。
 * 卡片走 onMouseDown + preventDefault，避免抢走 contenteditable 的光标。
 */
import { Icon } from '@iconify/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { CharacterCropRect } from '../../types/dramaAssets';
import { AVATAR_ASPECT, cropImageStyle } from '../character/characterReferencePresentation';
import ViewportImage from './ViewportImage';

export interface MentionPickerTab {
  id: string;
  label: string;
  icon?: string;
}

export interface MentionPickerChip {
  id: string;
  label: string;
  count?: number;
}

export interface MentionPickerItem {
  key: string;
  label: string;
  thumbnailUrl?: string;
  /** 复用角色头像的归一化裁剪参数。 */
  thumbnailCrop?: CharacterCropRect;
  /** 无缩略图时的占位图标（iconify 名） */
  icon?: string;
  /** 缩略图右上角小标，如 #3 / 自身 / 视频 */
  badge?: string;
  disabled?: boolean;
  audioPreviewUrl?: string;
  title?: string;
  /** 供 aria-activedescendant 引用；不需要键盘导航时可省略 */
  domId?: string;
  onSelect: () => void;
}

interface MentionPickerProps {
  tabs: MentionPickerTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  chips?: MentionPickerChip[];
  activeChip?: string;
  onChipChange?: (id: string) => void;
  items: MentionPickerItem[];
  /** 键盘高亮项的 key */
  activeKey?: string;
  /** 鼠标移入某项时同步高亮 */
  onItemHover?: (key: string) => void;
  emptyText?: string;
  /** 芯片行左侧插槽（返回按钮等）；无芯片时单独成行 */
  leading?: ReactNode;
  footer?: ReactNode;
  listId?: string;
  ariaLabel?: string;
  className?: string;
  mediaAspectRatio?: number;
}

export default function MentionPicker({
  tabs,
  activeTab,
  onTabChange,
  chips,
  activeChip,
  onChipChange,
  items,
  activeKey,
  onItemHover,
  emptyText = '没有可引用的内容',
  leading,
  footer,
  listId,
  ariaLabel,
  className = '',
  mediaAspectRatio,
}: MentionPickerProps) {
  const hasChipRow = !!leading || (chips?.length ?? 0) > 0;
  const gridRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const previewSources = JSON.stringify(items.map((item) => [item.key, item.audioPreviewUrl]));

  useLayoutEffect(() => {
    // 分类、搜索和下钻内容变化时从顶部显示，悬浮高亮不重置滚动。
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }, [activeTab, activeChip, previewSources]);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    const activeItem = activeItemRef.current;
    if (!grid || !activeItem) return;
    const viewport = grid.getBoundingClientRect();
    const item = activeItem.getBoundingClientRect();
    const scaleY = grid.offsetHeight > 0 ? viewport.height / grid.offsetHeight : 1;
    if (scaleY <= 0) return;
    // 只滚动卡片列表；不让 scrollIntoView 带动画布或宿主弹窗一起滚动。
    if (item.top < viewport.top) grid.scrollTop += (item.top - viewport.top) / scaleY;
    else if (item.bottom > viewport.bottom) grid.scrollTop += (item.bottom - viewport.bottom) / scaleY;
  }, [activeKey, activeTab, activeChip, previewSources]);

  useEffect(() => {
    return () => {
      playerRef.current?.pause();
      playerRef.current = null;
      setPlayingKey(null);
      setPreviewError(false);
    };
  }, [previewSources, activeTab]);

  const togglePreview = (item: MentionPickerItem) => {
    const previous = playerRef.current;
    if (previous) {
      previous.pause();
      playerRef.current = null;
    }
    setPlayingKey(null);
    setPreviewError(false);
    if ((previous && playingKey === item.key) || !item.audioPreviewUrl) return;
    const player = new Audio(item.audioPreviewUrl);
    playerRef.current = player;
    player.onended = () => {
      if (playerRef.current === player) {
        playerRef.current = null;
        setPlayingKey(null);
      }
    };
    const fail = () => {
      if (playerRef.current === player) {
        playerRef.current = null;
        setPlayingKey(null);
        setPreviewError(true);
      }
    };
    player.onerror = fail;
    setPlayingKey(item.key);
    void player.play().catch(fail);
  };

  return (
    <div className={`mention-picker nowheel nodrag nopan ${className}`}>
      {tabs.length > 1 && (
        <div className="mention-picker-tabs" role="tablist" aria-label={ariaLabel}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === activeTab}
              className={`mention-picker-tab${tab.id === activeTab ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); onTabChange(tab.id); }}
            >
              {tab.icon && <Icon icon={tab.icon} width="14" height="14" />}
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {hasChipRow && (
        <div className="mention-picker-chips">
          {leading}
          {chips?.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={`mention-picker-chip${chip.id === activeChip ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); onChipChange?.(chip.id); }}
            >
              {chip.label}
              {chip.count != null && <span className="mention-picker-chip-count">{chip.count}</span>}
            </button>
          ))}
        </div>
      )}

      <div ref={gridRef} className="mention-picker-grid" id={listId} role="listbox" aria-label={ariaLabel}>
        {items.length === 0 ? (
          <div className="mention-picker-empty">{emptyText}</div>
        ) : (
          items.map((item) => (
            <div key={item.key} className="relative min-w-0" role="presentation">
            <button
              ref={item.key === activeKey ? activeItemRef : undefined}
              key={item.key}
              id={item.domId}
              type="button"
              role="option"
              aria-selected={item.key === activeKey}
              disabled={item.disabled}
              title={item.title ?? item.label}
              className={`mention-picker-card w-full${item.key === activeKey ? ' active' : ''}`}
              onMouseEnter={() => onItemHover?.(item.key)}
              onMouseDown={(e) => {
                e.preventDefault();
                if (!item.disabled) item.onSelect();
              }}
            >
              <span className="mention-picker-card-media" style={mediaAspectRatio !== undefined || item.thumbnailCrop ? { aspectRatio: mediaAspectRatio ?? AVATAR_ASPECT } : undefined}>
                {/* 图标垫在底层：缩略图加载失败时自己隐藏，露出图标而不是空白卡 */}
                <Icon icon={item.icon || 'mdi:vector-square'} width="26" height="26" />
                {item.thumbnailUrl && (
                  <ViewportImage
                    key={item.thumbnailUrl}
                    src={item.thumbnailUrl}
                    rootMargin="160px 0px"
                    className={item.thumbnailCrop ? 'is-cropped' : undefined}
                    style={cropImageStyle(item.thumbnailCrop)}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    onLoad={(e) => { e.currentTarget.style.display = ''; }}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
                {item.badge && <span className="mention-picker-card-badge">{item.badge}</span>}
              </span>
              <span className="mention-picker-card-name">{item.label}</span>
            </button>
            {item.audioPreviewUrl && (
              <button
                type="button"
                className="ui-icon-btn absolute bottom-6 right-1 bg-canvas-surface text-canvas-text"
                aria-label={`${playingKey === item.key ? '暂停试听' : '试听'}：${item.label}`}
                title={playingKey === item.key ? '暂停试听' : '试听'}
                disabled={item.disabled}
                onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                onClick={(event) => { event.stopPropagation(); togglePreview(item); }}
              >
                <Icon icon={playingKey === item.key ? 'lucide:pause' : 'lucide:play'} width="14" height="14" />
              </button>
            )}
            </div>
          ))
        )}
      </div>

      {previewError && <p role="status" className="text-xs text-canvas-text-muted">声音试听失败，请重试</p>}
      {footer && <div className="mention-picker-footer">{footer}</div>}
    </div>
  );
}
