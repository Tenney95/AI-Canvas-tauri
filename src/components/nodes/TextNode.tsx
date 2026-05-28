import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import { useAppStore } from '../../store/useAppStore';

/* ── Copy to clipboard with feedback ── */
function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable — silently ignore
    }
  }, []);
  return { copied, copy };
}

function AITextNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);

  // ── Fullscreen ──
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenTextareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Copy ──
  const { copied, copy } = useCopyFeedback();

  // ── Resize ──
  const isResizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, width: 280, height: 160 });
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 160;

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

  // ── Toolbar actions ──
  const hasOutput = Boolean(data.output);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (data.output) copy(data.output);
  }, [data.output, copy]);

  const handleClearEmptyLines = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!data.output) return;
    const cleaned = data.output.replace(/\n{3,}/g, '\n\n');
    if (cleaned !== data.output) {
      updateNodeData(id, { output: cleaned });
    }
  }, [id, data.output, updateNodeData]);

  const handleFullscreen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsFullscreen(true);
  }, []);

  const handleCloseFullscreen = useCallback(() => {
    setIsFullscreen(false);
  }, []);

  // Auto-focus textarea when fullscreen opens
  useEffect(() => {
    if (isFullscreen) {
      requestAnimationFrame(() => {
        const ta = fullscreenTextareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    }
  }, [isFullscreen]);

  // Close fullscreen on Escape
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  const handleFullscreenChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateNodeData(id, { output: e.target.value });
    },
    [id, updateNodeData],
  );

  // ── Render ──
  return (
    <>
    <div className="node-wrapper relative" style={{ width: nodeWidth }}>
      {/* Floating toolbar — only when selected AND has text output */}
      {selected && hasOutput && (
        <div className="node-floating-toolbar text-toolbar">
          <button
            className="ftb-btn icon-only act-copy"
            data-tooltip={copied ? '已复制' : '复制'}
            aria-label="复制"
            onClick={handleCopy}
          >
            {copied ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          <button
            className="ftb-btn icon-only act-clear-empty-lines"
            data-tooltip="清除空行"
            aria-label="清除空行"
            onClick={handleClearEmptyLines}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <path d="M4 6h16" />
              <path d="M4 12h16" />
              <path d="M4 18h8" />
              <path d="M18 15l3 3" />
              <path d="M21 15l-3 3" />
            </svg>
          </button>
          <button
            className="ftb-btn icon-only act-fullscreen"
            data-tooltip="全屏显示"
            aria-label="全屏显示"
            onClick={handleFullscreen}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
        </div>
      )}
      <NodeLabel kind="ai-text" label={data.label || '生成文本'} displayId={data.displayId as number | undefined} />
      <div
        className={`node text-node ${selected ? 'selected' : ''} ${data.status === 'loading' ? 'loading' : ''}`}
        style={{ height: nodeHeight }}
      >
        <div className="node-preview compact">
          {data.output ? (
            <div className="text-output-content compact nodrag nowheel">
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

    {/* Fullscreen overlay — portal to body to escape node CSS constraints */}
    {isFullscreen &&
      createPortal(
        <div className="text-fullscreen-overlay" onClick={handleCloseFullscreen}>
          <div className="text-fullscreen-panel" onClick={(e) => e.stopPropagation()}>
            <div className="text-fullscreen-header">
              <span className="text-fullscreen-title">{data.label || '文本内容'}</span>
              <button className="text-fullscreen-close" onClick={handleCloseFullscreen} aria-label="关闭">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="text-fullscreen-editor">
              <textarea
                ref={fullscreenTextareaRef}
                value={data.output || ''}
                onChange={handleFullscreenChange}
                spellCheck={false}
              />
            </div>
            
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export default memo(AITextNode);
