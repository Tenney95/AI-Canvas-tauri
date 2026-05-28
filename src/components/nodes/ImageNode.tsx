import { memo, useCallback, useRef, useState, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import { useAppStore } from '../../store/useAppStore';
import { uploadSourceFile } from '../../services/fileService';

function AIImageNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const isSource = data.role === 'source';

  // ── Resize ──
  const isResizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, width: 280, height: 158 });
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 158;

  // ── Resize handler ──
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
        const newWidth = Math.max(160, resizeStart.current.width + dx);
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

  // ── Upload handler for source nodes ──
  const [isUploading, setIsUploading] = useState(false);

  const handleUpload = useCallback(async () => {
    setIsUploading(true);
    try {
      const result = await uploadSourceFile('.png,.jpg,.jpeg,.gif,.webp,.svg');
      if (!result) return;

      // Resize node based on image dimensions
      const img = new Image();
      img.onload = () => {
        // node-preview.compact has 2px padding each side (overridden by .image-node .node-preview.compact)
        const contentWidth = nodeWidth - 4;
        const naturalRatio = img.naturalWidth / img.naturalHeight;
        const previewHeight = Math.round(contentWidth / naturalRatio);
        // nodeHeight = preview height + 4px (top+bottom padding of node-preview.compact)
        const newHeight = Math.max(120, previewHeight + 4);
        updateNodeData(id, {
          imageUrl: result.dataUrl,
          fileName: result.fileName,
          label: result.fileName,
          status: 'success',
          nodeHeight: newHeight,
          imageWidth: img.naturalWidth,
          imageHeight: img.naturalHeight,
        } as Partial<BaseNodeData>);
      };
      img.src = result.dataUrl;
    } catch {
      // silently ignore
    } finally {
      setIsUploading(false);
    }
  }, [id, nodeWidth, updateNodeData]);

  // ── Display label: filename if uploaded, otherwise default ──
  const displayLabel = data.fileName || data.label || '粘贴图像';

  return (
    <div className="node-wrapper relative" style={{ width: nodeWidth }}>
      <NodeLabel
        kind="ai-image"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
      />
      <div
        className={`node image-node ${selected ? 'selected' : ''} ${data.status === 'loading' || isUploading ? 'loading' : ''}`}
        style={{ height: nodeHeight }}
      >
        <div className="node-preview compact">
          {isSource && (
            <button
              className="node-upload-btn"
              onClick={(e) => { e.stopPropagation(); handleUpload(); }}
              title="上传图片"
              aria-label="上传图片"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
          )}
          {data.imageUrl || data.thumbnailUrl ? (
            <img
              src={data.imageUrl || data.thumbnailUrl}
              alt="Generated"
              className="image-preview-img compact"
            />
          ) : isUploading ? (
            <div className="node-preview-loading">
              <div className="spinner large" />
              <span>上传中...</span>
            </div>
          ) : data.status === 'loading' ? (
            <div className="node-preview-loading">
              <div className="spinner large" />
              <span>生成图像中...</span>
            </div>
          ) : (
            <div className="node-preview-placeholder">
              {isSource ? (
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              ) : (
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              )}
            </div>
          )}
        </div>
        {data.error && <div className="node-error">{data.error}</div>}
        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-image" />
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-image" />
      </div>

      {/* Resize handle */}
      <div className="node-resize-handle" onPointerDownCapture={handleResizeStart} />
    </div>
  );
}

export default memo(AIImageNode);
