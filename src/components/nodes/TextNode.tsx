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
import { textNodeHeight } from '../../utils/num';
import { useShiftProportional, useProportionalLock, computeResize } from '../../hooks/useShiftProportional';

function AITextNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const justCompleted = useCompletionFlash(data.status);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const openNodeDialog = useAppStore((s) => s.openNodeDialog);
  const isSingleSelection = useAppStore((s) => s.selectedNodeIds.length <= 1);
  const isSource = data.role === 'source';
  const [isUploading, setIsUploading] = useState(false);

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

  // ── 节点内编辑：双击已有内容或空占位区进入 ──
  const inlineTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editEndingRef = useRef(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftOutput, setDraftOutput] = useState('');

  const enterInlineEdit = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isUploading || data.status === 'loading') return;

    editEndingRef.current = false;
    setDraftOutput((data.output as string) || '');
    setIsEditing(true);
    requestAnimationFrame(() => {
      const textarea = inlineTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }, [data.output, data.status, isUploading]);

  const finishInlineEdit = useCallback((save: boolean) => {
    if (editEndingRef.current) return;
    editEndingRef.current = true;

    const previousOutput = (data.output as string) || '';
    setIsEditing(false);
    if (save && draftOutput !== previousOutput) {
      updateNodeData(id, { output: draftOutput });
    }
    requestAnimationFrame(() => {
      editEndingRef.current = false;
    });
  }, [data.output, draftOutput, id, updateNodeData]);

  const handleInlineKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finishInlineEdit(false);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      finishInlineEdit(true);
    }
  }, [finishInlineEdit]);

  // ── Shift 等比缩放 ──
  const shiftHeld = useShiftProportional();
  const { lockRef, reset: resetProportional, lock: lockProportional } = useProportionalLock();

  // ── Resize ──
  const isResizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, width: 280, height: 160 });
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 160;

  // 最新值 refs（供原生事件闭包读取）
  const latestResizeRef = useRef({ id, nodeWidth, nodeHeight, updateNodeData });
  useEffect(() => {
    latestResizeRef.current = { id, nodeWidth, nodeHeight, updateNodeData };
  }, [id, nodeHeight, nodeWidth, updateNodeData]);

  useEffect(() => {
    const el = resizeHandleRef.current;
    if (!el) return;

    const onNativePointerDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡到 React 根节点 → React Flow 收不到 → 不框选

      const { id: nid, nodeWidth: nw, nodeHeight: nh, updateNodeData: upd } = latestResizeRef.current;
      isResizing.current = true;
      resizeStart.current = { x: e.clientX, y: e.clientY, width: nw, height: nh };
      resetProportional();

      const handlePointerMove = (ev: PointerEvent) => {
        if (!isResizing.current) return;

        let baseW = resizeStart.current.width;
        let baseH = resizeStart.current.height;
        let dx = ev.clientX - resizeStart.current.x;
        let dy = ev.clientY - resizeStart.current.y;
        let ratio = baseH > 0 ? baseW / baseH : 1;
        let useProportional = false;

        if (shiftHeld.current) {
          if (lockRef.current.w === 0) {
            lockProportional(baseW, baseH, resizeStart.current.x, resizeStart.current.y);
          }
          baseW = lockRef.current.w;
          baseH = lockRef.current.h;
          dx = ev.clientX - lockRef.current.x;
          dy = ev.clientY - lockRef.current.y;
          ratio = lockRef.current.ratio;
          useProportional = true;
        } else {
          resetProportional();
        }

        const { width: newWidth, height: newHeight } = computeResize(
          baseW, baseH, dx, dy, ratio, 200, 120, useProportional,
        );
        upd(nid, { nodeWidth: newWidth, nodeHeight: newHeight } as Partial<BaseNodeData>);
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
    };

    el.addEventListener('pointerdown', onNativePointerDown, true);
    return () => el.removeEventListener('pointerdown', onNativePointerDown, true);
  }, [shiftHeld, lockRef, resetProportional, lockProportional]);


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
      const estimatedHeight = textNodeHeight(lineCount);

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

  // 节点内编辑时隐藏连接手柄：保留布局/位置（不脱锚），仅去掉显示与交互
  const handleHideStyle: React.CSSProperties | undefined = isEditing
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
          {isSource && !isEditing && (
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
          {isEditing ? (
            <textarea
              ref={inlineTextareaRef}
              className="text-output-edit nodrag nowheel"
              value={draftOutput}
              onChange={(e) => setDraftOutput(e.target.value)}
              onBlur={() => finishInlineEdit(true)}
              onKeyDown={handleInlineKeyDown}
              onClick={(e) => e.stopPropagation()}
              placeholder={isSource ? '输入或粘贴文本内容…' : '输入文本内容…'}
              aria-label="编辑文本节点内容"
              spellCheck={false}
            />
          ) : data.output ? (
            <div
              className="text-output-content compact nowheel"
              onDoubleClick={enterInlineEdit}
              title="双击编辑"
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
            <div
              className="node-preview-placeholder text-node-empty-editable"
              data-inline-edit-trigger="true"
              onDoubleClick={enterInlineEdit}
              title="双击编辑"
            >
              <span>{isSource ? '上传文本文件或粘贴内容' : '输入提示词开始创作'}</span>
              <span className="text-node-edit-hint">双击编辑内容</span>
            </div>
          )}
        </div>
        {(isEditing || data.output) && (
          <span className="text-node-wordcount">
            {(isEditing ? draftOutput.length : ((data.output as string) || '').length).toLocaleString()} 字
          </span>
        )}

        {data.error && <NodeError nodeId={id} message={data.error} />}


        {/* 节点内编辑时隐藏手柄，避免遮挡输入（用 opacity 而非卸载，保留 handle 位置不让连线脱锚）*/}
        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-text" style={handleHideStyle} >
          <GooeyBtn className="gooey-btn-left" hue={234} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-text" style={handleHideStyle} >
          <GooeyBtn className="gooey-btn-right" hue={234} />
        </Handle>
      </div>

      {/* Resize handle — outside .node to avoid overflow:hidden + border-radius clipping */}
      {!isEditing && (
        <div className="node-resize-handle nokey nodrag nopan" ref={resizeHandleRef} />
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
