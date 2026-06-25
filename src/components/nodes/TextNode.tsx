/**
 * TextNode 文本节点 — 在画布上渲染文本内容，支持编辑、复制、清除空行、全屏、拖拽调整大小
 */
import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import TextNodeToolbar from './shared/TextNodeToolbar';
import GooeyBtn from './shared/GooeyBtn';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import { useNodeRename } from './shared/useNodeRename';
import { useAppStore } from '../../store/useAppStore';
import { uploadSourceFile } from '../../services/fileService';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';

function AITextNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const justCompleted = useCompletionFlash(data.status);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const openNodeDialog = useAppStore((s) => s.openNodeDialog);
  const isSingleSelection = useAppStore((s) => s.selectedNodeIds.length <= 1);
  const isSource = data.role === 'source';

  // ── Fullscreen ──
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenTextareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Copy ──
  const handleCopyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard API unavailable — silently ignore
    }
  }, []);

  // ── 文本选中模式：双击输出区进入（启用 user-select + nodrag，不影响默认拖拽）──
  const outputRef = useRef<HTMLDivElement>(null);
  const [selectingText, setSelectingText] = useState(false);

  const enterTextSelect = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止冒泡到画布的双击处理
    setSelectingText(true);
    // 进入即选中全文，便于直接复制（也可随后拖拽调整选区）
    requestAnimationFrame(() => {
      const el = outputRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  }, []);

  // 点击/拖拽到输出区之外时退出选中模式，恢复节点可拖拽
  useEffect(() => {
    if (!selectingText) return;
    const onDown = (ev: MouseEvent) => {
      if (outputRef.current && !outputRef.current.contains(ev.target as Node)) {
        setSelectingText(false);
        window.getSelection()?.removeAllRanges();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [selectingText]);

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
  const handleCopyToClipboardFn = useCallback(
    (text: string) => handleCopyToClipboard(text),
    [handleCopyToClipboard],
  );

  const handleClearEmptyLines = useCallback(() => {
    if (!data.output) return;
    const cleaned = data.output.replace(/\n{3,}/g, '\n\n');
    if (cleaned !== data.output) {
      updateNodeData(id, { output: cleaned });
    }
  }, [id, data.output, updateNodeData]);

  const handleOpenFullscreen = useCallback(() => {
    setIsFullscreen(true);
  }, []);

  const handleShowPrompt = useCallback(() => {
    const nodeElement = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (nodeElement) {
      const rect = nodeElement.getBoundingClientRect();
      openNodeDialog(id, { x: rect.left + rect.width / 2, y: rect.bottom });
      return;
    }
    openNodeDialog(id);
  }, [id, openNodeDialog]);

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

  const handleFullscreenChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateNodeData(id, { output: e.target.value });
    },
    [id, updateNodeData],
  );

  // ── Upload handler for source nodes ──
  const [isUploading, setIsUploading] = useState(false);

  const handleUpload = useCallback(async () => {
    setIsUploading(true);
    try {
      const result = await uploadSourceFile('.txt,.md,.json,.csv,.xml,.yaml,.yml,.log');
      if (!result) return;

      // Read the text content from the data URL
      let textContent = '';
      if (result.dataUrl.startsWith('data:text/')) {
        const base64 = result.dataUrl.split(',')[1];
        try {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          textContent = new TextDecoder('utf-8').decode(bytes);
        } catch {
          textContent = atob(base64);
        }
      } else {
        // For binary files, just show the dataUrl
        textContent = result.dataUrl;
      }

      // Calculate approximate line count for height
      const lineCount = textContent.split('\n').length;
      const estimatedHeight = Math.max(120, Math.min(600, 40 + lineCount * 20));

      updateNodeData(id, {
        output: textContent,
        fileName: result.fileName,
        label: result.fileName,
        status: 'success',
        nodeHeight: estimatedHeight,
      } as Partial<BaseNodeData>);
    } catch {
      // silently ignore
    } finally {
      setIsUploading(false);
    }
  }, [id, updateNodeData]);

  const { displayLabel, handleRename } = useNodeRename(id, data, '粘贴文本');

  // 文本选中编辑时隐藏连接手柄：保留布局/位置（不脱锚），仅去掉显示与交互
  const handleHideStyle: React.CSSProperties | undefined = selectingText
    ? { opacity: 0, pointerEvents: 'none' }
    : undefined;

  // ── Render ──
  return (
    <>
    <div className="node-wrapper relative" style={{ width: nodeWidth }}>
      {/* Floating toolbar stays mounted so selection changes can animate. */}
      <div className={`node-toolbar-shell ${selected && isSingleSelection ? 'is-visible' : ''}`}>
        <TextNodeToolbar
          nodeId={id}
          data={data}
          onCopy={handleCopyToClipboardFn}
          onClearEmptyLines={handleClearEmptyLines}
          onShowPrompt={handleShowPrompt}
          onFullscreen={handleOpenFullscreen}
        />
      </div>
      <NodeLabel
        kind="ai-text"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        nodeId={id}
        onRename={handleRename}
      />
      <div
        className={`node text-node ${selected ? 'selected' : ''} ${data.status === 'loading' ? 'loading' : ''} ${justCompleted ? 'just-completed' : ''}`}
        style={{ height: nodeHeight }}
      >
        <div className="node-preview compact">
          {isSource && (
            <button
              className="node-upload-btn"
              onClick={(e) => { e.stopPropagation(); handleUpload(); }}
              data-tooltip="上传文本文件"
              aria-label="上传文本文件"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
          )}
          {data.output ? (
            <div
              ref={outputRef}
              className={`text-output-content compact nowheel${selectingText ? ' is-selecting nodrag' : ''}`}
              onDoubleClick={enterTextSelect}
              onCopy={() => { requestAnimationFrame(() => setSelectingText(false)); }}
              title={selectingText ? undefined : '双击可选中复制'}
            >
              {data.output}
            </div>
          ) : isUploading ? (
            <div className="node-preview-loading">
              <div className="spinner" />
              <span>上传中...</span>
            </div>
          ) : data.status === 'loading' ? (
            <div className="node-preview-loading">
              <div className="spinner" />
              <span>生成中...</span>
            </div>
          ) : (
            <div className="node-preview-placeholder">
              {isSource ? '上传文本文件或粘贴内容' : '输入提示词开始创作'}
            </div>
          )}
        </div>
        {data.output && (
          <span className="text-node-wordcount">
            {data.output.length.toLocaleString()} 字
          </span>
        )}

        {data.error && <NodeError nodeId={id} message={data.error} />}


        {/* 文本选中编辑时隐藏手柄，避免遮挡/干扰选区（用 opacity 而非卸载，保留 handle 位置不让连线脱锚）*/}
        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-text" style={handleHideStyle} >
          <GooeyBtn className="gooey-btn-left" hue={234} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-text" style={handleHideStyle} >
          <GooeyBtn className="gooey-btn-right" hue={234} />
        </Handle>
      </div>

      {/* Resize handle — outside .node to avoid overflow:hidden + border-radius clipping */}
      {!selectingText && (
        <div className="node-resize-handle" onPointerDownCapture={handleResizeStart} />
      )}
    </div>

    {/* Fullscreen overlay */}
      <FullscreenOverlay
        isOpen={isFullscreen}
      onClose={handleCloseFullscreen}
      title={(data.label as string) || '文本内容'}
      >
      <textarea
        ref={fullscreenTextareaRef}
        className="fullscreen-textarea"
        value={(data.output as string) || ''}
        onChange={handleFullscreenChange}
        spellCheck={false}
      />
      </FullscreenOverlay>
    </>
  );
}

export default memo(AITextNode);
