/**
 * HistoryTimelinePanel 操作记录 — 画布右上角浮层。
 *
 * 顶部是撤销 / 重做按钮，下面按时间倒序列出可回溯的画布操作，并标出当前所在位置。
 * 记录名称由前后快照的差异推断（见 utils/historyOperationLabels），不依赖调用点传参。
 *
 * 与「最近打开的项目」一致：平时只露一条小竖线，鼠标悬浮（或键盘聚焦）才显示面板；
 * 点图钉可锁定常显（写入配置，重启保留）。内置聊天助手展开时整体左移，让出助手宽度。
 * 收起时外层只有竖线那么大（16×48），不会留下吃掉画布拖拽的透明死区；进入触发区后
 * 由 React 显式保持打开状态并扩展命中区，点击面板外部才关闭，避免 WebView 在绝对定位
 * 子元素之间移动时错误触发 pointerleave。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import AnimatedButton from '../shared/AnimatedButton';
import { useT } from '../../i18n';
import {
  describeCanvasChange,
  type HistoryOperationLabel,
  type HistorySnapshotLike,
} from '../../utils/historyOperationLabels';

interface TimelineRow extends HistoryOperationLabel {
  /** 该操作完成后所处的历史下标；撤销到此处即回到这一步之前 */
  index: number;
}

export default function HistoryTimelinePanel() {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const [hoverOpen, setHoverOpen] = useState(false);
  const panelWrapRef = useRef<HTMLDivElement>(null);
  const { history, historyIndex, undo, redo, pinned, chatOpen, chatPanelDetached } = useAppStore(
    useShallow((state) => ({
      history: state.history,
      historyIndex: state.historyIndex,
      undo: state.undo,
      redo: state.redo,
      pinned: !!state.config.canvasHistoryPinned,
      chatOpen: state.chatOpen,
      chatPanelDetached: state.chatPanelDetached,
    })),
  );
  const updateConfig = useAppStore((state) => state.updateConfig);
  const saveConfig = useAppStore((state) => state.saveConfig);
  // 只有内置（未拆出独立窗口）的助手才会占住画布右侧
  const chatDocked = chatOpen && !chatPanelDetached;

  const togglePinned = () => {
    updateConfig({ canvasHistoryPinned: !pinned });
    void saveConfig({ silent: true });
  };
  // 最新一条操作的效果只存在于实时状态里（commitToHistory 记录的是改动前快照），
  // 因此实时状态单独订阅、单独 memo，避免拖拽时重算整条列表。
  const liveNodes = useAppStore((state) => state.nodes);
  const liveEdges = useAppStore((state) => state.edges);
  const liveGroups = useAppStore((state) => state.groups);

  const canUndo = historyIndex >= 0 && history.length > 0;
  const canRedo = historyIndex < history.length - 1;

  const committedRows = useMemo<TimelineRow[]>(() => {
    if (!expanded) return [];
    const rows: TimelineRow[] = [];
    for (let index = 1; index < history.length; index += 1) {
      rows.push({
        ...describeCanvasChange(
          history[index - 1] as HistorySnapshotLike,
          history[index] as HistorySnapshotLike,
        ),
        index: index - 1,
      });
    }
    return rows;
  }, [expanded, history]);

  const latestRow = useMemo<TimelineRow | null>(() => {
    if (!expanded || history.length === 0) return null;
    // 只有停在最新位置时，实时状态才是「最后一次操作的结果」
    if (historyIndex !== history.length - 1) return null;
    const previous = history[history.length - 1] as HistorySnapshotLike;
    const live: HistorySnapshotLike = {
      nodes: liveNodes,
      edges: liveEdges,
      groups: liveGroups,
    };
    const label = describeCanvasChange(previous, live);
    if (label.title === '画布修改') return null;
    return { ...label, index: history.length - 1 };
  }, [expanded, history, historyIndex, liveNodes, liveEdges, liveGroups]);

  // 倒序展示：最近的操作在最上面，紧贴撤销 / 重做按钮
  const orderedRows = useMemo(
    () => [...committedRows, ...(latestRow ? [latestRow] : [])].reverse(),
    [committedRows, latestRow],
  );
  const panelOpen = pinned || hoverOpen;

  useEffect(() => {
    if (!hoverOpen || pinned) return;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (!panelWrapRef.current?.contains(event.target as Node)) {
        setHoverOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
  }, [hoverOpen, pinned]);

  return (
    <div
      ref={panelWrapRef}
      className="canvas-history-wrap relative h-12 w-4 select-none"
      data-pinned={pinned ? 'true' : 'false'}
      data-open={panelOpen ? 'true' : 'false'}
      data-chat-open={chatDocked ? 'true' : 'false'}
      onPointerEnter={() => setHoverOpen(true)}
      onFocusCapture={() => setHoverOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setHoverOpen(false);
        }
      }}
    >
      <span
        aria-hidden="true"
        className="canvas-history-hint absolute right-0 top-0 flex h-12 w-4 items-center justify-end
                   transition-opacity duration-150"
      >
        <span className="h-8 w-0.5 rounded-full bg-canvas-text-muted/35" />
      </span>
      <div
        className="canvas-history-panel glass-bevel glass-bevel--floating
                   absolute right-0 top-0
                   pointer-events-none opacity-0
                   transition-opacity duration-150 ease-out"
      >
      <div className="canvas-history-panel__head">
        <AnimatedButton
          type="button"
          className="canvas-history-btn"
          data-tooltip={t('撤销 (Ctrl+Z)')}
          aria-label={t('撤销')}
          disabled={!canUndo}
          onClick={() => { void undo(); }}
        >
          <Icon icon="mdi:undo" width="15" />
        </AnimatedButton>
        <AnimatedButton
          type="button"
          className="canvas-history-btn"
          data-tooltip={t('还原 (Ctrl+Shift+Z)')}
          aria-label={t('还原')}
          disabled={!canRedo}
          onClick={() => { void redo(); }}
        >
          <Icon icon="mdi:redo" width="15" />
        </AnimatedButton>
        <span className="canvas-history-panel__title">{t('操作记录')}</span>
        <AnimatedButton
          type="button"
          className={`canvas-history-btn${pinned ? ' canvas-history-btn--on' : ' canvas-history-btn--ghost'}`}
          aria-label={pinned ? t('取消锁定常显') : t('锁定常显')}
          aria-pressed={pinned}
          data-tooltip={pinned ? t('取消锁定') : t('锁定常显')}
          onClick={togglePinned}
        >
          <Icon icon={pinned ? 'mdi:pin' : 'mdi:pin-outline'} width="14" />
        </AnimatedButton>
        <AnimatedButton
          type="button"
          className="canvas-history-btn canvas-history-btn--ghost"
          aria-label={expanded ? t('收起操作记录') : t('展开操作记录')}
          data-tooltip={expanded ? t('收起') : t('展开')}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'} width="15" />
        </AnimatedButton>
      </div>

      {expanded && (
        <ul className="canvas-history-list" aria-label={t('画布操作记录')}>
          {orderedRows.length === 0 ? (
            <li className="canvas-history-empty">{t('暂无操作记录')}</li>
          ) : (
            orderedRows.map((row) => {
              const isCurrent = row.index === historyIndex;
              const isUndone = row.index > historyIndex;
              return (
                <li
                  key={`${row.index}-${row.title}`}
                  className={`canvas-history-item${isCurrent ? ' is-current' : ''}${isUndone ? ' is-undone' : ''}`}
                >
                  <Icon icon={row.icon} width="13" className="canvas-history-item__icon" />
                  <span className="canvas-history-item__title">{t(row.title)}</span>
                  {isCurrent && <span className="canvas-history-item__badge">{t('当前')}</span>}
                </li>
              );
            })
          )}
        </ul>
      )}
      </div>
    </div>
  );
}
