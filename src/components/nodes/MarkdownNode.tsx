/**
 * MarkdownNode 源节点 — 支持 .md 文件的编辑、预览与自动本地保存
 */
import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import GooeyBtn from './shared/GooeyBtn';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import { useAppStore } from '../../store/useAppStore';
import { saveBinaryToProjectData } from '../../services/fileService';
import AnimatedButton from '../shared/AnimatedButton';
import { renderMarkdown } from '../../utils/renderMarkdown';

function MarkdownNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const currentProjectId = useAppStore((s) => s.currentProjectId);

  // ── Edit / Preview toggle ──
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit');

  // ── Fullscreen ──
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fsViewMode, setFsViewMode] = useState<'edit' | 'preview'>('preview');
  const fullscreenTextareaRef = useRef<HTMLTextAreaElement>(null);

  const handleOpenFullscreen = useCallback(() => {
    setFsViewMode('preview');
    setIsFullscreen(true);
  }, []);

  const handleCloseFullscreen = useCallback(() => {
    setIsFullscreen(false);
  }, []);

  // Auto-focus textarea when fullscreen opens in edit mode
  useEffect(() => {
    if (isFullscreen && fsViewMode === 'edit') {
      requestAnimationFrame(() => {
        const ta = fullscreenTextareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    }
  }, [isFullscreen, fsViewMode]);

  // ── Upload ──
  const { isUploading, handleUpload } = useSourceFileUpload('.md');

  // ── 固定文件名（仅首次生成，之后始终覆写到同一文件）──
  const savedFileNameRef = useRef<string>((data.fileName as string) || `markdown-${id}.md`);

  const doSave = useCallback(async (content: string) => {
    if (!content) return;
    const fileName = savedFileNameRef.current;

    try {
      const bytes = new TextEncoder().encode(content);
      const result = await saveBinaryToProjectData(bytes, currentProjectId, fileName);
      if (result) {
        const resolvedName = result.filePath.split(/[/\\]/).pop() || fileName;
        savedFileNameRef.current = resolvedName;
        updateNodeData(id, {
          fileName: resolvedName,
          filePath: result.filePath,
          status: 'success',
        } as Partial<BaseNodeData>);
      }
    } catch {
      // ignore save errors (non-Tauri environment etc.)
    }
  }, [currentProjectId, id, updateNodeData]);

  const onUpload = useCallback(async () => {
    const result = await handleUpload();
    if (!result) return;

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
      textContent = result.dataUrl;
    }

    const lineCount = textContent.split('\n').length;
    const estimatedHeight = Math.max(160, Math.min(600, 40 + lineCount * 20));

    // 使用上传文件的文件名
    savedFileNameRef.current = result.fileName;

    updateNodeData(id, {
      output: textContent,
      fileName: result.fileName,
      label: result.fileName,
      status: 'success',
      nodeHeight: estimatedHeight,
    } as Partial<BaseNodeData>);

    // 立即保存到本地
    doSave(textContent);
  }, [id, handleUpload, updateNodeData, doSave]);

  // ── Auto-save debounce ──
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Resize ──
  const isResizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, width: 280, height: 200 });
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 200;

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isResizing.current = true;
      resizeStart.current = { x: e.clientX, y: e.clientY, width: nodeWidth, height: nodeHeight };

      const handlePointerMove = (ev: PointerEvent) => {
        if (!isResizing.current) return;
        const dx = ev.clientX - resizeStart.current.x;
        const dy = ev.clientY - resizeStart.current.y;
        updateNodeData(id, {
          nodeWidth: Math.max(240, resizeStart.current.width + dx),
          nodeHeight: Math.max(140, resizeStart.current.height + dy),
        } as Partial<BaseNodeData>);
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

  // ── Content change (edit mode) with debounced auto-save ──
  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      updateNodeData(id, { output: value } as Partial<BaseNodeData>);

      // debounce auto-save: 1.5s after last keystroke
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => {
        doSave(value);
      }, 1500);
    },
    [id, updateNodeData, doSave],
  );

  // ── Markdown preview HTML ──
  const previewHtml = renderMarkdown((data.output as string) || '');

  const { displayLabel, handleRename } = useNodeRename(id, data, 'Markdown 文档');

  return (
    <>
    <div className="node-wrapper relative" style={{ width: nodeWidth }}>
      <NodeLabel
        kind="ai-markdown"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        nodeId={id}
        onRename={handleRename}
      />

      <div
        className={`node markdown-node ${selected ? 'selected' : ''}`}
        style={{ height: nodeHeight }}
      >
        {/* Toolbar */}
        <div className="markdown-node-toolbar">
          <div className="flex items-center gap-1">
            <AnimatedButton
              type="button"
              className={`markdown-mode-btn${viewMode === 'edit' ? ' active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewMode('edit'); }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </AnimatedButton>
            <AnimatedButton
              type="button"
              className={`markdown-mode-btn${viewMode === 'preview' ? ' active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewMode('preview'); }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
            </AnimatedButton>
          </div>
          <div className="flex items-center gap-1">
            <AnimatedButton
              type="button"
              className="markdown-mode-btn"
              disabled={isUploading}
              onClick={(e) => { e.stopPropagation(); onUpload(); }}
              title="上传 .md 文件"
            >
              {isUploading ? (
                <div className="spinner-sm" />
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              )}
            </AnimatedButton>
            <AnimatedButton
              type="button"
              className="markdown-mode-btn"
              onClick={(e) => { e.stopPropagation(); handleOpenFullscreen(); }}
              title="全屏显示"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            </AnimatedButton>
          </div>
        </div>

        {/* Content area */}
        <div className="markdown-node-content">
          {viewMode === 'edit' ? (
            <textarea
              className="nodrag nowheel markdown-edit-area"
              value={(data.output as string) || ''}
              onChange={handleContentChange}
              placeholder="# Markdown 文档&#10;&#10;点击上方按钮上传 .md 文件，或直接在此编辑…"
              spellCheck={false}
            />
          ) : (
            <div className="markdown-preview-area">
              {(data.output as string) ? (
                <div
                  className="markdown-rendered"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              ) : (
                <div className="node-preview-placeholder">
                  暂无内容 — 切换到编辑模式开始写作
                </div>
              )}
            </div>
          )}
        </div>

        {/* Status bar */}
        <span className="text-node-wordcount">
          {((data.output as string) || '').length.toLocaleString()} 字
        </span>

        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-text">
          <GooeyBtn className="gooey-btn-left" hue={270} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-text">
          <GooeyBtn className="gooey-btn-right" hue={270} />
        </Handle>
      </div>

      <div className="node-resize-handle" onPointerDownCapture={handleResizeStart} />
    </div>

    {/* Fullscreen overlay */}
    <FullscreenOverlay
      isOpen={isFullscreen}
      onClose={handleCloseFullscreen}
      title={(data.label as string) || 'Markdown 文档'}
    >
      <div className="fullscreen-toolbar">
        <AnimatedButton
          type="button"
          className={`markdown-mode-btn${fsViewMode === 'edit' ? ' active' : ''}`}
          onClick={() => setFsViewMode('edit')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </AnimatedButton>
        <AnimatedButton
          type="button"
          className={`markdown-mode-btn${fsViewMode === 'preview' ? ' active' : ''}`}
          onClick={() => setFsViewMode('preview')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
        </AnimatedButton>
      </div>
      {fsViewMode === 'edit' ? (
        <textarea
          ref={fullscreenTextareaRef}
          className="fullscreen-textarea"
          value={(data.output as string) || ''}
          onChange={(e) => {
            updateNodeData(id, { output: e.target.value } as Partial<BaseNodeData>);
          }}
          spellCheck={false}
        />
      ) : (
        <div className="fullscreen-md-view">
          {(data.output as string) ? (
            <div
              className="markdown-rendered"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <div className="node-preview-placeholder" style={{ textAlign: 'center', padding: 40 }}>
              暂无内容
            </div>
          )}
        </div>
      )}
    </FullscreenOverlay>
    </>
  );
}

export default memo(MarkdownNode);
