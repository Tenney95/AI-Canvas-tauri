/**
 * MultiSelectToolbar 多选工具栏 — 选中 ≥2 个节点时悬浮显示，支持批量执行和对齐操作
 */
import { memo, useMemo, useCallback, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Icon } from '@iconify/react';
import { useAppStore } from '../../store/useAppStore';
import { getNodeBounds, getParentOffset } from '../../utils/nodeBounds.js';
import type { Node as RFNode } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import AnimatedButton from '../shared/AnimatedButton';
import { batchExecuteNodes, type BatchContext } from '../../utils/batchExecute';
import DistributionGapHandles from './DistributionGapHandles';
import {
  distributeNodesWithEqualGap,
  type DistributionAxis,
} from '../../utils/distributionGeometry';

// ── Align & Distribute config ──
type AlignKey = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
type DistributeKey = DistributionAxis;
type ActionKey = AlignKey | DistributeKey;

interface ToolbarAction {
  icon: string;
  label: string;
  key: ActionKey;
}

const ALIGN_ACTIONS: ToolbarAction[] = [
  { icon: 'material-symbols:align-horizontal-left-rounded', label: '左对齐', key: 'left' },
  { icon: 'material-symbols:align-horizontal-center-rounded', label: '水平居中', key: 'center' },
  { icon: 'material-symbols:align-horizontal-right-rounded', label: '右对齐', key: 'right' },
  { icon: 'material-symbols:align-vertical-top-rounded', label: '顶对齐', key: 'top' },
  { icon: 'material-symbols:align-vertical-center-rounded', label: '垂直居中', key: 'middle' },
  { icon: 'material-symbols:align-vertical-bottom-rounded', label: '底对齐', key: 'bottom' },
];

const DISTRIBUTE_ACTIONS: ToolbarAction[] = [
  { icon: 'material-symbols:horizontal-distribute-rounded', label: '横向平均分布', key: 'horizontal' },
  { icon: 'material-symbols:vertical-distribute-rounded', label: '纵向平均分布', key: 'vertical' },
];

/** 稳定空数组引用 —— 非多选时返回它，避免拖拽期间无谓重渲染 */
const EMPTY_NODES: RFNode<BaseNodeData>[] = [];

interface DistributionMode {
  axis: DistributionAxis;
  selectionKey: string;
}

const getSelectionKey = (ids: string[]) => [...ids].sort().join('\u0000');

function MultiSelectToolbar() {
  const selectedNodeIds = useAppStore((s) => s.selectedNodeIds);
  // 仅当选中 ≥2 个节点时才订阅 nodes；否则返回稳定空引用，
  // 这样单节点拖拽（每帧改 nodes）完全不会触发本工具栏重渲染。
  const nodes = useAppStore((s) => (s.selectedNodeIds.length >= 2 ? s.nodes : EMPTY_NODES));
  const setNodes = useAppStore((s) => s.setNodes);
  const recordOutputHistory = useAppStore((s) => s.recordOutputHistory);
  const copySelectedNodes = useAppStore((s) => s.copySelectedNodes);
  const { flowToScreenPosition } = useReactFlow();
  const [batchRunning, setBatchRunning] = useState(false);
  const [distributionMode, setDistributionMode] = useState<DistributionMode | null>(null);

  const selectedCount = selectedNodeIds.length;
  const selectionKey = useMemo(() => getSelectionKey(selectedNodeIds), [selectedNodeIds]);
  const distributionAxis = distributionMode?.selectionKey === selectionKey
    ? distributionMode.axis
    : null;

  // ── Compute toolbar screen position (centered above selection bounds) ──
  const toolbarScreenPos = useMemo(() => {
    if (selectedCount < 2) return null;
    const sel = nodes.filter((n) => selectedNodeIds.includes(n.id));
    if (sel.length < 2) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of sel) {
      const b = getNodeBounds(node, nodes);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.right > maxX) maxX = b.right;
      if (b.bottom > maxY) maxY = b.bottom;
    }
    return flowToScreenPosition({ x: (minX + maxX) / 2, y: minY });
  }, [selectedNodeIds, nodes, flowToScreenPosition, selectedCount]);

  // ── Alignment ──
  const doAlign = useCallback(
    (key: AlignKey) => {
      setDistributionMode(null);
      const currentNodes = useAppStore.getState().nodes;
      const currentIds = useAppStore.getState().selectedNodeIds;
      if (currentIds.length < 2) return;

      const sel = currentNodes.filter((n) => currentIds.includes(n.id) && n.type !== 'group');
      if (sel.length < 2) return;

      const isX = key === 'left' || key === 'center' || key === 'right';

      useAppStore.getState().commitToHistory();

      const updated = currentNodes.map((n) => {
        if (!currentIds.includes(n.id) || n.type === 'group') return n;
        const b = getNodeBounds(n, currentNodes);
        const po = getParentOffset(n, currentNodes);
        const newPos = { ...n.position };

        if (isX) {
          const target =
            key === 'left' ? Math.min(...sel.map((s) => getNodeBounds(s, currentNodes).x))
            : key === 'center' ? sel.reduce((sum, s) => sum + getNodeBounds(s, currentNodes).centerX, 0) / sel.length
            : Math.max(...sel.map((s) => getNodeBounds(s, currentNodes).right));
          const edgeOffset = key === 'left' ? 0 : key === 'center' ? b.width / 2 : b.width;
          newPos.x = target - po.x - edgeOffset;
        } else {
          const target =
            key === 'top' ? Math.min(...sel.map((s) => getNodeBounds(s, currentNodes).y))
            : key === 'middle' ? sel.reduce((sum, s) => sum + getNodeBounds(s, currentNodes).centerY, 0) / sel.length
            : Math.max(...sel.map((s) => getNodeBounds(s, currentNodes).bottom));
          const edgeOffset = key === 'top' ? 0 : key === 'middle' ? b.height / 2 : b.height;
          newPos.y = target - po.y - edgeOffset;
        }

        return { ...n, position: newPos };
      });

      setNodes(updated as RFNode<BaseNodeData & Record<string, unknown>>[]);
    },
    [setNodes],
  );

  // ── Distribute ──
  const doDistribute = useCallback(
    (key: DistributeKey) => {
      const currentNodes = useAppStore.getState().nodes;
      const currentIds = useAppStore.getState().selectedNodeIds;
      if (currentIds.length < 3) return;

      const sel = currentNodes.filter((n) => currentIds.includes(n.id) && n.type !== 'group');
      if (sel.length < 3) return;

      useAppStore.getState().commitToHistory();
      setNodes(distributeNodesWithEqualGap(currentNodes, currentIds, key));
      setDistributionMode({ axis: key, selectionKey: getSelectionKey(currentIds) });
    },
    [setNodes],
  );

  // ── Batch Execute ──
  const executeBatch = useCallback(async () => {
    const state = useAppStore.getState();
    const currentNodes = state.nodes;
    const currentEdges = state.edges;
    const currentIds = state.selectedNodeIds;
    const { updateNodeData, showToast: toast, currentProjectId } = state;

    // 前置检查：是否有可执行节点
    const hasExecutable = currentNodes.some(
      (n) =>
        currentIds.includes(n.id) &&
        n.type !== 'group' &&
        n.data?.type &&
        ['ai-text', 'ai-image', 'ai-video', 'ai-audio'].includes(n.data.type) &&
        n.data?.model &&
        n.data?.provider &&
        (n.data?.prompt || '').trim() &&
        n.data?.status !== 'loading',
    );

    if (!hasExecutable) {
      toast('选中的节点中没有可执行的（需要配置模型且有 prompt）', 'error');
      return;
    }

    setBatchRunning(true);

    const ctx: BatchContext = { updateNodeData, recordOutputHistory, currentProjectId };
    const { ok, fail } = await batchExecuteNodes(currentIds, currentNodes, currentEdges, ctx);

    setBatchRunning(false);
    const parts: string[] = [];
    if (ok > 0) parts.push(`${ok} 个成功`);
    if (fail > 0) parts.push(`${fail} 个失败`);
    toast(`批量生成完成：${parts.join('，')}`, fail > 0 ? 'error' : undefined);
  }, [recordOutputHistory]);

  // ── Copy selected nodes to internal clipboard ──
  const handleCopyNodes = useCallback(() => {
    copySelectedNodes();
    useAppStore.getState().showToast(`已复制 ${useAppStore.getState().selectedNodeIds.length} 个节点`);
  }, [copySelectedNodes]);

  if (selectedCount < 2 || !toolbarScreenPos) return null;

  return (
    <>
      {distributionAxis && <DistributionGapHandles axis={distributionAxis} />}
      <div
      className="fixed z-[9999] pointer-events-auto flex items-center gap-1 bg-canvas-card/95 border border-canvas-border backdrop-blur-xl rounded-lg px-2 py-1 shadow-xl"
      style={{
        left: toolbarScreenPos.x,
        top: toolbarScreenPos.y - 52,
        transform: 'translate(-50%, -100%)',
      }}
    >
      {/* Batch execute */}
      <AnimatedButton
        data-tooltip="批量生成"
        disabled={batchRunning}
        onClick={executeBatch}
        className="w-8 h-8 rounded flex items-center justify-center transition-colors hover:text-green-300 hover:bg-green-500/15 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Icon icon="material-symbols:play-arrow-rounded" width={28} height={28} />
      </AnimatedButton>

      <div className="w-px h-5 bg-canvas-border" />

      {/* Copy nodes */}
      <AnimatedButton
        data-tooltip="复制节点"
        onClick={handleCopyNodes}
        className="w-8 h-8 rounded flex items-center justify-center transition-colors text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover"
      >
        <Icon icon="mdi:content-copy" width={18} height={18} />
      </AnimatedButton>

      <div className="w-px h-5 bg-canvas-border" />

      {/* Align buttons */}
      {ALIGN_ACTIONS.map(({ icon, label, key }) => (
        <AnimatedButton
          key={key}
          data-tooltip={label}
          onClick={() => doAlign(key as AlignKey)}
          className="w-8 h-8 rounded flex items-center justify-center transition-colors text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover"
        >
          <Icon icon={icon} width={18} height={18} />
        </AnimatedButton>
      ))}

      {/* Distribute buttons (need ≥3 nodes) */}
      {selectedCount >= 3 && (
        <>
          <div className="w-px h-5 bg-canvas-border" />
          {DISTRIBUTE_ACTIONS.map(({ icon, label, key }) => (
            <AnimatedButton
              key={key}
              data-tooltip={label}
              onClick={() => doDistribute(key as DistributeKey)}
              className="w-8 h-8 rounded flex items-center justify-center transition-colors text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover"
            >
              <Icon icon={icon} width={18} height={18} />
            </AnimatedButton>
          ))}
        </>
      )}
      </div>
    </>
  );
}

export default memo(MultiSelectToolbar);
