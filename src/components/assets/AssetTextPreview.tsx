/**
 * AssetTextPreview — 提供文本资产预览界面与交互。
 */
import { getLocale, t, useT } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { invoke } from '@tauri-apps/api/core';
import { getProjectDataDir, getRelativeAssetPath, isTauriEnv, readAssetTextFile, saveAssetTextFile, type AssetTextSnapshot, type AssetFileEntry } from '../../services/fileService';
import { getNodeHistoryEntries, getProjectById, imageHistoryReferenceKey } from '../../services/indexedDbService';
import { readNativeProjectSelection } from '../../services/indexedDb/nativeProjectRepository';
import type { NativeProjectViewItem } from '../../store/nativeProjectView';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../../services/canvasDerivationGuard';
import { useAppStore } from '../../store/useAppStore';
import { formatSize } from '../../utils/assetFormat';
import { copyText } from '../../services/clipboardService';
import MarkdownEditor from '../shared/MarkdownEditor';
import ModalOverlay from '../shared/ModalOverlay';

/** 与媒体预览共用大屏布局；磁盘读写、草稿与生成信息由宿主管理。 */
export default function AssetTextPreview({ file: sourceFile, projectId, onClose, onSaved, onRenamed }: {
  file: AssetFileEntry; projectId?: string; onClose: () => void; onSaved?: (file: AssetFileEntry) => void;
  onRenamed?: (previous: AssetFileEntry, next: AssetFileEntry) => void;
}) {
  useT();
  const [renamedFile, setRenamedFile] = useState<{ originalPath: string; file: AssetFileEntry } | null>(null);
  const file = renamedFile?.originalPath === sourceFile.path ? renamedFile.file : sourceFile;
  const renameAction = useAppStore((state) => state.renameAssetFile);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameMessage, setRenameMessage] = useState('');
  const renameInFlight = useRef(false);
  const [snapshot, setSnapshot] = useState<AssetTextSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [confirm, setConfirm] = useState<'close' | 'reload' | null>(null);
  const [prompt, setPrompt] = useState<{ text: string; source: string } | null>(null);
  const [promptError, setPromptError] = useState(false);
  const [reload, setReload] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const saveInFlight = useRef(false);
  const mounted = useRef(true);
  const dirty = !!snapshot && draft !== snapshot.content;
  const markdown = /\.(md|markdown)$/i.test(file.name);
  const fileKey = imageHistoryReferenceKey(file.path);
  const extension = file.name.lastIndexOf('.') > 0 ? file.name.slice(file.name.lastIndexOf('.')) : '';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.abort(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    void readAssetTextFile(file.path, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setSnapshot(result); setDraft(result.content); setLoading(false); setError(''); setStatus('');
    }, (reason: unknown) => {
      if (controller.signal.aborted) return;
      setLoading(false); setError(reason instanceof Error ? reason.message : '文本文件读取失败');
    });
    return () => controller.abort();
  }, [file.path, reload]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (!projectId || !fileKey) return null;
      const state = useAppStore.getState();
      const project = state.projects?.find((item) => item.id === projectId);
      const binding = (project as NativeProjectViewItem | undefined)?.nativeView;
      const assertScope = () => {
        const latest = useAppStore.getState();
        if (latest.currentProjectId !== state.currentProjectId || state.currentProjectId === projectId && latest.nodes !== state.nodes
          || binding && (latest.projects?.find((item) => item.id === projectId) as NativeProjectViewItem | undefined)?.nativeView !== binding) {
          throw new Error('项目已变化，请重新打开');
        }
      };
      let relativeFile: string | null = null;
      let projectNodes: unknown;
      if (state.currentProjectId === projectId) projectNodes = state.nodes;
      else if (binding) {
        if (!binding.canvasId) return null;
        const selection = await readNativeProjectSelection(binding.projectId, binding.canvasId, { signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!selection || selection.context.episodeId !== binding.episodeId || selection.context.canvasId !== projectId
          || selection.project.epoch !== (project?.parentId
            ? state.projects.find((item) => item.id === project.parentId)?.exchangeEpoch : project?.exchangeEpoch)) throw new Error('项目已变化，请重新打开');
        const root = selection.canvas?.storageRootRef !== selection.project.storageRootRef
          ? await invoke<string>('resolve_native_project_media_subroot', { projectId: binding.projectId, rootRef: selection.canvas?.storageRootRef, create: false })
          : await getProjectDataDir(projectId);
        controller.signal.throwIfAborted();
        if (!root) throw new Error('项目素材目录不可用');
        relativeFile = getRelativeAssetPath(file.path, root) ?? null;
        assertScope();
        if (!relativeFile) return null;
        projectNodes = selection.canvas?.nodes;
      } else projectNodes = (await getProjectById(projectId))?.nodes;
      controller.signal.throwIfAborted();
      assertScope();
      const nodes: unknown[] = Array.isArray(projectNodes) ? projectNodes : [];
      const matches = nodes.filter((node): node is { id: string; data: Record<string, unknown> } => {
        if (!node || typeof node !== 'object' || !('id' in node) || typeof node.id !== 'string'
          || !('data' in node) || !node.data || typeof node.data !== 'object') return false;
        const path = (node.data as Record<string, unknown>).filePath;
        const relative = (node.data as Record<string, unknown>).relativePath;
        return typeof path === 'string' && imageHistoryReferenceKey(path) === fileKey
          || relativeFile !== null && typeof relative === 'string' && imageHistoryReferenceKey(relative) === imageHistoryReferenceKey(relativeFile);
      });
      if (matches.length !== 1) return null;
      const node = matches[0];
      const records = await getNodeHistoryEntries(projectId, node.id);
      controller.signal.throwIfAborted();
      assertScope();
      const record = records.filter((entry) => entry.status === 'success' && imageHistoryReferenceKey(entry.filePath) === fileKey)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      if (record?.prompt?.trim()) return { text: record.prompt, source: '生成记录' };
      return typeof node.data.prompt === 'string' && node.data.prompt.trim() ? { text: node.data.prompt, source: '当前节点提示词' } : null;
    };
    void load().then((result) => { if (!controller.signal.aborted) { setPrompt(result); setPromptError(false); } }, () => {
      if (!controller.signal.aborted) setPromptError(true);
    });
    return () => controller.abort();
  }, [file.path, fileKey, projectId, reload]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const requestClose = () => {
    if (saveInFlight.current || renameInFlight.current) return;
    if (renameDraft !== null) { setRenameDraft(null); setRenameMessage(''); return; }
    if (confirm) { setConfirm(null); return; }
    if (dirty) setConfirm('close'); else onClose();
  };
  const reloadFile = () => { setLoading(true); setError(''); setConfirm(null); setReload((value) => value + 1); };
  const save = async () => {
    if (!snapshot || !dirty || loading || saveInFlight.current || renameInFlight.current || renameDraft !== null) return;
    const controller = new AbortController();
    operation.current = controller;
    const state = useAppStore.getState();
    const targets = projectId && state.currentProjectId === projectId ? state.nodes.filter((node) =>
      ['ai-markdown', 'ai-text'].includes(node.data.type) && imageHistoryReferenceKey(node.data.filePath as string | undefined) === fileKey) : [];
    if (targets.some((node) => String(node.data.output ?? '').replace(/\r\n/g, '\n') !== snapshot.content)) {
      setError('画布节点已有不同内容，请先保存或同步节点，再保存文件；当前草稿已保留'); return;
    }
    const guards = targets.map((node) => registerCanvasDerivation(state, node.id, { onCancel: () => controller.abort() }));
    saveInFlight.current = true; setSaving(true); setError('');
    try {
      const saved = await saveAssetTextFile(file.path, snapshot, draft, controller.signal);
      if (!mounted.current) return;
      const current = useAppStore.getState();
      const fresh = guards.every((guard) => guard && isCanvasDerivationFresh(guard, current));
      if (targets.length && fresh) {
        current.commitToHistory();
        targets.forEach((node) => current.updateNodeDataTransient(node.id, { output: saved.content }));
        current.commitToHistory();
      }
      setSnapshot(saved); setDraft(saved.content);
      setStatus(targets.length && !fresh ? '已保存磁盘；画布已变化，未覆盖节点内容' : '已保存');
      onSaved?.({ ...file, size: saved.size,
        modifiedAt: typeof saved.modified === 'number' && Number.isFinite(saved.modified) ? saved.modified : undefined });
    } catch (reason) {
      if (mounted.current) setError(controller.signal.aborted ? '保存已中止，草稿已保留' : reason instanceof Error ? reason.message : '保存失败，草稿已保留');
    } finally {
      guards.forEach((guard) => { if (guard) completeCanvasDerivation(guard); });
      saveInFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const saveFileName = async () => {
    if (renameDraft === null || dirty || loading || !snapshot || saveInFlight.current || renameInFlight.current) return;
    renameInFlight.current = true;
    setRenameBusy(true); setRenameMessage('');
    try {
      const result = await renameAction(file, renameDraft, projectId);
      if (!mounted.current) return;
      if (result.file.path !== file.path) setLoading(true);
      setRenamedFile({ originalPath: sourceFile.path, file: result.file });
      setRenameDraft(null); setRenameMessage(result.warning ?? '文件名已修改');
      onRenamed?.(file, result.file);
    } catch (reason) {
      if (mounted.current) setRenameMessage(reason instanceof Error ? reason.message : '修改文件名失败，请检查文件是否被占用或目录权限');
    } finally {
      renameInFlight.current = false;
      if (mounted.current) setRenameBusy(false);
    }
  };
  const info = [
    ['文件类型', markdown ? 'Markdown' : '文本'], ['文件大小', formatSize(snapshot?.size ?? file.size)],
    ['编码', snapshot ? `UTF-8${snapshot.bom ? ' · BOM' : ''}` : '待读取'],
    ['换行', snapshot?.newline ?? '待读取'], ['行数', snapshot ? draft.split('\n').length.toLocaleString(getLocale()) : '待读取'],
    ['来源', file.source === 'folder' ? '外部文件夹' : projectId ? '项目文件' : '全局资产'],
    ['修改时间', snapshot?.modified ? new Date(snapshot.modified).toLocaleString(getLocale()) : '未知'],
  ];
  return <ModalOverlay isOpen onClose={requestClose} ariaLabel={t("文本与文件信息")} className="asset-image-preview"
    zIndex={360} motionPreset="quick" backdropBlur={false} closeOnBackdrop={false}>
    <div data-tauri-drag-region className="asset-image-preview-layout">
      <div className="asset-image-preview-stage flex flex-col rounded-xl border border-canvas-border bg-canvas-bg">
        {loading ? <p role="status" className="p-3 text-sm text-canvas-text-secondary">{t("正在读取文档…")}</p> : snapshot ?
          <MarkdownEditor key={reload} value={draft} onChange={(value) => { if (!renameInFlight.current) { setDraft(value); setStatus(''); } }} markdown={markdown} initialMode={markdown ? 'split' : 'source'}
            label={file.name} onSave={() => { void save(); }} readOnly={saving || renameBusy || renameDraft !== null} status={saving ? t('正在保存…') : dirty ? t('未保存') : t(status || '已加载')} /> : null}
      </div>
      <aside className="asset-image-preview-info" aria-label={t("文本文件信息")}>
        <header className="flex shrink-0 items-center gap-2"><Icon icon={markdown ? 'lucide:file-code' : 'lucide:file-text'} className="h-5 w-5 text-canvas-text-secondary" aria-hidden="true" />
          <div className="min-w-0 flex-1">{renameDraft !== null ? <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); void saveFileName(); }}>
            <input autoFocus className="ui-input ui-input--sm min-w-0 flex-1" aria-label={t("新文件名")} value={renameDraft} disabled={renameBusy}
              onChange={(event) => setRenameDraft(event.target.value)} />
            <span className="shrink-0 text-xs text-canvas-text-muted">{extension}</span>
            <button type="submit" className="ui-icon-btn ui-icon-btn--sm" aria-label={t("保存文件名")} title={t("保存文件名")} disabled={renameBusy || !renameDraft.trim()}><Icon icon="lucide:check" aria-hidden="true" /></button>
            <button type="button" className="ui-icon-btn ui-icon-btn--sm" aria-label={t("取消修改文件名")} disabled={renameBusy} onClick={() => { setRenameDraft(null); setRenameMessage(''); }}><Icon icon="lucide:x" aria-hidden="true" /></button>
          </form> : <h1 className="break-words text-sm font-semibold text-canvas-text">{file.name}</h1>}
          {renameMessage && <p role="status" className="pt-1 text-xs text-canvas-text-secondary">{t(renameMessage)}</p>}</div>
          {renameDraft === null && <button type="button" className="ui-icon-btn ui-icon-btn--sm" aria-label={t("修改文件名")} title={dirty ? t('请先保存或重新载入文档，再修改文件名') : t('修改磁盘文件名')}
            disabled={!isTauriEnv() || loading || !snapshot || dirty || saving || renameBusy || file.availability === 'offline'}
            onClick={() => { setRenameMessage(''); setRenameDraft(extension ? file.name.slice(0, -extension.length) : file.name); }}><Icon icon="lucide:pencil" aria-hidden="true" /></button>}
          <button type="button" className="ui-close-btn" aria-label={t("关闭文档预览")} disabled={saving || renameBusy} onClick={requestClose}><Icon icon="lucide:x" /></button></header>
        <div className="asset-image-preview-info-content space-y-3">
          {error && <p role="alert" className="ui-card p-3 text-sm text-canvas-text-secondary">{t(error)}</p>}
          <section className="ui-card p-3 space-y-2"><div className="flex items-center justify-between gap-2"><h2 className="text-xs text-canvas-text-secondary">{t("提示词")}</h2>
            <button type="button" className="ui-btn ui-btn--sm" disabled={!prompt?.text} onClick={() => { if (prompt) void copyText(prompt.text).then((ok) => setStatus(ok ? '提示词已复制' : '复制失败')); }}>{t("复制提示词")}</button></div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-canvas-text">{promptError ? t('生成信息读取失败，可重新载入重试') : prompt?.text ?? '暂无生成信息'}</p>
            {prompt && <p className="text-xs text-canvas-text-muted">{t("来源：")}{t(prompt.source)}</p>}
            {!!file.tags?.length && <div className="flex flex-wrap gap-1" aria-label={t("标签")}>{file.tags.map((tag) => <span key={tag} className="assets-card-tag">{tag}</span>)}</div>}
          </section>
          <section className="ui-card p-3"><h2 className="pb-3 text-xs text-canvas-text-secondary">{t("参数与文件信息")}</h2>
            <dl className="space-y-3 text-sm">{info.map(([label, text]) => <div key={label} className="flex justify-between gap-3"><dt className="shrink-0 text-canvas-text-muted">{t(String(label))}</dt><dd className="min-w-0 break-words text-right text-canvas-text">{t(String(text))}</dd></div>)}</dl></section>
        </div>
        <footer className="asset-image-preview-footer space-y-2">
          <p className="text-xs text-canvas-text-muted">{t("Ctrl+S 保存至原文件 · Ctrl+F 查找替换 · Esc 关闭")}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="ui-btn ui-btn--sm" disabled={loading || saving || renameBusy || renameDraft !== null} onClick={() => dirty ? setConfirm('reload') : reloadFile()}>{t("重新载入")}</button>
            <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={!dirty || saving || loading || renameBusy || renameDraft !== null} onClick={() => { void save(); }}>{saving ? t('正在保存…') : t('保存文件')}</button>
          </div>
          {confirm && <div className="ui-card p-3 space-y-2" role="alert"><p className="text-sm text-canvas-text">{confirm === 'close' ? t('文档尚未保存，是否放弃修改并关闭？') : t('重新载入会放弃当前草稿，是否继续？')}</p>
            <div className="flex justify-end gap-2"><button type="button" className="ui-btn ui-btn--sm" onClick={() => setConfirm(null)}>{t("继续编辑")}</button>
              <button type="button" className="ui-btn ui-btn--sm" onClick={() => confirm === 'close' ? onClose() : reloadFile()}>{confirm === 'close' ? t('放弃修改并关闭') : t('放弃修改并载入')}</button></div></div>}
        </footer>
      </aside>
    </div>
  </ModalOverlay>;
}
