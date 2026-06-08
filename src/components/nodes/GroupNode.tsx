/**
 * GroupNode — 分组节点组件
 *
 * 使用 React Flow 原生 parentId 机制，作为子节点的父节点。
 * 拖拽分组时 React Flow 自动同步所有子节点位置，无卡顿。
 * 支持拖拽右下角调整大小。
 */
import { useRef } from 'react';
import { NodeResizer } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { useAppStore } from '../../store/useAppStore';

interface GroupNodeData {
  groupId: string;
  color: string;
  label: string;
}

export default function GroupNode({ id, data }: NodeProps) {
  const { groupId, color, label } = data as unknown as GroupNodeData;
  const renameGroup = useAppStore((s) => s.renameGroup);
  const childCount = useAppStore((s) => s.nodes.filter((n) => n.parentId === id).length);
  const editingRef = useRef(false);

  if (childCount === 0) return null;

  return (
    <>
      <NodeResizer
        minWidth={200}
        minHeight={120}
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
      <div className="canvas-group-node-wrapper">
        {/* Group visual box — fills the entire node area */}
        <div
          className="canvas-group-node-box"
          style={{
            backgroundColor: `${color}08`,
            borderColor: `${color}20`,
          }}
        >
          {/* Drag handle bar with title */}
          <div
            className="canvas-group-handle"
            style={{
              backgroundColor: `${color}15`,
              borderBottomColor: `${color}20`,
              color,
            }}
          >
            <span
              contentEditable
              suppressContentEditableWarning
              className="canvas-group-label-text"
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
          </div>

          {/* Resize handle hint — bottom-right corner */}
          <div className="canvas-group-resize-hint" />
        </div>
      </div>
    </>
  );
}
