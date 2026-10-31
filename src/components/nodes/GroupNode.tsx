/**
 * GroupNode — 分组节点组件
 *
 * 使用 React Flow 原生 parentId 机制，作为子节点的父节点。
 * 拖拽分组时 React Flow 自动同步所有子节点位置，无卡顿。
 * 支持拖拽右下角调整大小。
 */
import { memo, useRef, useState, useCallback, useEffect } from 'react';
import { NodeResizer, Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Icon } from '@iconify/react';
import { useAppStore, type AppState } from '../../store/useAppStore';
import { GROUP_COLOR_PALETTE } from '../../types';
import { useNodeLocked } from '../../hooks/useNodeLocked';
import AnimatedButton from '../shared/AnimatedButton';
import { batchExecuteNodes, type BatchContext } from '../../utils/batchExecute';
import { getGroupChildImageKey, type GroupCoverItem } from '../../utils/groupChildImageKey';
import { useT } from '../../i18n';
import ViewportImage from '../shared/ViewportImage';

interface GroupNodeData {
  groupId: string;
  color: string;
  label: string;
  groupCollapsed?: boolean;
}

const childCountCache = new WeakMap<AppState['nodes'], Map<string, number>>();

function getGroupChildCount(nodes: AppState['nodes'], groupId: string) {
  let counts = childCountCache.get(nodes);
  if (!counts) {
    counts = new Map<string, number>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1);
    }
    childCountCache.set(nodes, counts);
  }
  return counts.get(groupId) ?? 0;
}

/** 从封面索引抽 2-3 项；视频只提供图标，不把其媒体地址交给 img。 */
function pickCovers(childImageKey: string): GroupCoverItem[] {
  const pool: GroupCoverItem[] = childImageKey ? JSON.parse(childImageKey) : [];
  const picked: GroupCoverItem[] = [];
  const count = Math.min(pool.length, 3);
  for (let i = 0; i < count; i++) {
    picked.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  }
  return picked;
}

function GroupCoverPhoto({ cover, fan }: { cover: GroupCoverItem; fan: number }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const imageUrl = cover.kind === 'image' ? cover.url : undefined;
  const showImage = imageUrl && imageUrl !== failedUrl;
  return (
    <div
      className={`canvas-group-folder-photo overflow-hidden bg-canvas-card${showImage ? '' : ' canvas-group-folder-photo--placeholder flex items-start justify-center text-canvas-text-muted'}`}
      style={{ '--fan': fan } as React.CSSProperties}
    >
      {showImage ? (
        <ViewportImage src={imageUrl} alt="" draggable={false} className="h-full w-full object-cover"
          onError={() => setFailedUrl(imageUrl)} />
      ) : (
        <Icon icon={cover.kind === 'video' ? 'mdi:video-outline' : 'mdi:image-outline'}
          width={20} height={20} className="mt-0.5" aria-hidden="true" />
      )}
    </div>
  );
}

function GroupNode({ id, data, selected }: NodeProps) {
  const t = useT();
  const { groupId, color, label, groupCollapsed } = data as unknown as GroupNodeData;
  const renameGroup = useAppStore((s) => s.renameGroup);
  const toggleGroupCollapsed = useAppStore((s) => s.toggleGroupCollapsed);
  const setGroupColor = useAppStore((s) => s.setGroupColor);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const settleGroupMembersOnResizeEnd = useAppStore((s) => s.settleGroupMembersOnResizeEnd);
  const childCount = useAppStore((s) => getGroupChildCount(s.nodes, id));
  // 锁定的分组同样禁止缩放
  const isNodeLocked = useNodeLocked(id);
  const editingRef = useRef(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [showColors, setShowColors] = useState(false);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const colorPaletteRef = useRef<HTMLDivElement>(null);
  const handleResizeEnd = useCallback(() => {
    settleGroupMembersOnResizeEnd(id);
  }, [id, settleGroupMembersOnResizeEnd]);

  useEffect(() => {
    if (!showColors) return;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (colorButtonRef.current?.contains(target) || colorPaletteRef.current?.contains(target)) return;
      setShowColors(false);
    };
    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
  }, [showColors]);

  // 订阅成字符串，避免每次渲染返回新数组
  const childImageKey = useAppStore((s) => getGroupChildImageKey(s.nodes, id));
  // 组内媒体随机抽 2-3 项当封面；候选变化时重抽
  const [covers, setCovers] = useState<GroupCoverItem[]>(() => pickCovers(childImageKey));
  const [coverKey, setCoverKey] = useState(childImageKey);
  if (coverKey !== childImageKey) {
    // 组内封面候选变化时重抽；随机只在状态迁移时发生，保持渲染纯函数
    setCoverKey(childImageKey);
    setCovers(pickCovers(childImageKey));
  }

  const executeGroupBatch = useCallback(async () => {
    const state = useAppStore.getState();
    const allNodes = state.nodes;
    const allEdges = state.edges;
    const {
      commitToHistory: commitBatchToHistory,
      showToast,
      currentProjectId,
    } = state;

    // 收集该分组下的所有子节点 ID
    const childIds = allNodes.filter((n) => n.parentId === id).map((n) => n.id);
    if (childIds.length === 0) return;

    setBatchRunning(true);
    const ctx: BatchContext = {
      commitToHistory: commitBatchToHistory,
      currentProjectId,
    };
    const { ok, fail, skipped } = await batchExecuteNodes(childIds, allNodes, allEdges, ctx);
    setBatchRunning(false);
    if (useAppStore.getState().currentProjectId !== currentProjectId) return;

    const parts: string[] = [];
    if (ok > 0) parts.push(t('{count} 个成功', { count: ok }));
    if (fail > 0) parts.push(t('{count} 个失败', { count: fail }));
    if (skipped > 0) parts.push(`已跳过 ${skipped} 个（输入或画布已变化）`);
    if (parts.length > 0) {
      showToast(t('分组批量生成完成：{result}', { result: parts.join('，') }), fail > 0 ? 'error' : undefined);
    }
  }, [id, t]);

  const folderStyle = { '--group-color': color } as React.CSSProperties;
  const colorButton = (
    <AnimatedButton
      ref={colorButtonRef}
      data-tooltip={t('分组颜色')}
      aria-label={t('分组颜色')}
      aria-expanded={showColors}
      onClick={() => setShowColors((value) => !value)}
      className="canvas-group-folder-btn nodrag"
    >
      <Icon icon="material-symbols:palette-outline" width={16} height={16} />
    </AnimatedButton>
  );
  const colorPalette = showColors && (
    <div ref={colorPaletteRef}
      className={`canvas-group-folder-colors nodrag nowheel${groupCollapsed ? '' : ' canvas-group-expanded-colors'}`}
      role="group" aria-label={t('分组颜色')}>
      {GROUP_COLOR_PALETTE.map((swatch) => (
        <button
          key={swatch}
          type="button"
          aria-label={swatch}
          aria-pressed={swatch === color}
          className={`canvas-group-swatch${swatch === color ? ' is-active' : ''}`}
          style={{ background: swatch }}
          onClick={() => setGroupColor(groupId, swatch)}
        />
      ))}
    </div>
  );

  if (groupCollapsed) {
    return (
      <>
        <div
          className="canvas-group-folder"
          style={folderStyle}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            toggleGroupCollapsed(id);
          }}
        >
          <div className="canvas-group-folder-tab" />
          {covers.length > 0 ? (
            <div className="canvas-group-folder-photos">
              {covers.map((cover, i) => (
                <GroupCoverPhoto key={cover.id} cover={cover} fan={i - (covers.length - 1) / 2} />
              ))}
            </div>
          ) : (
            <div className="canvas-group-folder-paper" />
          )}
          <div className="canvas-group-folder-body">
            <div className="canvas-group-folder-top">
              <span>{t('{count} 节点', { count: childCount })}</span>
              <AnimatedButton
                data-tooltip={t('展开分组')}
                onClick={() => toggleGroupCollapsed(id)}
                className="canvas-group-folder-btn nodrag"
              >
                <Icon icon="material-symbols:arrow-outward-rounded" width={16} height={16} />
              </AnimatedButton>
            </div>
            <div className="canvas-group-folder-bottom">
              <span className="canvas-group-folder-name">{label}</span>
              {colorButton}
            </div>
          </div>
          {colorPalette}
        </div>

        <Handle type="source" position={Position.Left} id="left" className="group-conn-handle" style={{ background: color, borderColor: color }} />
        <Handle type="source" position={Position.Right} id="right" className="group-conn-handle" style={{ background: color, borderColor: color }} />
      </>
    );
  }

  return (
    <>
      <NodeResizer
        isVisible={!isNodeLocked}
        minWidth={200}
        minHeight={120}
        onResizeStart={commitToHistory}
        onResizeEnd={handleResizeEnd}
        handleStyle={{
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: 'var(--brand)',
          border: '2px solid var(--theme-card)',
        }}
        lineStyle={{
          borderColor: 'var(--brand-alpha-25)',
          borderWidth: 1,
        }}
      />
      <div className="canvas-group-node-wrapper" style={{ color }}>
        <div className="canvas-group-title">
          <span
            contentEditable
            suppressContentEditableWarning
            className="canvas-group-label-text nodrag"
            spellCheck={false}
            onFocus={() => { editingRef.current = true; }}
            onBlur={(e) => {
              editingRef.current = false;
              const text = e.currentTarget.textContent ?? '';
              if (text.trim() && text.trim() !== label) {
                renameGroup(groupId, text.trim());
              } else {
                e.currentTarget.textContent = label;
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLElement).blur();
              }
              if (e.key === 'Escape') {
                (e.target as HTMLElement).textContent = label;
                (e.target as HTMLElement).blur();
              }
            }}
          >
            {label}
          </span>
          <AnimatedButton
            data-tooltip={t('折叠为文件夹')}
            onClick={() => toggleGroupCollapsed(id)}
            className="canvas-group-collapse-btn nodrag"
          >
            <Icon icon="material-symbols:folder-rounded" width={14} height={14} />
          </AnimatedButton>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              {colorButton}
              {colorPalette}
            </div>
            <span className="canvas-group-count">{t('{count} 节点', { count: childCount })}</span>
            {selected && (
              <AnimatedButton
                data-tooltip={t('批量生成')}
                disabled={batchRunning}
                onClick={executeGroupBatch}
                className="w-5 h-5 rounded flex items-center justify-center ml-1 transition-colors hover:text-green-300 hover:bg-green-500/15 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Icon icon="material-symbols:play-arrow-rounded" width={16} height={16} />
              </AnimatedButton>
            )}
          </div>
        </div>

        {/* Group visual box — fills the group body area */}
        <div
          className="canvas-group-node-box"
          style={{
            backgroundColor: `${color}08`,
            borderColor: `${color}20`,
          }}
        >
          <div className="canvas-group-handle" />

          {/* Resize handle hint — bottom-right corner */}
          <div className="canvas-group-resize-hint" />
        </div>
      </div>

      {/* 两侧连线手柄：左=输入（共享给组内全部节点），右=输出（汇总组内全部节点） */}
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        className="group-conn-handle"
        style={{ background: color, borderColor: `${color}` }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="group-conn-handle"
        style={{ background: color, borderColor: `${color}` }}
      />
    </>
  );
}

export default memo(GroupNode);
