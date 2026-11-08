/**
 * AssetImagePreview — 提供图片资产预览与详情界面与交互。
 */
import { t, useT } from '../../i18n';
import ViewportImage from '../shared/ViewportImage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { AssetFileEntry } from '../../services/fileService';
import { isTauriEnv } from '../../services/fileService';
import type { HistoryRecord } from '../../services/indexedDbService';
import { getAllAssetMeta, getAssetMetaById, putAssetMeta, deleteAssetMeta } from '../../services/indexedDbService';
import { describeAssetImageHistory, loadAssetImageDetails, resolvePromptImageReferences } from '../../services/assetImageDetails';
import { useAppStore } from '../../store/useAppStore';
import type { AssetImageLoadedDetails, AssetImageReferenceView, AssetImageTagReplacement } from '../../types/assetImage';
import { MAX_ASSET_IMAGE_PROMPT, MAX_ASSET_IMAGE_REFERENCES, pickAssetImageReferences, previewPendingAssetImageReferences, resolveAssetImageReferences } from '../../services/fs/assetImageMetadata';
import { copyText } from '../../services/clipboardService';
import { formatSize } from '../../utils/assetFormat';
import ModalOverlay from '../shared/ModalOverlay';
import ZoomableImage from '../shared/ZoomableImage';
import { getNodeMetaMap } from '../nodes/shared/mentionEditorDom';
import { renderPromptWithChips } from '../nodes/shared/PromptChipViewer';
import { listGlobalDramaAssets } from '../../services/dramaAssetPrompt';
import { useShallow } from 'zustand/react/shallow';
import ModelSelector from '../nodes/shared/ModelSelector';
import { resolveVisionTextModel, reversePromptAndTags } from '../../services/ai/reversePrompt';

/** 资产库专用图片预览。列表与画布保留原状态，历史信息按图片身份只读加载。 */
export default function AssetImagePreview({ files: sourceFiles, initialPath, projectId: fallbackProjectId, projectIdForFile, onTagsSaved, onRenamed, onClose }: {
  files: AssetFileEntry[];
  initialPath: string;
  projectId?: string;
  projectIdForFile?: (file: AssetFileEntry) => string | undefined;
  onTagsSaved?: (file: AssetFileEntry, tags: string[]) => void;
  onRenamed?: (previous: AssetFileEntry, next: AssetFileEntry) => void;
  onClose: () => void;
}) {
  useT();
  const [activePath, setActivePath] = useState(initialPath);
  const [renamedFiles, setRenamedFiles] = useState<Record<string, AssetFileEntry>>({});
  const files = useMemo(() => sourceFiles.map((entry) => renamedFiles[entry.path] ?? entry), [sourceFiles, renamedFiles]);
  const [renameDraft, setRenameDraft] = useState<{ path: string; value: string } | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameMessage, setRenameMessage] = useState('');
  const renameBusyRef = useRef(false);
  const [retry, setRetry] = useState(0);
  const [imageRetry, setImageRetry] = useState(0);
  const [failedImage, setFailedImage] = useState('');
  const [dimensions, setDimensions] = useState<{ key: string; width: number; height: number } | null>(null);
  const [metadata, setMetadata] = useState<{ key: string; history: HistoryRecord | null; saved: AssetImageLoadedDetails | null; error: boolean } | null>(null);
  const [copyStatus, setCopyStatus] = useState<{ key: string; message: string } | null>(null);
  const saveAction = useAppStore((state) => state.saveAssetImageDetails);
  const renameAction = useAppStore((state) => state.renameAssetFile);
  const nodes = useAppStore((state) => state.nodes ?? []);
  const dramaAssets = useAppStore((state) => state.dramaAssets);
  const globalAssets = useAppStore(useShallow((state) => listGlobalDramaAssets(state)));
  const loadGlobalAssets = useAppStore((state) => state.loadGlobalDramaAssets);
  const nodeMetaMap = useMemo(() => getNodeMetaMap(nodes), [nodes]);
  const [promptReferences, setPromptReferences] = useState<AssetImageReferenceView[]>([]);
  const [draft, setDraft] = useState<{ key: string; prompt: string; tags: string[]; tagInput: string; references: AssetImageReferenceView[]; pending: Array<{ path: string; name: string; url: string }> } | null>(null);
  const [savedTags, setSavedTags] = useState<{ key: string; tags: string[] } | null>(null);
  const [operation, setOperation] = useState<{ key: string; message: string; busy: boolean } | null>(null);
  const [referenceState, setReferencePreview] = useState<{ key: string; url: string; name: string } | null>(null);
  const [leaveRequest, setLeaveRequest] = useState<{ direction?: -1 | 1 } | null>(null);
  const [reversePanelKey, setReversePanelKey] = useState<string | null>(null);
  const [reverseModel, setReverseModel] = useState(() => resolveVisionTextModel());
  const [reverseRunningKey, setReverseRunningKey] = useState<string | null>(null);
  const reverseControllerRef = useRef<AbortController | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const activeKeyRef = useRef('');
  const draftRef = useRef(false);
  const leavePanelRef = useRef<HTMLDivElement | null>(null);
  const promptHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const infoContentRef = useRef<HTMLDivElement | null>(null);
  const index = files.findIndex((file) => file.path === activePath);
  const file = files[index];
  const projectId = file ? projectIdForFile?.(file) ?? fallbackProjectId : fallbackProjectId;
  const queryKey = JSON.stringify([file?.path, file?.assetUrl, projectId, retry]);
  const referencePreview = referenceState?.key === queryKey ? referenceState : null;
  const imageKey = JSON.stringify([file?.path, file?.assetUrl, imageRetry]);
  const history = metadata?.key === queryKey ? metadata.history : null;
  const saved = metadata?.key === queryKey ? metadata.saved : null;
  const editing = draft?.key === queryKey;
  const tags = editing ? draft.tags : savedTags?.key === queryKey ? savedTags.tags : file?.tags ?? [];
  const reversePanelOpen = reversePanelKey === queryKey;
  const reversing = reverseRunningKey === queryKey;
  const busy = reversing || operation?.key === queryKey && operation.busy;
  const prompt = saved?.record?.prompt ?? history?.prompt ?? '';
  useEffect(() => {
    if (prompt.includes('@drama{global/')) void loadGlobalAssets().catch(() => {});
  }, [prompt, loadGlobalAssets]);
  const referenceViews = useMemo(() => {
    if (editing) return draft?.references ?? [];
    const savedRefs = saved?.references ?? [];
    if (savedRefs.length === 0) return promptReferences;
    const seenUrls = new Set(savedRefs.map((r) => r.url).filter(Boolean));
    const merged = [...savedRefs];
    for (const ref of promptReferences) {
      if (ref.url && !seenUrls.has(ref.url)) {
        seenUrls.add(ref.url);
        merged.push(ref);
      }
    }
    return merged;
  }, [editing, draft?.references, saved?.references, promptReferences]);
  const canEdit = !!saved?.identity && metadata?.key === queryKey && !metadata.error;

  const loading = metadata?.key !== queryKey;
  const metadataError = metadata?.key === queryKey && metadata.error;
  const details = history ? describeAssetImageHistory(history) : [];
  const close = useCallback(() => {
    if (renameBusyRef.current) return;
    if (draftRef.current) { setLeaveRequest({}); return; }
    onClose();
  }, [onClose]);
  const navigate = useCallback((direction: -1 | 1) => {
    if (renameBusyRef.current) return;
    if (draftRef.current) { setLeaveRequest({ direction }); return; }
    setActivePath((path) => {
      const current = files.findIndex((entry) => entry.path === path);
      return current < 0 ? path : files[current + direction]?.path ?? path;
    });
  }, [files]);

  useEffect(() => {
    if (!file) { if (!renameBusyRef.current) onClose(); return; }
    const controller = new AbortController();
    void Promise.all([loadAssetImageDetails(file, projectId, controller.signal), getAllAssetMeta()]).then(([result, metas]) => {
      if (!controller.signal.aborted) {
        setMetadata({ key: queryKey, history: result.history, saved: result, error: false });
        setSavedTags({ key: queryKey, tags: metas.find((meta) => meta.assetId === (file.assetId ?? file.path))?.tags ?? file.tags ?? [] });
      }
    }).catch(() => {
      if (!controller.signal.aborted) setMetadata({ key: queryKey, history: null, saved: null, error: true });
    });
    return () => controller.abort();
  }, [file, queryKey, projectId, onClose]);

  useEffect(() => {
    const controller = new AbortController();
    const effectiveProjectId = projectId || history?.projectId;
    void resolvePromptImageReferences(prompt, {
      nodes,
      dramaAssets,
      projectId: effectiveProjectId,
      signal: controller.signal,
    }).then((refs) => {
      if (!controller.signal.aborted) setPromptReferences(refs);
    }).catch(() => {
      if (!controller.signal.aborted) setPromptReferences([]);
    });
    return () => controller.abort();
  }, [prompt, nodes, dramaAssets, projectId, history?.projectId]);

  useEffect(() => () => {
    operationRef.current?.abort();
    reverseControllerRef.current?.abort();
    activeKeyRef.current = '';
  }, [queryKey]);
  useEffect(() => { draftRef.current = editing; activeKeyRef.current = queryKey; }, [editing, queryKey]);
  useEffect(() => {
    if (operation?.key === queryKey && operation.message === '已保存') {
      promptHeadingRef.current?.focus({ preventScroll: true });
      if (infoContentRef.current) infoContentRef.current.scrollTop = 0;
    }
  }, [operation, queryKey]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (document.querySelector('.reference-content-preview')) return;
      if (event.key === 'Tab' && leaveRequest) {
        const buttons = leavePanelRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
        if (buttons?.length) {
          const current = Array.from(buttons).indexOf(document.activeElement as HTMLButtonElement);
          buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
          event.preventDefault(); event.stopImmediatePropagation();
        }
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (renameBusyRef.current) return;
        if (renameDraft && renameDraft.path === file?.path) { setRenameDraft(null); setRenameMessage(''); return; }
        if (reversePanelOpen) { reverseControllerRef.current?.abort(); setReversePanelKey(null); return; }
        if (referencePreview) setReferencePreview(null); else if (leaveRequest) setLeaveRequest(null); else close(); return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.closest?.('input, textarea, select')) return;
      if (referencePreview || leaveRequest || reversePanelOpen || draftRef.current || renameDraft || renameBusyRef.current) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault(); event.stopImmediatePropagation(); navigate(event.key === 'ArrowLeft' ? -1 : 1);
    };
    // 在背景画布与资产库的键盘监听器之前消费按键。
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [close, navigate, referencePreview, leaveRequest, reversePanelOpen, renameDraft, file?.path]);

  if (!file || !file.assetUrl) return null;
  const shownImageKey = referencePreview ? `${referencePreview.url}:${imageRetry}` : imageKey;
  const broken = failedImage === shownImageKey;
  const extension = file.name.lastIndexOf('.') > 0 ? file.name.slice(file.name.lastIndexOf('.')) : '';
  const renaming = renameDraft?.path === file.path;
  const saveFileName = async () => {
    if (!renameDraft || !renaming || renameBusyRef.current || busy || editing || reversing) return;
    renameBusyRef.current = true;
    setRenameBusy(true); setRenameMessage('');
    try {
      const result = await renameAction({ ...file, assetId: file.assetId ?? saved?.identity?.assetId }, renameDraft.value, projectId);
      setRenamedFiles((current) => ({ ...Object.fromEntries(Object.entries(current).map(([path, entry]) =>
        [path, entry.path === file.path ? result.file : entry])), [file.path]: result.file }));
      setActivePath(result.file.path);
      setRenameDraft(null); setRenameMessage(result.warning ?? '文件名已修改');
      onRenamed?.(file, result.file);
    } catch (error) {
      setRenameMessage(error instanceof Error ? error.message : '修改文件名失败，请检查文件是否被占用或目录权限');
    } finally { renameBusyRef.current = false; setRenameBusy(false); }
  };
  const startEdit = () => {
    if (busy || renaming || renameBusyRef.current) return;
    setDraft({ key: queryKey, prompt, tags: [...tags], tagInput: '', references: saved?.references ?? [], pending: [] });
    setOperation(null);
  };
  const closeReversePanel = () => {
    reverseControllerRef.current?.abort();
    setReversePanelKey(null);
  };
  const runReverse = async () => {
    if (!reverseModel?.model || !reverseModel.provider || !saved?.identity || busy || reverseControllerRef.current) return;
    const key = queryKey;
    const controller = new AbortController();
    reverseControllerRef.current = controller;
    setReverseRunningKey(key);
    setOperation(null);
    try {
      const baseline = await getAssetMetaById(saved.identity.assetId);
      if (controller.signal.aborted || activeKeyRef.current !== key) return;
      const result = await reversePromptAndTags({ imageUrls: [file.assetUrl!], ...reverseModel, signal: controller.signal });
      if (controller.signal.aborted || activeKeyRef.current !== key) return;
      const existing = draft?.key === key ? draft : { key, prompt, tags: [...tags], tagInput: '', references: saved.references, pending: [] };
      const nextDraft = { ...existing, prompt: result.prompt, tags: [...new Set(result.tags)], tagInput: '' };
      setDraft(nextDraft);
      draftRef.current = true;
      setReversePanelKey(null);
      await saveEdit(nextDraft, {
        tags: nextDraft.tags, expected: baseline ? { tags: [...baseline.tags], updatedAt: baseline.updatedAt } : null,
      }, controller);
    } catch (error) {
      if (!controller.signal.aborted && activeKeyRef.current === key) {
        setOperation({ key, message: error instanceof Error ? error.message : '反推失败，请重试', busy: false });
      }
    } finally {
      if (reverseControllerRef.current === controller) reverseControllerRef.current = null;
      setReverseRunningKey((current) => current === key ? null : current);
    }
  };
  const addReferences = async () => {
    if (!editing || busy) return;
    const key = queryKey;
    setOperation({ key, message: '正在选择参考图…', busy: true });
    try {
      const paths = await pickAssetImageReferences();
      if (activeKeyRef.current !== key) return;
      if (draft.references.length + draft.pending.length + paths.length > MAX_ASSET_IMAGE_REFERENCES) throw new Error('最多添加 16 张参考图');
      const views = await previewPendingAssetImageReferences(paths);
      if (activeKeyRef.current !== key) return;
      setDraft((current) => current?.key === key ? { ...current, pending: [...current.pending, ...views] } : current);
      setOperation(null);
    } catch { if (activeKeyRef.current === key) setOperation({ key, message: '添加失败，请检查图片类型、数量或访问权限后重试', busy: false }); }
  };
  const saveEdit = async (nextDraft = draft, tagReplacement?: AssetImageTagReplacement, reverseController?: AbortController) => {
    if (!nextDraft || nextDraft.key !== queryKey || !saved?.identity || busy) return;
    const key = queryKey;
    const controller = reverseController ?? new AbortController();
    operationRef.current = controller;
    const nextTags = [...new Set([...nextDraft.tags, nextDraft.tagInput.trim()].filter(Boolean))];
    let promptSaved = false;
    setOperation({ key, message: '正在保存…', busy: true });
    try {
      const record = await saveAction(file, { identity: saved.identity, record: saved.record, prompt: nextDraft.prompt,
        references: nextDraft.references.map(({ id, name, relativePath, digest, bytes }) => ({ id, name, relativePath, digest, bytes })), newReferencePaths: nextDraft.pending.map((reference) => reference.path),
        ...(tagReplacement ? { tagReplacement } : {}),
      }, {
        signal: controller.signal, onProgress: ({ transferredBytes, totalBytes }) => {
          if (activeKeyRef.current === key) setOperation({ key, message: totalBytes ? t('正在复制参考图 {progress}%', { progress: Math.round(transferredBytes / totalBytes * 100) }) : '正在复制参考图…', busy: true });
        },
      });
      // 事务已经提交后，取消或预览读取失败不能把成功保存报告成失败。
      if (activeKeyRef.current !== key) return;
      promptSaved = true;
      setMetadata({ key, history, saved: { ...saved, record, references: record.references.map((reference) => ({ ...reference, url: null })), warning: null }, error: false });
      // 标签写入失败时保留新记录版本及参考图，重试不会重复复制参考图。
      setDraft((current) => current?.key === key ? { ...current, tags: nextTags, tagInput: '', references: record.references.map((reference) => ({ ...reference, url: null })), pending: [] } : current);
      const assetId = file.assetId ?? file.path;
      if (!tagReplacement) {
        if (nextTags.length) await putAssetMeta({ assetId, path: file.path, tags: nextTags, taggedBy: 'manual', updatedAt: Date.now() });
        else await deleteAssetMeta(assetId);
      }
      if (activeKeyRef.current !== key) return;
      setSavedTags({ key, tags: nextTags });
      onTagsSaved?.(file, nextTags);
      setDraft(null); draftRef.current = false; setLeaveRequest(null); setOperation({ key, message: '已保存', busy: false });
      const references = await resolveAssetImageReferences(record.references, controller.signal, record.assetId).catch(() => record.references.map((reference) => ({ ...reference, url: null })));
      if (activeKeyRef.current !== key) return;
      setMetadata({ key, history, saved: { ...saved, record, references, warning: null }, error: false });
    } catch {
      if (activeKeyRef.current === key) setOperation({ key, message: promptSaved ? '提示词和参考图已保存，标签保存失败。标签草稿仍保留，请重试。' : controller.signal.aborted ? '已取消，草稿仍保留' : '保存失败：原图可能已变化、信息发生冲突或目录不可用。草稿仍保留，可重试或取消编辑。', busy: false });
    } finally { if (operationRef.current === controller) operationRef.current = null; }
  };
  const pixelSize = dimensions?.key === imageKey ? `${dimensions.width} × ${dimensions.height}` : null;

  return <ModalOverlay isOpen onClose={close} ariaLabel={t("图片与生成信息")} className="asset-image-preview"
    zIndex={360} motionPreset="quick" backdropBlur={false} closeOnBackdrop={false}>
    <div data-tauri-drag-region className="asset-image-preview-layout">
      <div className="asset-image-preview-stage" onLoadCapture={(event) => {
        const image = event.target as HTMLImageElement;
        if (!referencePreview && image.tagName === 'IMG' && image.naturalWidth > 0 && image.naturalHeight > 0) {
          setDimensions({ key: imageKey, width: image.naturalWidth, height: image.naturalHeight });
        }
      }}>
        {broken ? <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-3 text-canvas-text-secondary">
          <Icon icon="lucide:image-off" className="h-8 w-8" aria-hidden="true" />
          <p>{t("图片加载失败")}</p><button type="button" className="ui-btn ui-btn--sm" onClick={() => setImageRetry((value) => value + 1)}>{t("重新加载图片")}</button>
        </div> : <ZoomableImage key={shownImageKey} src={referencePreview?.url ?? file.assetUrl} alt={referencePreview?.name ?? file.name} className="fullscreen-img-view"
          onError={() => setFailedImage(shownImageKey)} />}
        {referencePreview && <button type="button" className="ui-btn absolute left-3 top-3" onClick={() => setReferencePreview(null)}><Icon icon="lucide:arrow-left" aria-hidden="true" />{t("返回原图")}</button>}
      </div>
      <aside className="asset-image-preview-info" aria-label={t("图片提示词和参数")}>
        <header className="flex shrink-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-canvas-hover text-canvas-text-secondary"><Icon icon="lucide:image" className="h-4 w-4" aria-hidden="true" /></div>
          <div className="min-w-0 flex-1">{renaming ? <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); void saveFileName(); }}>
              <input autoFocus className="ui-input ui-input--sm min-w-0 flex-1" aria-label={t("新文件名")} value={renameDraft.value} disabled={renameBusy}
                onChange={(event) => setRenameDraft({ path: file.path, value: event.target.value })} />
              <span className="shrink-0 text-xs text-canvas-text-muted">{extension}</span>
              <button type="submit" className="ui-icon-btn ui-icon-btn--sm" aria-label={t("保存文件名")} title={t("保存文件名")} disabled={renameBusy || !renameDraft.value.trim()}><Icon icon="lucide:check" aria-hidden="true" /></button>
              <button type="button" className="ui-icon-btn ui-icon-btn--sm" aria-label={t("取消修改文件名")} disabled={renameBusy} onClick={() => { setRenameDraft(null); setRenameMessage(''); }}><Icon icon="lucide:x" aria-hidden="true" /></button>
            </form> : <h1 className="break-words text-sm font-semibold text-canvas-text">{file.name}</h1>}
            <p className="pt-1 text-xs text-canvas-text-muted" aria-live="polite">{index + 1} / {files.length}</p>
            {renameMessage && <p role="status" className="pt-1 text-xs text-canvas-text-secondary">{t(renameMessage)}</p>}</div>
          {!renaming && <button type="button" className="ui-icon-btn ui-icon-btn--sm [&.ui-icon-btn]:border-0 [&.ui-icon-btn]:bg-transparent [&.ui-icon-btn:hover]:bg-transparent" aria-label={t("修改文件名")} title={editing ? t('请先保存或取消当前编辑') : t('修改磁盘文件名')}
            disabled={!isTauriEnv() || busy || reversing || reversePanelOpen || editing || renameBusy || file.availability === 'offline'}
            onClick={() => { setRenameMessage(''); setRenameDraft({ path: file.path, value: extension ? file.name.slice(0, -extension.length) : file.name }); }}><Icon icon="lucide:pencil" aria-hidden="true" /></button>}
          <button type="button" className="ui-close-btn" aria-label={t("关闭图片预览")} title={t("关闭（Esc）")} disabled={renameBusy} onClick={close}><Icon icon="lucide:x" aria-hidden="true" /></button>
        </header>
        <div ref={infoContentRef} className="asset-image-preview-info-content">
          <section className="ui-card asset-image-preview-section p-3" aria-label={t("提示词")}>
            <div className="flex items-center justify-between gap-2 pb-2"><h2 ref={promptHeadingRef} tabIndex={-1} className="text-xs font-medium text-canvas-text-secondary">{t("提示词")}</h2>
              <button type="button" className="ui-btn ui-btn--sm" disabled={!prompt.trim()} onClick={() => {
                if (!prompt) return;
                const key = queryKey;
                void copyText(prompt).then((copied) => setCopyStatus({ key, message: copied ? '提示词已复制' : '复制失败，请重试' }));
              }}><Icon icon="lucide:copy" aria-hidden="true" />{t("复制提示词")}</button>
            </div>
            {!loading && !metadataError && (referenceViews.length > 0 || editing) && <div className="asset-image-preview-references">
              {referenceViews.map((reference) => <div className="asset-image-preview-reference" key={reference.id}>
                <button type="button" aria-label={t('查看参考图 {name}', { name: reference.name })} title={t('查看参考图 {name}', { name: reference.name })} disabled={!reference.url} onClick={() => setReferencePreview({ key: queryKey, url: reference.url!, name: reference.name })}>
                  {reference.url ? <ViewportImage src={reference.url} alt={reference.name} /> : <span className="text-xs text-canvas-text-muted">{t("参考图不可用")}</span>}
                </button>
                {editing && <button type="button" className="ui-close-btn asset-image-preview-reference-remove" disabled={busy} aria-label={t('移除参考图 {name}', { name: reference.name })}
                  onClick={() => setDraft((current) => current ? { ...current, references: current.references.filter((item) => item.id !== reference.id) } : current)}><Icon icon="lucide:x" aria-hidden="true" /></button>}
              </div>)}
              {editing && draft.pending.map((reference, i) => <div className="asset-image-preview-reference" key={`${i}:${reference.path}`}>
                <button type="button" aria-label={t('查看待保存参考图 {name}', { name: reference.name })} onClick={() => setReferencePreview({ key: queryKey, url: reference.url, name: reference.name })}><ViewportImage src={reference.url} alt={reference.name} /></button>
                <button type="button" className="ui-close-btn asset-image-preview-reference-remove" disabled={busy} aria-label={t('移除待保存参考图 {name}', { name: reference.name })}
                  onClick={() => setDraft((current) => current ? { ...current, pending: current.pending.filter((_, index) => index !== i) } : current)}><Icon icon="lucide:x" aria-hidden="true" /></button>
              </div>)}
              {editing && <button type="button" className="ui-icon-btn asset-image-preview-add-reference" aria-label={t("添加参考图")} title={t("添加本地参考图")} disabled={busy} onClick={() => void addReferences()}><Icon icon="lucide:plus" aria-hidden="true" /></button>}
            </div>}
            {loading ? <p role="status" className="text-xs text-canvas-text-muted">{t("正在读取生成信息…")}</p>
              : metadataError ? <div role="alert" className="space-y-2 text-xs text-canvas-text-secondary"><p>{t("生成信息读取失败")}</p>
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setRetry((value) => value + 1)}>{t("重试读取")}</button></div>
              : editing ? <textarea className="ui-textarea asset-image-preview-editor" aria-label={t("编辑图片提示词")} value={draft.prompt} maxLength={MAX_ASSET_IMAGE_PROMPT} disabled={busy}
                onChange={(event) => setDraft((current) => current ? { ...current, prompt: event.target.value } : current)} />
              : <p className="asset-image-preview-prompt whitespace-pre-wrap break-words text-sm leading-relaxed text-canvas-text">{renderPromptWithChips(prompt, {
                  nodes,
                  dramaAssets,
                  globalAssets,
                  nodeMetaMap,
                  emptyText: saved?.record ? t('尚未填写提示词') : history ? t('此记录未保存提示词') : t('暂无生成信息'),
                })}</p>}
            {(tags.length > 0 || editing) && <div className="flex flex-wrap items-center gap-2 pt-3" role="group" aria-label={t("资产标签")}>
              {tags.map((tag) => <span key={tag} className={editing ? 'ui-tag' : 'ui-badge ui-badge--primary'}>{tag}
                {editing && <button type="button" className="ui-tag__remove" aria-label={t('移除标签 {tag}', { tag })} disabled={busy}
                  onClick={() => setDraft((current) => current ? { ...current, tags: current.tags.filter((item) => item !== tag) } : current)}><Icon icon="lucide:x" aria-hidden="true" /></button>}
              </span>)}
              {editing && <input className="ui-input ui-input--sm w-40" aria-label={t("添加资产标签")} placeholder={t("标签，回车添加")} title={t("输入后按回车添加，也可直接保存")} value={draft.tagInput} disabled={busy}
                onChange={(event) => setDraft((current) => current ? { ...current, tagInput: event.target.value } : current)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  setDraft((current) => {
                    if (!current) return current;
                    const tag = current.tagInput.trim();
                    return { ...current, tags: tag && !current.tags.includes(tag) ? [...current.tags, tag] : current.tags, tagInput: '' };
                  });
                }} />}
            </div>}
            {saved?.warning && <p className="pt-2 text-xs text-canvas-text-muted">{saved.warning}</p>}
            {canEdit && <div className="flex flex-wrap justify-end gap-2 pt-2">
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || reversing || renaming || renameBusy} onClick={() => { setOperation(null); setReversePanelKey(queryKey); }}>
                <Icon icon="lucide:sparkles" aria-hidden="true" />{t("反推提示词和标签")}</button>
              {editing ? <><button type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={() => { setDraft(null); setOperation(null); }}>{t("取消编辑")}</button>
                <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy} onClick={() => void saveEdit()}>{t("保存")}</button></>
                : <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || renaming || renameBusy} onClick={startEdit}><Icon icon="lucide:pencil" aria-hidden="true" />{t("编辑提示词与参考图")}</button>}
            </div>}
            {operation?.key === queryKey && <div className="pt-2 text-xs text-canvas-text-secondary" role="status">{t(operation.message)}{operation.busy && operation.message !== '正在选择参考图…' && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => operationRef.current?.abort()}>{t("取消保存")}</button>}</div>}
            {copyStatus?.key === queryKey && <p role="status" className="pt-2 text-xs text-canvas-text-secondary">{t(copyStatus.message)}</p>}
          </section>
          <section className="asset-image-preview-parameters" aria-label={t("生成参数")}>
            <h2 className="flex items-center gap-2 pb-3 text-xs font-medium text-canvas-text-secondary"><Icon icon="lucide:info" className="h-3.5 w-3.5" aria-hidden="true" />{t("参数与文件信息")}</h2>
            <dl className="ui-card asset-image-preview-section space-y-3 p-3 text-sm">
              {details.map(({ label, value }) => <div className="flex items-start justify-between gap-3" key={label}>
                <dt className="shrink-0 text-canvas-text-muted">{t(label)}</dt><dd className="min-w-0 whitespace-pre-wrap break-words text-right text-canvas-text">{label === '提示词来源' ? t(value) : value}</dd>
              </div>)}
              <div className="flex justify-between gap-3"><dt className="text-canvas-text-muted">{t("图片尺寸")}</dt><dd className="text-canvas-text">{pixelSize ?? (broken ? '无法读取' : '正在读取…')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-canvas-text-muted">{t("文件大小")}</dt><dd className="text-canvas-text">{file.size > 0 ? formatSize(file.size) : t('未知')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-canvas-text-muted">{t("来源")}</dt><dd className="text-canvas-text">{file.source === 'folder' ? t('外部文件夹') : file.source === 'global' ? t('导入文件') : t('项目文件')}</dd></div>
            </dl>
            {!loading && !metadataError && !history && !saved?.record && <p className="pt-3 text-xs leading-relaxed text-canvas-text-muted">{t("此图片未关联到保留的生成记录，可手动编辑提示词和参考图。")}</p>}
          </section>
        </div>
        <footer className="asset-image-preview-footer">
          <p className="pb-2 text-center text-xs text-canvas-text-muted">{t("双击缩放 · 拖动查看 · Esc 关闭")}</p>
          <div className="flex gap-2">
            <button type="button" className="ui-btn ui-btn--block" aria-label={t("上一张图片")} title={t("上一张（←）")} disabled={renameBusy || index <= 0} onClick={() => navigate(-1)}><Icon icon="lucide:arrow-left" aria-hidden="true" />{t("上一张")}</button>
            <button type="button" className="ui-btn ui-btn--primary ui-btn--block" aria-label={t("下一张图片")} title={t("下一张（→）")} disabled={renameBusy || index >= files.length - 1} onClick={() => navigate(1)}>{t("下一张")}<Icon icon="lucide:arrow-right" aria-hidden="true" /></button>
          </div>
        </footer>
      </aside>
    </div>
    {reversePanelOpen && <ModalOverlay isOpen onClose={closeReversePanel} ariaLabel={t("反推提示词和标签")} zIndex={370} closeOnBackdrop={false}
      className="w-full max-w-lg [&.glass-panel]:overflow-visible">
      <div className="ui-card w-full space-y-3 p-3 [&.ui-card]:overflow-visible">
        <div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-semibold text-canvas-text"><Icon icon="lucide:sparkles" aria-hidden="true" />{t("反推提示词和标签")}</h2>
          <button type="button" className="ui-close-btn" aria-label={t("关闭反推")} onClick={closeReversePanel}><Icon icon="lucide:x" aria-hidden="true" /></button></div>
        <p className="text-xs text-canvas-text-secondary">{t("选择能读图的文本模型。反推成功后自动保存提示词和标签，之后仍可手动编辑。")}</p>
        <fieldset disabled={reversing} className="min-w-0 space-y-2"><legend className="pb-2 text-xs text-canvas-text-secondary">{t("反推模型")}</legend>
          <ModelSelector nodeType="ai-text" selectedModel={reverseModel?.model} selectedProvider={reverseModel?.provider}
            onSelect={(option) => setReverseModel({ model: option.value, provider: option.provider })} />
        </fieldset>
        {operation?.key === queryKey && <p role="status" className="whitespace-pre-wrap break-words text-xs text-canvas-text-secondary">{t(operation.message)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="ui-btn ui-btn--sm" onClick={closeReversePanel}>{reversing ? t('取消反推') : t('取消')}</button>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={reversing || !reverseModel?.model || !reverseModel.provider} onClick={() => void runReverse()}>
            <Icon icon={reversing ? 'lucide:loader-circle' : 'lucide:sparkles'} className={reversing ? 'animate-spin' : undefined} aria-hidden="true" />{reversing ? t('正在反推…') : t('开始反推')}</button></div>
      </div>
    </ModalOverlay>}
    {leaveRequest && <ModalOverlay isOpen onClose={() => setLeaveRequest(null)} ariaLabel={t("未保存的图片信息")} zIndex={370} closeOnBackdrop={false}>
      <div ref={leavePanelRef} role="alertdialog" className="ui-card p-3 space-y-3"><p className="text-sm text-canvas-text">{t("图片信息尚未保存，要放弃这次编辑吗？")}</p>
        <div className="flex justify-end gap-2"><button type="button" className="ui-btn" onClick={() => setLeaveRequest(null)}>{t("继续编辑")}</button>
          <button type="button" className="ui-btn ui-btn--danger" disabled={busy} onClick={() => {
            const direction = leaveRequest.direction; setDraft(null); draftRef.current = false; setLeaveRequest(null);
            if (direction) navigate(direction); else onClose();
          }}>{t("放弃编辑")}</button></div>
      </div>
    </ModalOverlay>}
  </ModalOverlay>;
}
