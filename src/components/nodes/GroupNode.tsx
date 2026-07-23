/**
 * GroupNode — 分组节点组件
 *
 * 使用 React Flow 原生 parentId 机制，作为子节点的父节点。
 * 拖拽分组时 React Flow 自动同步所有子节点位置，无卡顿。
 * 支持拖拽右下角调整大小。
 */
import { useRef, useState, useCallback } from 'react';
import { NodeResizer, Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Icon } from '@iconify/react';
import { useAppStore, type AppState } from '../../store/useAppStore';
import AnimatedButton from '../shared/AnimatedButton';
import { batchExecuteNodes, type BatchContext } from '../../utils/batchExecute';

interface GroupNodeData {
  groupId: string;
  color: string;
  label: string;
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

export default function GroupNode({ id, data, selected }: NodeProps) {
  const { groupId, color, label } = data as unknown as GroupNodeData;
  const renameGroup = useAppStore((s) => s.renameGroup);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const childCount = useAppStore((s) => getGroupChildCount(s.nodes, id));
  const editingRef = useRef(false);
  const [batchRunning, setBatchRunning] = useState(false);

  const executeGroupBatch = useCallback(async () => {
    const state = useAppStore.getState();
    const allNodes = state.nodes;
    const allEdges = state.edges;
    const {
      commitToHistory: commitBatchToHistory,
      updateNodeDataTransient,
      recordOutputHistory,
      showToast,
      currentProjectId,
    } = state;

    // 收集该分组下的所有子节点 ID
    const childIds = allNodes.filter((n) => n.parentId === id).map((n) => n.id);
    if (childIds.length === 0) return;

    setBatchRunning(true);
    const ctx: BatchContext = {
      commitToHistory: commitBatchToHistory,
      updateNodeDataTransient,
      recordOutputHistory,
      currentProjectId,
    };
    const { ok, fail } = await batchExecuteNodes(childIds, allNodes, allEdges, ctx);
    setBatchRunning(false);

    const parts: string[] = [];
    if (ok > 0) parts.push(`${ok} 个成功`);
    if (fail > 0) parts.push(`${fail} 个失败`);
    if (parts.length > 0) {
      showToast(`分组批量生成完成：${parts.join('，')}`, fail > 0 ? 'error' : undefined);
    }
  }, [id]);

  return (
    <>
      <NodeResizer
        minWidth={200}
        minHeight={120}
        onResizeStart={commitToHistory}
        onResizeEnd={commitToHistory}
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
          <span className="canvas-group-count">{childCount} 节点</span>
          {selected && (
            <AnimatedButton
              data-tooltip="批量生成"
              disabled={batchRunning}
              onClick={executeGroupBatch}
              className="w-5 h-5 rounded flex items-center justify-center ml-1 transition-colors hover:text-green-300 hover:bg-green-500/15 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Icon icon="material-symbols:play-arrow-rounded" width={16} height={16} />
            </AnimatedButton>
          )}
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
