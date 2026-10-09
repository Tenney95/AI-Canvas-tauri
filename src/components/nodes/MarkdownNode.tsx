/**
 * MarkdownNode 源节点 — 支持 .md 文件的编辑、预览与自动本地保存
 */
import { memo, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import GooeyBtn from './shared/GooeyBtn';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import { useAppStore } from '../../store/useAppStore';
import { saveBinaryToProjectData, readAssetTextFile, saveAssetTextFile, isFileMissing, type AssetTextSnapshot } from '../../services/fileService';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../../services/canvasDerivationGuard';
import MarkdownEditor from '../shared/MarkdownEditor';
import AnimatedButton from '../shared/AnimatedButton';
import { renderMarkdown } from '../../utils/renderMarkdown';
import { textNodeHeight } from '../../utils/num';
import ResizeHandle from './shared/ResizeHandle';
import { useT } from '../../i18n';

function MarkdownNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const t = useT();
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const showToast = useAppStore((s) => s.showToast);

  // ── Edit / Preview toggle ──
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>(() => (
    data.output ? 'preview' : 'edit'
  ));

  // ── Fullscreen ──
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [saveStatus, setSaveStatus] = useState('编辑后自动保存');
  const contentEditActiveRef = useRef(false);

  const finishContentEdit = useCallback(() => {
    if (!contentEditActiveRef.current) return;
    commitToHistory();
    contentEditActiveRef.current = false;
  }, [commitToHistory]);

  const handleOpenFullscreen = useCallback(() => {
    setIsFullscreen(true);
  }, []);

  const handleCloseFullscreen = useCallback(() => {
    finishContentEdit();
    setIsFullscreen(false);
  }, [finishContentEdit]);

  // ── Copy content ──
  const [copied, setCopied] = useState(false);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const content = (data.output as string) || '';
    if (!content) {
      showToast(t('暂无文本可复制'), 'error');
      return;
    }

    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      showToast(t('文本已复制'));
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
      copyResetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast(t('复制失败，请手动复制'), 'error');
    }
  }, [data.output, showToast, t]);

  // ── Upload ──
  const { isUploading, handleUpload } = useSourceFileUpload('.md');

  // ── 固定文件名（仅首次生成，之后始终覆写到同一文件）──
  const savedFileNameRef = useRef<string>((data.fileName as string) || `markdown-${id}.md`);

  const savedFilePathRef = useRef<string>((data.filePath as string) || '');
  const baselineRef = useRef<{ path: string; snapshot: AssetTextSnapshot } | null>(null);
  const baselineLoadRef = useRef<{ path: string; promise: Promise<AssetTextSnapshot> } | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeRef = useRef(true);
  useEffect(() => {
    const path = (data.filePath as string) || '';
    if (!path && !savedFilePathRef.current && data.fileName) savedFileNameRef.current = data.fileName;
    if (path && path !== savedFilePathRef.current) {
      savedFilePathRef.current = path;
      savedFileNameRef.current = (data.fileName as string) || `markdown-${id}.md`;
      baselineRef.current = null;
    }
    if (!path || baselineRef.current?.path === path || baselineLoadRef.current?.path === path) return;
    // 旧节点正文可能比磁盘更新；以打开时的真实磁盘摘要检测外部修改，
    // 不能把节点正文当成磁盘原文，也不能在失焦或撤销时用草稿替换基线。
    const load = { path, promise: readAssetTextFile(path) };
    baselineLoadRef.current = load;
    void load.promise.then((snapshot) => {
      if (activeRef.current && baselineLoadRef.current === load && savedFilePathRef.current === path) {
        baselineRef.current = { path, snapshot };
      }
    }, () => { /* 保存时沿用这个失败结果，展示具体错误，不静默重建或覆盖文件。 */ });
  }, [data.filePath, data.fileName, id]);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const doSave = useCallback((content: string): Promise<void> => {
    const task = async () => {
      const state = useAppStore.getState();
      const node = state.nodes.find((entry) => entry.id === id);
      if (!activeRef.current || state.currentProjectId !== currentProjectId || node?.data.output !== content) return;
      const controller = new AbortController();
      const guard = registerCanvasDerivation(state, id, { onCancel: () => controller.abort() });
      if (!guard) return;
      setSaveStatus('正在自动保存…');
      let saveStep = '读取原文件';
      try {
        let path = savedFilePathRef.current;
        const recoveredMissingFile = !!path && await isFileMissing(path);
        if (recoveredMissingFile) {
          // 仅确认不存在时另建项目文件；权限失败与内容冲突不绕过原文件保护。
          savedFileNameRef.current = path.split(/[/\\]/).pop() || savedFileNameRef.current;
          path = '';
        }
        if (path) {
          let baseline = baselineRef.current?.path === path ? baselineRef.current.snapshot : null;
          if (!baseline) {
            baseline = baselineLoadRef.current?.path === path
              ? await baselineLoadRef.current.promise.catch(() => readAssetTextFile(path, controller.signal))
              : await readAssetTextFile(path, controller.signal);
          }
          if (!isCanvasDerivationFresh(guard, useAppStore.getState())) return;
          saveStep = '保存文件';
          const saved = await saveAssetTextFile(path, baseline, content, controller.signal);
          baselineRef.current = { path, snapshot: saved };
        } else {
          if (!currentProjectId || !isCanvasDerivationFresh(guard, useAppStore.getState())) return;
          saveStep = '创建项目文件';
          const result = await saveBinaryToProjectData(new TextEncoder().encode(content), currentProjectId, savedFileNameRef.current, { throwOnError: true });
          if (!result) throw new Error('当前环境无法保存本地文件');
          path = result.filePath;
          // 运行时记住首次创建的文件，即使后续输入令本轮画布 revision 过期也不创建副本。
          savedFilePathRef.current = path;
          saveStep = '读取新文件确认';
          const saved = await readAssetTextFile(path);
          baselineRef.current = { path, snapshot: saved };
        }
        const current = useAppStore.getState();
        if (isCanvasDerivationFresh(guard, current)) {
          const name = path.split(/[/\\]/).pop() || savedFileNameRef.current;
          savedFileNameRef.current = name;
          current.updateNodeDataTransient(id, { fileName: name, filePath: path, status: 'success',
            ...(recoveredMissingFile ? { assetId: undefined } : {}) });
        }
        if (activeRef.current) setSaveStatus(recoveredMissingFile ? '原文件不存在，已恢复保存到项目目录' : '已自动保存');
      } catch (reason) {
        // Tauri IPC 通常拒绝为字符串，不能只识别 Error，否则真实文件错误会被吞掉。
        const detail = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason.trim() : '';
        if (activeRef.current) setSaveStatus(controller.signal.aborted
          ? '自动保存已中止，节点内容已保留'
          : `${saveStep}失败，节点内容已保留${detail ? `：${detail}` : ''}`);
      } finally { completeCanvasDerivation(guard); }
    };
    const queued = saveQueueRef.current.catch(() => {}).then(task);
    saveQueueRef.current = queued;
    return queued;
  }, [currentProjectId, id]);

  const onUpload = useCallback(async () => {
    const result = await handleUpload();
    if (!result) return;

    let textContent: string;
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
    const estimatedHeight = textNodeHeight(lineCount, 160);

    // 使用上传文件的文件名
    savedFileNameRef.current = result.fileName;
    savedFilePathRef.current = '';
    baselineRef.current = null;
    baselineLoadRef.current = null;

    updateNodeData(id, {
      output: textContent,
      fileName: result.fileName,
      filePath: undefined,
      label: result.fileName,
      status: 'success',
      nodeHeight: estimatedHeight,
    } as Partial<BaseNodeData>);

    // 立即保存到本地
    doSave(textContent);
  }, [id, handleUpload, updateNodeData, doSave]);

  // ── Auto-save debounce ──
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
  }, []);

  // ── Resize（四角 + 四边，Shift 锁比例；逻辑统一在 ResizeHandle 内）──
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 200;

  const handleResize = useCallback(
    (newWidth: number, newHeight: number) => {
      updateNodeDataTransient(id, {
        nodeWidth: newWidth,
        nodeHeight: newHeight,
      } as Partial<BaseNodeData>);
    },
    [id, updateNodeDataTransient],
  );

  // ── Content change (edit mode) with debounced auto-save ──
  const handleContentChange = useCallback(
    (value: string) => {
      setSaveStatus('未保存 · 即将自动保存');
      if (!contentEditActiveRef.current) {
        commitToHistory();
        contentEditActiveRef.current = true;
      }
      updateNodeDataTransient(id, { output: value } as Partial<BaseNodeData>);

      // debounce auto-save: 1.5s after last keystroke
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => {
        autoSaveTimer.current = null;
        doSave(value);
      }, 1500);
    },
    [commitToHistory, doSave, id, updateNodeDataTransient],
  );

  // ── Markdown preview HTML ──（memo：编辑时每次按键都会重渲染，避免全文重复解析）
  const previewHtml = useMemo(() => renderMarkdown((data.output as string) || ''), [data.output]);

  const { displayLabel, handleRename } = useNodeRename(id, data, t('Markdown 文档'));
  const handleMarkdownRename = useCallback((newName: string) => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
      const node = useAppStore.getState().nodes.find((entry) => entry.id === id);
      if (node) void doSave((node.data.output as string) || '');
    }
    const rename = async () => {
      const state = useAppStore.getState();
      if (!activeRef.current || state.currentProjectId !== currentProjectId || !state.nodes.some((entry) => entry.id === id)) return;
      const previousPath = savedFilePathRef.current;
      await handleRename(newName);
      const current = useAppStore.getState();
      const node = current.nodes.find((entry) => entry.id === id);
      if (!activeRef.current || current.currentProjectId !== currentProjectId || !node) return;
      const path = (node.data.filePath as string) || '';
      savedFileNameRef.current = (node.data.fileName as string) || savedFileNameRef.current;
      if (path !== savedFilePathRef.current) {
        savedFilePathRef.current = path;
        baselineLoadRef.current = null;
        baselineRef.current = baselineRef.current?.path === previousPath
          ? { path, snapshot: baselineRef.current.snapshot } : null;
      }
    };
    const queued = saveQueueRef.current.catch(() => {}).then(rename);
    saveQueueRef.current = queued;
    void queued;
  }, [currentProjectId, doSave, handleRename, id]);

  return (
    <>
    <div className="node-wrapper relative" style={{ width: nodeWidth }}>
      <NodeLabel
        kind="ai-markdown"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        nodeId={id}
        onRename={handleMarkdownRename}
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
              data-tooltip={t('上传 .md 文件')}
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
              onClick={handleCopy}
              data-tooltip={copied ? t('已复制') : t('复制文本')}
              aria-label={copied ? t('已复制') : t('复制文本')}
            >
              {copied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </AnimatedButton>
            <AnimatedButton
              type="button"
              className="markdown-mode-btn"
              onClick={(e) => { e.stopPropagation(); handleOpenFullscreen(); }}
              data-tooltip={t('全屏显示')}
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
              className="nodrag nowheel markdown-edit-area text-selection-source"
              value={(data.output as string) || ''}
              onChange={(event) => handleContentChange(event.target.value)}
              onBlur={finishContentEdit}
              placeholder={t('# Markdown 文档&#10;&#10;点击上方按钮上传 .md 文件，或直接在此编辑…')}
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
                  {t('暂无内容 — 切换到编辑模式开始写作')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Status bar */}
        <span className="text-node-wordcount">
          {((data.output as string) || '').length.toLocaleString()} {t('字')}
        </span>

        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-text">
          <GooeyBtn className="gooey-btn-left" hue={270} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-text">
          <GooeyBtn className="gooey-btn-right" hue={270} />
        </Handle>
      </div>

      <ResizeHandle
        nodeId={id}
        currentWidth={nodeWidth}
        currentHeight={nodeHeight}
        minWidth={240}
        minHeight={140}
        onResizeStart={commitToHistory}
        onResizeEnd={commitToHistory}
        onResize={handleResize}
      />
    </div>

    {/* Fullscreen overlay */}
    <FullscreenOverlay
      isOpen={isFullscreen}
      onClose={handleCloseFullscreen}
      title={(data.label as string) || t('Markdown 文档')}
      panelWidth="min(96vw, 1400px)"
      bodyClassName="min-h-0"
      unmountOnClose
    >
      <div className="flex h-[78vh] min-h-0 flex-col">
        <MarkdownEditor value={(data.output as string) || ''} onChange={handleContentChange} onBlur={finishContentEdit}
          initialMode="split" status={saveStatus} onSave={() => {
            if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
            autoSaveTimer.current = null;
            void doSave((data.output as string) || '');
          }} />
      </div>
    </FullscreenOverlay>
    </>
  );
}

export default memo(MarkdownNode);
