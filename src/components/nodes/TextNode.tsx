/**
 * TextNode 文本节点 — 在画布上渲染文本内容，支持编辑、复制、清除空行、全屏、拖拽调整大小
 */
import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import TextNodeToolbar from './shared/TextNodeToolbar';
import NodeToolbarShell from './shared/NodeToolbarShell';
import GooeyBtn from './shared/GooeyBtn';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import { useNodeRename } from './shared/useNodeRename';
import { useAppStore } from '../../store/useAppStore';
import { uploadSourceFile } from '../../services/fileService';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';
import { textNodeHeight } from '../../utils/num';
import ResizeHandle from './shared/ResizeHandle';
import { useT } from '../../i18n';

function AITextNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const t = useT();
  const justCompleted = useCompletionFlash(data.status);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const openNodeDialog = useAppStore((s) => s.openNodeDialog);
  const isSingleSelection = useAppStore((s) => s.selectedNodeIds.length <= 1);
  const isSource = data.role === 'source';
  const [isUploading, setIsUploading] = useState(false);

  // ── Fullscreen ──
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fullscreenEditActiveRef = useRef(false);

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
      commitToHistory();
      updateNodeDataTransient(id, { output: draftOutput });
      commitToHistory();
    }
    requestAnimationFrame(() => {
      editEndingRef.current = false;
    });
  }, [commitToHistory, data.output, draftOutput, id, updateNodeDataTransient]);

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

  // ── Resize（四角 + 四边，Shift 锁比例；逻辑统一在 ResizeHandle 内）──
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 160;

  const handleResize = useCallback(
    (newWidth: number, newHeight: number) => {
      updateNodeDataTransient(id, { nodeWidth: newWidth, nodeHeight: newHeight } as Partial<BaseNodeData>);
    },
    [id, updateNodeDataTransient],
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

  const finishFullscreenEdit = useCallback(() => {
    if (!fullscreenEditActiveRef.current) return;
    commitToHistory();
    fullscreenEditActiveRef.current = false;
  }, [commitToHistory]);

  const handleCloseFullscreen = useCallback(() => {
    finishFullscreenEdit();
    setIsFullscreen(false);
  }, [finishFullscreenEdit]);

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
      if (!fullscreenEditActiveRef.current) {
        commitToHistory();
        fullscreenEditActiveRef.current = true;
      }
      updateNodeDataTransient(id, { output: e.target.value });
    },
    [commitToHistory, id, updateNodeDataTransient],
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

  const { displayLabel, handleRename } = useNodeRename(id, data, t('粘贴文本'));

  // 节点内编辑时隐藏连接手柄：保留布局/位置（不脱锚），仅去掉显示与交互
  const handleHideStyle: React.CSSProperties | undefined = isEditing
    ? { opacity: 0, pointerEvents: 'none' }
    : undefined;

  // ── Render ──
  return (
    <>
    <div className="node-wrapper relative" style={{ width: nodeWidth }}>
      <NodeToolbarShell visible={selected && isSingleSelection}>
        <TextNodeToolbar
          nodeId={id}
          data={data}
          onCopy={handleCopyToClipboardFn}
          onClearEmptyLines={handleClearEmptyLines}
          onShowPrompt={handleShowPrompt}
          onFullscreen={handleOpenFullscreen}
        />
      </NodeToolbarShell>
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
              data-tooltip={t('上传文本文件')}
              aria-label={t('上传文本文件')}
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
              placeholder={isSource ? t('输入或粘贴文本内容…') : t('输入文本内容…')}
              aria-label={t('编辑文本节点内容')}
              spellCheck={false}
            />
          ) : data.output ? (
            <div
              className="text-output-content compact nowheel"
              onDoubleClick={enterInlineEdit}
              title={t('双击编辑')}
            >
              {data.output}
            </div>
          ) : isUploading ? (
            <div className="node-preview-loading">
              <div className="spinner" />
              <span>{t('上传中...')}</span>
            </div>
          ) : data.status === 'loading' ? (
            <div className="node-preview-loading">
              <div className="spinner" />
              <span>{t('生成中...')}</span>
            </div>
          ) : (
            <div
              className="node-preview-placeholder text-node-empty-editable"
              data-inline-edit-trigger="true"
              onDoubleClick={enterInlineEdit}
              title={t('双击编辑')}
            >
              <span>{isSource ? t('上传文本文件或粘贴内容') : t('输入提示词开始创作')}</span>
              <span className="text-node-edit-hint">{t('双击编辑内容')}</span>
            </div>
          )}
        </div>
        {(isEditing || data.output) && (
          <span className="text-node-wordcount">
            {(isEditing ? draftOutput.length : ((data.output as string) || '').length).toLocaleString()} {t('字')}
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

      {/* Resize handles — outside .node to avoid overflow:hidden + border-radius clipping */}
      {!isEditing && (
        <ResizeHandle
          nodeId={id}
          currentWidth={nodeWidth}
          currentHeight={nodeHeight}
          minWidth={200}
          minHeight={120}
          onResizeStart={commitToHistory}
          onResizeEnd={commitToHistory}
          onResize={handleResize}
        />
      )}
    </div>

    {/* Fullscreen overlay */}
      <FullscreenOverlay
        isOpen={isFullscreen}
      onClose={handleCloseFullscreen}
      title={(data.label as string) || t('文本内容')}
      >
      <textarea
        ref={fullscreenTextareaRef}
        className="fullscreen-textarea"
        value={(data.output as string) || ''}
        onChange={handleFullscreenChange}
        onBlur={finishFullscreenEdit}
        spellCheck={false}
      />
      </FullscreenOverlay>
    </>
  );
}

export default memo(AITextNode);
