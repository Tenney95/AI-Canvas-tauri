import { memo, useState, useCallback, useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import { useAppStore } from '../../store/useAppStore';

function AITextNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);

  // ── Edit state ──
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Resize ──
  const isResizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, width: 280, height: 160 });
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 160;

  // ── Double-click → enter edit mode ──
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const text = data.output || '';
      setEditValue(text);
      setIsEditing(true);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    },
    [data.output],
  );

  // Prevent single-click on output from opening the node dialog
  const handleContentClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // ── Save edit ──
  const handleEditSave = useCallback(() => {
    if (editValue !== data.output) {
      updateNodeData(id, { output: editValue });
    }
    setIsEditing(false);
  }, [id, editValue, data.output, updateNodeData]);

  // ── Cancel edit (Escape) ──
  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsEditing(false);
      }
    },
    [],
  );

  // ── Resize: pointerdown on handle (capture phase → fires before React Flow) ──
  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isResizing.current = true;
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        width: nodeWidth,
        height: nodeHeight,
      };

      const handlePointerMove = (ev: PointerEvent) => {
        if (!isResizing.current) return;
        const dx = ev.clientX - resizeStart.current.x;
        const dy = ev.clientY - resizeStart.current.y;
        const newWidth = Math.max(200, resizeStart.current.width + dx);
        const newHeight = Math.max(120, resizeStart.current.height + dy);
        updateNodeData(id, { nodeWidth: newWidth, nodeHeight: newHeight } as Partial<BaseNodeData>);
      };

      const handlePointerUp = () => {
        isResizing.current = false;
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    },
    [id, nodeWidth, nodeHeight, updateNodeData],
  );

  // ── Render ──
  return (
    <div className="node-wrapper relative" style={{ width: nodeWidth }}>
      <NodeLabel kind="ai-text" label={data.label || '生成文本'} displayId={data.displayId as number | undefined} />
      <div
        className={`node text-node ${selected ? 'selected' : ''} ${data.status === 'loading' ? 'loading' : ''}`}
        style={{ height: nodeHeight }}
      >
        <div className="node-preview compact">
          {isEditing ? (
            <textarea
              ref={textareaRef}
              className="nodrag nowheel text-output-edit"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleEditSave}
              onKeyDown={handleEditKeyDown}
              spellCheck={false}
            />
          ) : data.output ? (
            <div
              className="text-output-content compact"
              data-tooltip="双击编辑"
              onClick={handleContentClick}
              onDoubleClick={handleDoubleClick}
            >
              {data.output}
            </div>
          ) : data.status === 'loading' ? (
            <div className="node-preview-loading">
              <div className="spinner" />
              <span>生成中...</span>
            </div>
          ) : (
            <div className="node-preview-placeholder">输入提示词开始创作</div>
          )}
        </div>
        {data.error && <div className="node-error">{data.error}</div>}

        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-text" />
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-text" />
      </div>

      {/* Resize handle — outside .node to avoid overflow:hidden + border-radius clipping */}
      <div className="node-resize-handle" onPointerDownCapture={handleResizeStart} />
    </div>
  );
}

export default memo(AITextNode);
