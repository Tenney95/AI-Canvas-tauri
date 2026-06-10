/**
 * MarkdownNode 源节点 — 支持 .md 文件的编辑、预览与本地保存
 */
import { memo, useState, useCallback, useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import GooeyBtn from './shared/GooeyBtn';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import { useAppStore } from '../../store/useAppStore';
import { saveBinaryToProjectData } from '../../services/fileService';
import AnimatedButton from '../shared/AnimatedButton';

function MarkdownNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const showToast = useAppStore((s) => s.showToast);

  // ── Edit / Preview toggle ──
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit');

  // ── Upload ──
  const { isUploading, handleUpload } = useSourceFileUpload('.md');

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

    updateNodeData(id, {
      output: textContent,
      fileName: result.fileName,
      label: result.fileName,
      status: 'success',
      nodeHeight: estimatedHeight,
    } as Partial<BaseNodeData>);
  }, [id, handleUpload, updateNodeData]);

  // ── Save to local file ──
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!data.output) return;
    const textContent = data.output as string;
    const fileName = (data.fileName as string) || `markdown-${Date.now()}.md`;

    setIsSaving(true);
    try {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(textContent);
      const result = await saveBinaryToProjectData(bytes, currentProjectId, fileName);
      if (result) {
        updateNodeData(id, {
          fileName: result.filePath.split(/[/\\]/).pop() || fileName,
          filePath: result.filePath,
        } as Partial<BaseNodeData>);
        showToast('已保存到项目目录', 'success');
      } else {
        showToast('保存失败（非 Tauri 环境）', 'error');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败';
      showToast(msg, 'error');
    } finally {
      setIsSaving(false);
    }
  }, [data.output, data.fileName, currentProjectId, id, updateNodeData, showToast]);

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

  // ── Content change ──
  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateNodeData(id, { output: e.target.value } as Partial<BaseNodeData>);
    },
    [id, updateNodeData],
  );

  const { displayLabel, handleRename } = useNodeRename(id, data, 'Markdown 文档');

  return (
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
              disabled={isUploading || isSaving}
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
              disabled={!data.output || isSaving}
              onClick={(e) => { e.stopPropagation(); handleSave(); }}
              title="保存到本地文件"
            >
              {isSaving ? (
                <div className="spinner-sm" />
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
              )}
            </AnimatedButton>
          </div>
        </div>

        {/* Content area */}
        <div className="markdown-node-content">
          {viewMode === 'edit' ? (
            <textarea
              className="markdown-edit-area"
              value={(data.output as string) || ''}
              onChange={handleContentChange}
              placeholder="# Markdown 文档&#10;&#10;点击上方按钮上传 .md 文件，或直接在此编辑…"
              spellCheck={false}
            />
          ) : (
            <div className="markdown-preview-area">
              {(data.output as string) ? (
                <pre className="markdown-preview-text">{data.output as string}</pre>
              ) : (
                <div className="node-preview-placeholder">
                  暂无内容 — 切换到编辑模式开始写作
                </div>
              )}
            </div>
          )}
        </div>

        {/* Status bar */}
        {data.fileName && (
          <div className="markdown-node-statusbar">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <polyline points="13 2 13 9 20 9" />
            </svg>
            <span>{data.fileName as string}</span>
            <span style={{ marginLeft: 'auto', opacity: 0.6 }}>
              {((data.output as string) || '').length.toLocaleString()} 字
            </span>
          </div>
        )}

        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-text">
          <GooeyBtn className="gooey-btn-left" hue={270} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-text">
          <GooeyBtn className="gooey-btn-right" hue={270} />
        </Handle>
      </div>

      <div className="node-resize-handle" onPointerDownCapture={handleResizeStart} />
    </div>
  );
}

export default memo(MarkdownNode);
