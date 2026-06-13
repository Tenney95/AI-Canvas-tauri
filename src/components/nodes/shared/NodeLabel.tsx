/**
 * NodeLabel 节点标签 — 渲染节点顶部标题栏，按节点类型显示对应图标/颜色/编号/Beta 角标
 * 支持双击标签文本进行重命名
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { Icon } from '@iconify/react';
import type { NodeType } from '../../../types';
import { getNodeTypeConfig } from '../../../types';

interface NodeLabelProps {
  kind: NodeType;
  label: string;
  displayId?: number;
  isBeta?: boolean;
  nodeId: string;
  onRename: (newName: string) => void;
}

export default function NodeLabel({ kind, label, displayId, isBeta, nodeId: _nodeId, onRename }: NodeLabelProps) {
  const config = getNodeTypeConfig(kind);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditText(label);
    setIsEditing(true);
  }, [label]);

  const handleSave = useCallback(() => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== label) {
      onRename(trimmed);
    }
    setIsEditing(false);
  }, [editText, label, onRename]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        setEditText(label);
        setIsEditing(false);
      }
    },
    [handleSave, label],
  );

  return (
    <div className={`node-label flex items-center gap-2 px-3 py-2 select-none ${isEditing ? 'z-20' : ''}`} data-label-kind={kind}>
      <span
        className={`node-label-icon w-5 h-5 rounded flex items-center justify-center ${config.bg} ${config.color}`}
        aria-hidden="true"
      >
        <Icon icon={config.icon} width="14" height="14" />
      </span>
      {isEditing ? (
        <input
          ref={inputRef}
          className="node-label-input flex-1 min-w-0 bg-canvas-bg text-xs font-medium text-canvas-text border border-canvas-border rounded px-1 py-0.5 outline-none focus:border-indigo-500"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="node-label-text text-xs font-medium text-canvas-text truncate flex-1 min-w-0 cursor-default"
          onDoubleClick={handleDoubleClick}
          title="双击重命名"
        >
          {label}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5 flex-shrink-0">
        {displayId != null && (
          <span className="text-[10px] text-canvas-text-muted font-mono tabular-nums">
            #{displayId}
          </span>
        )}
        {isBeta && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400">
            Beta
          </span>
        )}
      </span>
    </div>
  );
}
