import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import type { CharacterLibraryScope } from '../../store/store.dramaAssets';
import type { DramaCharacter } from '../../types/dramaAssets';
import type { CharacterVisualGenerationParameters } from '../../types/media';
import { canonicalXiaohongshuReferenceUrl } from '../../utils/xiaohongshuReferenceUrl';
import { polishCharacterVisualPrompt } from '../../services/characterVisualPromptPolish';
import {
  closeCharacterXiaohongshuReference, focusCharacterXiaohongshuReference, importCharacterXiaohongshuReference,
  listenForCharacterXiaohongshuWindow, openCharacterXiaohongshuReference, setCharacterXiaohongshuStatus,
  type CharacterXiaohongshuReference,
} from '../../services/characterXiaohongshuReference';
import { confirmAction } from '../../services/confirmDialog';
import { CHARACTER_VISUAL_VIEWS, freezeCharacterVisualMaskBase, prepareCharacterVisualMask } from '../../services/characterVisualComposition';
import { listGlobalFiles, listProjectFiles, type AssetFileEntry } from '../../services/fileService';
import {
  buildCharacterVisualPrompt,
  captureCharacterVisualTarget,
  generateCharacterVisual,
  isCharacterVisualInputUrl,
  listCharacterVisualDraftTargets,
  listCharacterVisualModels,
  listCharacterVisualRuns,
  MAX_CHARACTER_VISUAL_REFERENCE_BYTES,
  readCharacterVisualInput,
  readCharacterVisualRunCandidates,
  reviewCharacterVisualRun,
  resumeCharacterVisualRun,
  resolveCharacterVisualParameters,
  subscribeCharacterVisualRuns,
  type CharacterVisualCandidate,
  type CharacterVisualOperation,
  type CharacterVisualReference,
  type CharacterVisualRun,
  type CharacterVisualTarget,
} from '../../services/characterVisualWorkbenchService';
import { getConfiguredModelGroups, getGeneralModelGroups } from '../nodes/shared/defaultModels';
import CharacterVisualGenerationSettings from './CharacterVisualGenerationSettings';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';
import ViewportImage from '../shared/ViewportImage';
import { CHARACTER_REFERENCE_KIND_LABELS } from './characterReferencePresentation';
import LazyLoadBoundary, { LazyLoadFallback } from '../shared/LazyLoadBoundary';

const CharacterVisualMultiView = lazy(() => import('./CharacterVisualMultiView'));
const CharacterVisualProjectUpdate = lazy(() => import('./CharacterVisualProjectUpdate'));
const MattingEditor = lazy(() => import('../nodes/shared/image/MattingEditor'));

interface CharacterVisualWorkbenchProps {
  scope: CharacterLibraryScope;
  character: DramaCharacter;
  isNew: boolean;
  selectedReferenceId?: string | null;
  onClose: () => void;
  onAdopt: (candidate: CharacterVisualCandidate, makePrimary: boolean, signal: AbortSignal) => void | Promise<void>;
  onKeepReference: (reference: CharacterVisualReference) => void;
  onResumeDraft?: (target: CharacterVisualTarget, name: string) => void;
  onApplyFields: (patch: Partial<Pick<DramaCharacter, 'visualNotes' | 'wardrobeDefault'>>) => void;
  assertCurrent?: () => void;
}

type ReferenceOption = CharacterVisualReference & { label: string; localBytes?: number };
interface XiaohongshuWindow {
  id: string;
  unlisten: Awaited<ReturnType<typeof listenForCharacterXiaohongshuWindow>>[];
  importing?: AbortController;
}

function releaseXiaohongshuWindow(session: XiaohongshuWindow) {
  session.importing?.abort();
  session.unlisten.splice(0).forEach((unlisten) => { void Promise.resolve(unlisten()).catch(() => undefined); });
}

const OPERATION_LABELS: Record<CharacterVisualOperation, string> = {
  appearance: '生成角色形象',
  turnaround: '用选中图做三视图',
  edit: '按描述改图',
};
const STATUS_LABELS: Record<CharacterVisualRun['status'], string> = {
  submitting: '生成中…',
  completed: '已生成',
  failed: '生成失败',
  uncertain: '提交状态待核对',
  paused: '等待续查',
  reviewed: '已核对原任务',
};
const PURPOSES = ['脸型', '发型', '服装', '体型', '风格'];
const MAX_INPUTS = 16;
function SourceLink({ url }: { url: string }) {
  const t = useT();
  return canonicalXiaohongshuReferenceUrl(url) ? <button type="button" className="ui-btn ui-btn--link ui-btn--sm"
    onClick={() => { void import('@tauri-apps/plugin-shell').then(({ open }) => open(url)).catch(() => {
      useAppStore.getState().showToast(t('无法打开参考来源'), 'error');
    }); }}>{t('查看小红书来源')}</button> : null;
}

function LibraryImages({ projectId, onSelect }: {
  projectId?: string;
  onSelect: (item: ReferenceOption) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(32);
  const [files, setFiles] = useState<AssetFileEntry[]>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    void Promise.allSettled([
      projectId ? listProjectFiles(projectId, options) : Promise.resolve([]),
      listGlobalFiles(options),
    ]).then((results) => {
      if (controller.signal.aborted) return;
      setFiles(results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
        .filter((file) => file.category === 'image' && isCharacterVisualInputUrl(file.assetUrl) && file.availability !== 'offline'));
      setError(results.some((result) => result.status === 'rejected'));
    });
    return () => controller.abort();
  }, [projectId]);
  const matches = files?.filter((file) => file.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="ui-card ui-stack p-2">
      <input className="ui-input w-full" aria-label={t('搜索素材图片')} placeholder={t('搜索素材图片')}
        value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(32); }} />
      {error && <p className="text-xs text-canvas-text-secondary" role="status">{t('部分素材库读取失败')}</p>}
      {!matches ? <p className="text-xs text-canvas-text-secondary" role="status">{t('加载中…')}</p>
        : matches.length === 0 ? <p className="text-xs text-canvas-text-secondary">{t('没有匹配的图片')}</p>
        : (
          <div className="grid max-h-60 grid-cols-3 gap-2 overflow-auto sm:grid-cols-6">
            {matches.slice(0, visibleCount).map((file) => (
              <button type="button" key={file.path} title={file.name}
                className="ui-card ui-card--interactive min-w-0 items-stretch gap-1 p-2 text-left text-xs"
                onClick={() => onSelect({ id: file.assetId ?? crypto.randomUUID(), url: file.assetUrl!, label: file.name })}>
                <ViewportImage src={file.assetUrl} alt="" className="aspect-square w-full rounded object-cover" />
                <span className="truncate">{file.name}</span>
                <span className="truncate text-canvas-text-muted">{t(file.source === 'global' ? '全局素材' : '项目素材')}</span>
              </button>
            ))}
          </div>
        )}
      {matches && matches.length > visibleCount && (
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm self-start"
          onClick={() => setVisibleCount((value) => value + 32)}>{t('加载更多')}</button>
      )}
    </div>
  );
}

export default function CharacterVisualWorkbench({
  scope, character, isNew, selectedReferenceId, onClose, onAdopt, onKeepReference, onResumeDraft, onApplyFields, assertCurrent,
}: CharacterVisualWorkbenchProps) {
  const t = useT();
  const { config, workflows, projectId, projectReady, savedRoles, nodes } = useAppStore(useShallow((state) => ({
    config: state.config,
    workflows: state.workflows,
    projectId: state.currentProjectId,
    projectReady: state.projectLoadStatus === 'ready',
    savedRoles: scope === 'project' ? state.dramaAssets.characters : state.globalCharacters,
    nodes: state.nodes,
  })));
  const [target] = useState(() => captureCharacterVisualTarget(scope, character.id));
  const [sourceProjectId] = useState(projectId);
  const [libraryProjectId] = useState(() =>
    target.ownerId ?? captureCharacterVisualTarget('project', character.id).ownerId);
  const [operation, setOperation] = useState<CharacterVisualOperation>('appearance');
  const [channel, setChannel] = useState<'standard' | 'midjourney'>('standard');
  const [promptOverrides, setPromptOverrides] = useState<Partial<Record<CharacterVisualOperation, string>>>({});
  const [modelId, setModelId] = useState('');
  const [aspectRatio, setAspectRatio] = useState('');
  const [imageSize, setImageSize] = useState('');
  const [generationParameters, setGenerationParameters] = useState<CharacterVisualGenerationParameters>({});
  const [inputs, setInputs] = useState<ReferenceOption[]>([]);
  const [appearanceReferenceIds, setAppearanceReferenceIds] = useState<string[]>([]);
  const [baseReferenceId, setBaseReferenceId] = useState(selectedReferenceId ?? character.primaryReferenceImageId ?? '');
  const [purposes, setPurposes] = useState<Record<string, string>>({});
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [auxiliary, setAuxiliary] = useState<'multi' | 'project' | 'mask'>();
  const [mask, setMask] = useState<{ referenceId: string; baseUrl: string; baseDigest: string; overlayUrl: string; pngDataUrl: string }>();
  const [maskBase, setMaskBase] = useState<{ url: string; digest: string }>();
  const [needsMask, setNeedsMask] = useState(false);
  const [projectImage, setProjectImage] = useState<{ imageUrl: string; targetReferenceId?: string }>();
  const [runs, setRuns] = useState<CharacterVisualRun[]>([]);
  const [drafts, setDrafts] = useState<Awaited<ReturnType<typeof listCharacterVisualDraftTargets>>>([]);
  const [chosenDraftId, setChosenDraftId] = useState('');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [candidatePreview, setCandidatePreview] = useState<{ key: string; candidates: CharacterVisualCandidate[] }>();
  const [comparison, setComparison] = useState<{ runId: string; url: string }>();
  const [historyRevision, setHistoryRevision] = useState(0);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState(false);
  const [draftHistoryError, setDraftHistoryError] = useState(false);
  const [pending, setPending] = useState<'import' | 'generate' | 'adopt' | 'optimize' | 'review' | 'resume'>();
  const [textModelId, setTextModelId] = useState('');
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizedPrompt, setOptimizedPrompt] = useState('');
  const uploadInput = useRef<HTMLInputElement>(null);
  const actionRef = useRef<AbortController | null>(null);
  const xiaohongshu = useRef<XiaohongshuWindow | null>(null);
  const onXiaohongshuImport = useRef<((reference: CharacterXiaohongshuReference) => void) | null>(null);
  const isTargetCurrent = scope === 'global' || sourceProjectId === projectId && projectReady && Boolean(target.ownerId);

  useEffect(() => () => actionRef.current?.abort(), []);
  useEffect(() => () => {
    const session = xiaohongshu.current;
    xiaohongshu.current = null;
    if (!session) return;
    releaseXiaohongshuWindow(session);
    void closeCharacterXiaohongshuReference(session.id).catch(() => undefined);
  }, [isTargetCurrent]);
  useEffect(() => {
    if (!isTargetCurrent) return;
    let active = true;
    let revision = 0;
    const refresh = async () => {
      const readRevision = ++revision;
      try {
        const currentRuns = await listCharacterVisualRuns(target);
        if (active && readRevision === revision) { setRuns(currentRuns); setHistoryError(false); }
      } catch {
        if (active && readRevision === revision) setHistoryError(true);
      }
    };
    const unsubscribe = subscribeCharacterVisualRuns(() => { void refresh(); });
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, [target, historyRevision, isTargetCurrent]);
  const canResume = isNew && Boolean(onResumeDraft) && isTargetCurrent;
  useEffect(() => {
    if (!canResume) return;
    let active = true;
    void listCharacterVisualDraftTargets(target).then((entries) => {
      if (active) { setDrafts(entries); setDraftHistoryError(false); }
    }, () => { if (active) setDraftHistoryError(true); });
    return () => { active = false; };
  }, [target, canResume, historyRevision]);

  const prompt = promptOverrides[operation] ?? buildCharacterVisualPrompt(character, operation);
  const referenceOptions: ReferenceOption[] = [
    ...(character.referenceImages ?? []).flatMap((reference) => {
      const source = scope === 'project' && reference.sourceNodeId
        ? nodes.find((node) => node.id === reference.sourceNodeId) : undefined;
      const url = [reference.imageUrl, source?.data.imageUrl, source?.data.thumbnailUrl].find(isCharacterVisualInputUrl);
      return url ? [{ id: reference.id, url, sourceUrl: reference.sourceUrl, label: t(CHARACTER_REFERENCE_KIND_LABELS[reference.kind]) }] : [];
    }),
    ...inputs.filter((input) => !character.referenceImages?.some((item) => item.id === input.id)),
  ];
  const referenceIds = operation === 'appearance' ? appearanceReferenceIds : baseReferenceId ? [baseReferenceId] : [];
  const references = referenceIds.flatMap((id) => {
    const reference = referenceOptions.find((item) => item.id === id);
    return reference ? [{ ...reference, purpose: purposes[id] || undefined }] : [];
  });
  const allModels = useMemo(() => isTargetCurrent ? listCharacterVisualModels(target, operation, 0, config, workflows) : [],
    [target, operation, isTargetCurrent, config, workflows]);
  const models = useMemo(() => channel === 'midjourney' ? allModels.filter((item) => item.channel === 'midjourney') : allModels, [allModels, channel]);
  const base = operation === 'edit' ? references[0] : undefined;
  const activeMask = mask && base?.id === mask.referenceId && base.url === mask.baseUrl ? mask : undefined;
  const model = models.find((item) => item.id === modelId) ?? (!modelId
    ? models.find((item) => item.maxReferences >= references.length && (!activeMask || item.supportsMask)) ?? models[0]
    : undefined);
  const ratios = model?.ratios ?? [];
  const sizes = model?.resolutions ?? [];
  const ratio = ratios.includes(aspectRatio) ? aspectRatio
    : operation === 'turnaround' && ratios.includes('16:9') ? '16:9' : model?.defaultRatio ?? ratios[0] ?? '';
  const size = sizes.find((value) => value.toLowerCase() === imageSize.toLowerCase())
    ?? model?.defaultResolution ?? sizes[0] ?? '';
  const generationValues = model ? resolveCharacterVisualParameters(model, generationParameters, config) : generationParameters;
  const textModels = useMemo(() => optimizeOpen ? [
    ...getConfiguredModelGroups(config, 'ai-text'),
    ...getGeneralModelGroups(config.generalModels ?? [], config, 'ai-text'),
  ].flatMap((group) => group.models) : [], [config, optimizeOpen]);
  const textModel = textModels.find((item) => item.value === textModelId) ?? textModels[0];
  const activeRun = runs.find((run) => run.id === selectedRunId) ?? runs[0];
  const activeRunId = activeRun?.id;
  const candidateKey = activeRun?.candidateIds.length ? activeRun.candidateIds.join(',') : '';
  const previewCandidates = !isTargetCurrent ? []
    : candidatePreview?.key === candidateKey ? candidatePreview.candidates : activeRun?.candidates ?? [];
  const multiViewOpen = auxiliary === 'multi';
  const candidate = previewCandidates.find((item) => item.id === selectedCandidateId) ?? previewCandidates[0];
  useEffect(() => {
    if (!isTargetCurrent || !activeRunId || !candidateKey || multiViewOpen) return;
    let active = true;
    void readCharacterVisualRunCandidates(target, activeRunId).then((candidates) => {
      if (active) setCandidatePreview({ key: candidateKey, candidates });
    }, () => {
      if (active) setCandidatePreview({ key: candidateKey, candidates: [] });
    });
    return () => { active = false; };
  }, [target, isTargetCurrent, activeRunId, candidateKey, historyRevision, multiViewOpen]);
  const projectReference = referenceOptions.find((entry) => entry.id === (selectedReferenceId ?? character.primaryReferenceImageId));
  const compareBase = comparison?.runId === activeRun?.id ? comparison?.url : undefined;
  const recoverableDrafts = drafts.filter((item) => item.target.characterId !== character.id
    && !savedRoles.some((saved) => saved.id === item.target.characterId));
  const chosenDraft = recoverableDrafts.find((item) => item.target.characterId === chosenDraftId);
  const availableMessage = !isTargetCurrent ? t('原角色工作区已切换，请重新打开')
    : !models.length ? t('当前没有兼容的生图模型，请在「设置 → API Key」中配置')
    : !model ? t('请为本次操作选择图片模型')
    : model.channel === 'midjourney' && operation !== 'appearance' ? t('Midjourney 专用通道仅用于角色生图')
    : referenceIds.length !== references.length ? t('选中的参考图已不可用，请重新选择')
    : operation !== 'appearance' && references.length !== 1 ? t('请选择一张底图')
    : operation === 'edit' && needsMask && !activeMask ? t('请重画蒙版或切换为文字改图')
    : activeMask && !model.supportsMask ? t('请选择支持画笔蒙版的图片模型')
    : references.length > 0 && !model.supportsReferences
      ? t('当前连接无法发送参考图。请选择兼容模型，或在「设置 → API Key → 模型调用协议」中检查「参考图请求」。')
    : references.length > model.maxReferences ? t('当前模型最多支持 {count} 张参考图', { count: model.maxReferences })
    : '';

  const patchPrompt = (value: string) => {
    setPromptOverrides((current) => ({ ...current, [operation]: value }));
    setOptimizedPrompt('');
  };
  const changeOperation = (next: CharacterVisualOperation) => {
    setOperation(next);
    setChannel('standard');
    setNeedsMask(false);
    setModelId('');
    setAspectRatio('');
    setImageSize('');
    setGenerationParameters({});
    setOptimizedPrompt('');
    setError('');
  };
  const toggleReference = (id: string) => {
    if (operation !== 'appearance') { setBaseReferenceId((current) => current === id ? '' : id); return; }
    if (appearanceReferenceIds.length >= MAX_INPUTS && !appearanceReferenceIds.includes(id)) {
      setError(t('本次最多添加 {count} 张参考图', { count: MAX_INPUTS }));
      return;
    }
    setError('');
    setAppearanceReferenceIds((current) => current.includes(id)
      ? current.filter((item) => item !== id) : [...current, id]);
  };
  const clearReferenceSelection = () => {
    if (operation === 'appearance') setAppearanceReferenceIds([]);
    else setBaseReferenceId('');
    setError('');
  };
  const addInputs = (items: ReferenceOption[]) => {
    const existing = new Set(inputs.map((input) => input.id));
    const additions = items.filter((item) => !existing.has(item.id));
    const remaining = MAX_INPUTS - inputs.length;
    if (additions.length > remaining) {
      setError(t('本次最多添加 {count} 张参考图', { count: MAX_INPUTS }));
    }
    const allowed = new Set([...existing, ...additions.slice(0, remaining).map((item) => item.id)]);
    const selected = items.filter((item) => allowed.has(item.id));
    if (!selected.length) return;
    setInputs((current) => [...current, ...additions.slice(0, remaining)]);
    if (operation === 'appearance') {
      setAppearanceReferenceIds((current) => [...new Set([...current, ...selected.map((item) => item.id)])].slice(0, MAX_INPUTS));
    } else {
      setBaseReferenceId(selected[0].id);
    }
  };
  const runAction = async (kind: NonNullable<typeof pending>, action: (signal: AbortSignal) => Promise<void>, failure: string) => {
    if (actionRef.current || !isTargetCurrent) return;
    const controller = new AbortController();
    actionRef.current = controller;
    setPending(kind);
    setError('');
    try {
      assertCurrent?.();
      await action(controller.signal);
    } catch {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      actionRef.current = null;
      if (!controller.signal.aborted) setPending(undefined);
    }
  };

  useLayoutEffect(() => {
    onXiaohongshuImport.current = (reference) => {
      assertCurrent?.();
      if (!isTargetCurrent) throw new Error(t('原角色工作区已切换，请重新打开'));
      if (auxiliary) throw new Error(t('请等待当前操作完成'));
      const existing = referenceOptions.some((item) => item.id === reference.id);
      const referenceCount = operation === 'appearance' ? appearanceReferenceIds.length : 0;
      if ((!existing && inputs.length >= MAX_INPUTS)
        || (referenceCount >= MAX_INPUTS && !appearanceReferenceIds.includes(reference.id))) {
        throw new Error(t('本次最多添加 {count} 张参考图', { count: MAX_INPUTS }));
      }
      if (!existing) {
        const stagedBytes = inputs.reduce((sum, item) => sum + (item.localBytes ?? 0), 0);
        if (stagedBytes + reference.stagedBytes > MAX_CHARACTER_VISUAL_REFERENCE_BYTES) {
          throw new Error(t('参考图片总大小超出限制'));
        }
        setInputs((current) => [...current, { ...reference, localBytes: reference.stagedBytes }]);
      }
      if (operation === 'appearance') {
        setAppearanceReferenceIds((current) => current.includes(reference.id) ? current : [...current, reference.id]);
      } else {
        setBaseReferenceId(reference.id);
      }
    };
    return () => { onXiaohongshuImport.current = null; };
  });

  const importXiaohongshu = async (session: XiaohongshuWindow) => {
    if (xiaohongshu.current !== session || session.importing) return;
    if (actionRef.current) {
      await setCharacterXiaohongshuStatus(session.id, 'failed', t('请等待当前操作完成')).catch(() => undefined);
      return;
    }
    const controller = new AbortController();
    session.importing = controller;
    actionRef.current = controller;
    setPending('import');
    setError('');
    try {
      await setCharacterXiaohongshuStatus(session.id, 'importing');
      const reference = await importCharacterXiaohongshuReference(session.id, controller.signal);
      if (xiaohongshu.current !== session || !onXiaohongshuImport.current) return;
      onXiaohongshuImport.current(reference);
      session.importing = undefined;
      try {
        await closeCharacterXiaohongshuReference(session.id);
        if (xiaohongshu.current === session) xiaohongshu.current = null;
        releaseXiaohongshuWindow(session);
      } catch {
        await setCharacterXiaohongshuStatus(session.id, 'imported').catch(() => undefined);
      }
    } catch (reason) {
      if (!controller.signal.aborted && xiaohongshu.current === session) {
        const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '小红书参考操作失败';
        setError(t(message));
        await setCharacterXiaohongshuStatus(session.id, 'failed', t(message)).catch(() => undefined);
      }
    } finally {
      session.importing = undefined;
      if (actionRef.current === controller) {
        actionRef.current = null;
        if (!controller.signal.aborted || onXiaohongshuImport.current) setPending(undefined);
      }
    }
  };

  const openXiaohongshu = () => {
    void runAction('import', async (signal) => {
      const previous = xiaohongshu.current;
      if (previous) {
        try {
          await focusCharacterXiaohongshuReference(previous.id);
          return;
        } catch {
          releaseXiaohongshuWindow(previous);
          await closeCharacterXiaohongshuReference(previous.id).catch(() => undefined);
        }
      }
      signal.throwIfAborted();
      const session: XiaohongshuWindow = { id: crypto.randomUUID().replaceAll('-', ''), unlisten: [] };
      xiaohongshu.current = session;
      try {
        session.unlisten.push(await listenForCharacterXiaohongshuWindow('xiaohongshu-reference-closed', session.id, () => {
          if (xiaohongshu.current === session) xiaohongshu.current = null;
          if (session.importing && actionRef.current === session.importing) {
            actionRef.current = null;
            setPending(undefined);
          }
          releaseXiaohongshuWindow(session);
        }));
        signal.throwIfAborted();
        session.unlisten.push(await listenForCharacterXiaohongshuWindow('xiaohongshu-reference-import-requested', session.id,
          () => { void importXiaohongshu(session); }));
        signal.throwIfAborted();
        if (xiaohongshu.current !== session) { releaseXiaohongshuWindow(session); return; }
        await openCharacterXiaohongshuReference(session.id);
        signal.throwIfAborted();
        if (xiaohongshu.current !== session) {
          await closeCharacterXiaohongshuReference(session.id).catch(() => undefined);
          return;
        }
        assertCurrent?.();
      } catch (reason) {
        if (xiaohongshu.current === session) xiaohongshu.current = null;
        releaseXiaohongshuWindow(session);
        await closeCharacterXiaohongshuReference(session.id).catch(() => undefined);
        throw reason;
      }
    }, t('无法打开小红书窗口'));
  };
  const importFiles = (files: File[]) => {
    if (!files.length) return;
    const remaining = MAX_INPUTS - inputs.length;
    if (remaining <= 0) { setError(t('本次最多添加 {count} 张参考图', { count: MAX_INPUTS })); return; }
    const batch = files.slice(0, remaining);
    const stagedBytes = inputs.reduce((sum, input) => sum + (input.localBytes ?? 0), 0);
    if (stagedBytes + batch.reduce((sum, file) => sum + file.size, 0) > MAX_CHARACTER_VISUAL_REFERENCE_BYTES) {
      setError(t('参考图片总大小超出限制'));
      return;
    }
    void runAction('import', async (signal) => {
      const next: ReferenceOption[] = [];
      for (const file of batch) {
        const url = await readCharacterVisualInput(file, signal);
        next.push({ id: crypto.randomUUID(), label: file.name || t('粘贴的图片'), url, localBytes: file.size });
      }
      signal.throwIfAborted();
      addInputs(next);
      if (files.length > next.length) setError(t('本次最多添加 {count} 张参考图', { count: MAX_INPUTS }));
    }, t('图片读取失败'));
  };
  const removeInput = (id: string) => {
    setInputs((current) => current.filter((item) => item.id !== id));
    setAppearanceReferenceIds((current) => current.filter((item) => item !== id));
    setBaseReferenceId((current) => current === id ? '' : current);
    setError('');
  };
  const pasteImages = (event: ClipboardEvent<HTMLDivElement>) => {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    importFiles(images);
  };
  const generate = () => {
    if (!model || !prompt.trim() || availableMessage) return;
    void runAction('generate', async (signal) => {
      let baseSnapshot: string | undefined;
      const isDerived = operation !== 'appearance';
      const result = await generateCharacterVisual({
        ...generationValues, workflowId: model.workflowId,
        target, operation, prompt, model: model.id, provider: model.provider,
        aspectRatio: ratio || undefined, imageSize: size || undefined,
        references: references.map(({ id, url, purpose, sourceUrl }) => ({ id, url, purpose, sourceUrl })),
        mask: activeMask ? { pngDataUrl: activeMask.pngDataUrl, referenceId: activeMask.referenceId, baseDigest: activeMask.baseDigest } : undefined,
        characterName: character.name, isNew,
        onBaseSnapshot: isDerived ? (dataUrl) => { baseSnapshot = dataUrl; } : undefined,
        assertCurrent: () => {
          signal.throwIfAborted();
          assertCurrent?.();
          if (scope === 'project' && useAppStore.getState().currentProjectId !== sourceProjectId) {
            throw new Error(t('原角色工作区已切换，请重新打开'));
          }
        },
      }, signal);
      if (signal.aborted) return;
      setComparison(baseSnapshot && result.candidates.length > 0 ? { runId: result.id, url: baseSnapshot } : undefined);
      addRun(result);
    }, t('角色生图失败，请查看生成历史'));
  };
  const addRun = (run: CharacterVisualRun) => {
    setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    setSelectedRunId(run.id);
    setSelectedCandidateId('');
    setHistoryRevision((value) => value + 1);
  };
  const openProjectUpdate = (imageUrl: string, targetReferenceId?: string) => {
    setProjectImage({ imageUrl, targetReferenceId });
    setAuxiliary('project');
  };
  const optimize = () => {
    if (!textModel || !prompt.trim()) return;
    void runAction('optimize', async (signal) => {
      const result = await polishCharacterVisualPrompt(prompt, target.projectId, signal, textModel.value);
      signal.throwIfAborted();
      setOptimizedPrompt(result);
    }, t('提示词优化失败，请检查文本模型配置'));
  };
  const adopt = (makePrimary: boolean) => {
    if (!candidate) return;
    void runAction('adopt', async (signal) => { await onAdopt(candidate, makePrimary, signal); },
      t('加入参考图失败，请检查角色是否已切换或参考图数量是否达到上限'));
  };
  const markReviewed = () => {
    const status = activeRun?.reviewStatus;
    if (!activeRun || !status) return;
    void runAction('review', async (signal) => {
      const confirmed = await confirmAction(status === 'prepared' ? '确认结束这条未提交的任务？'
        : '确认已在服务商核对原任务？继续生成可能产生新的费用。', { title: '核对原任务' });
      if (!confirmed || signal.aborted) return;
      await reviewCharacterVisualRun(target, activeRun.id, () => { signal.throwIfAborted(); assertCurrent?.(); }, status);
      if (!signal.aborted) setHistoryRevision((value) => value + 1);
    }, t('任务核对状态保存失败'));
  };
  const resume = () => {
    if (!activeRun?.recoverable) return;
    void runAction('resume', async (signal) => {
      const result = await resumeCharacterVisualRun(target, activeRun.id, signal);
      if (!signal.aborted) addRun(result);
    }, t('原任务查询或保存尚未完成，可继续查询'));
  };

  return (<>
    <ModalOverlay isOpen onClose={onClose} ariaLabel={t('角色形象工作台')} zIndex={280}
      className="ui-dialog-surface max-h-[calc(100vh-48px)] w-[min(1120px,calc(100vw-48px))]">
      <header className="ui-card__header shrink-0 justify-between">
        <div className="min-w-0">
          <h2 className="ui-card__title">{t('角色形象工作台')}</h2>
          {character.name && <p className="ui-card__desc truncate">{character.name}</p>}
        </div>
        <PopupCloseButton onClick={onClose} />
      </header>

      <div className="ui-stack min-h-0 overflow-y-auto p-3" onPaste={pasteImages}>
        {draftHistoryError && canResume && (
          <p role="status" className="text-xs text-canvas-text-secondary">{t('未保存角色的生成记录读取失败')}</p>
        )}
        {canResume && recoverableDrafts.length > 0 && onResumeDraft && (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={chosenDraftId} aria-label={t('未保存角色的生成记录')}
              placeholder={t('未保存角色的生成记录')} disabled={Boolean(pending)} onChange={setChosenDraftId}>
              {recoverableDrafts.map((item) => (
                <option key={item.target.characterId} value={item.target.characterId}>
                  {`${item.name || t('未命名角色')} · ${new Date(item.updatedAt).toLocaleString()}`}
                </option>
              ))}
            </Select>
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!chosenDraft || Boolean(pending)}
              onClick={() => {
                if (!chosenDraft) return;
                void runAction('adopt', async () => { onResumeDraft(chosenDraft.target, chosenDraft.name); },
                  t('角色已变化，请重新打开编辑器'));
              }}>
              {t('恢复生成草稿')}
            </button>
          </div>
        )}

        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <section className="ui-card ui-stack min-w-0 p-3" aria-label={t('候选图片')}>
            <div className={candidate && compareBase ? 'grid grid-cols-2 gap-2' : 'grid'}>
              {candidate && compareBase && (
                <figure>
                  <ViewportImage src={compareBase} alt={t('底图')} eager
                    className="h-52 w-full rounded-md bg-canvas-surface object-contain sm:h-64" />
                  <figcaption className="pt-1 text-xs text-canvas-text-muted">{t('底图')}</figcaption>
                </figure>
              )}
              {candidate ? (
                <figure>
                  <ViewportImage src={candidate.url} alt={t('候选图片')} eager
                    className="h-52 w-full rounded-md bg-canvas-surface object-contain sm:h-64" />
                  <figcaption className="pt-1 text-xs text-canvas-text-muted">{t(OPERATION_LABELS[candidate.operation])}</figcaption>
                </figure>
              ) : (
                <p className="grid min-h-40 place-items-center rounded-md border border-dashed border-canvas-border p-3 text-center text-sm text-canvas-text-muted">
                  {t(pending === 'generate' ? '生成中…' : candidateKey && candidatePreview?.key === candidateKey
                    ? '原候选图片文件不可用' : candidateKey ? '正在读取候选图片…' : '生成后的候选图片会显示在这里')}
                </p>
              )}
            </div>
            {previewCandidates.length > 1 && (
              <div className="flex gap-2 overflow-x-auto">
                {previewCandidates.map((item, index) => (
                  <button type="button" key={item.id} aria-label={t('候选图片 {number}', { number: index + 1 })}
                    aria-pressed={candidate?.id === item.id} onClick={() => setSelectedCandidateId(item.id)}
                    className={`ui-card ui-card--interactive shrink-0 ${candidate?.id === item.id ? 'is-selected' : ''}`}>
                    <ViewportImage src={item.url} alt="" className="h-16 w-16 object-cover" />
                  </button>
                ))}
              </div>
            )}
            {candidate && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={Boolean(pending)}
                  onClick={() => addInputs([{ id: candidate.id, label: t('候选图片'), url: candidate.url }])}>
                  {t('用作生成参考')}
                </button>
                <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={Boolean(pending) || !isTargetCurrent}
                  onClick={() => adopt(false)}>{t('加入参考图')}</button>
                <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={Boolean(pending) || !isTargetCurrent}
                  onClick={() => adopt(true)}>{t('加入并设为主视觉')}</button>
                <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={Boolean(pending) || !isTargetCurrent}
                  onClick={() => openProjectUpdate(candidate.url, character.referenceImages?.find((item) => item.id === `reference-generated-${candidate.id}`)?.id)}>
                  {t('识图更新设定')}
                </button>
              </div>
            )}
          </section>

          <section className="ui-card ui-stack p-3" aria-label={t('生成历史')}>
            <h3 className="ui-card__title">{t('生成历史')}</h3>
            {historyError && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-canvas-text-secondary" role="status">{t('生成历史读取失败')}</p>
                <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!isTargetCurrent}
                  onClick={() => setHistoryRevision((value) => value + 1)}>{t('重试')}</button>
              </div>
            )}
            {runs.length === 0 && !historyError && <p className="text-xs text-canvas-text-muted">{t('暂无生成记录')}</p>}
            <div className="flex max-h-52 flex-col gap-2 overflow-auto">
              {runs.map((run) => (
                <button type="button" key={run.id} aria-pressed={activeRun?.id === run.id}
                  className={`ui-card ui-card--interactive shrink-0 gap-1 p-2 text-left ${activeRun?.id === run.id ? 'is-selected' : ''}`}
                  onClick={() => { setSelectedRunId(run.id); setSelectedCandidateId(''); }}>
                  <span className="truncate text-xs">{t(CHARACTER_VISUAL_VIEWS.find((view) => view.id === run.viewSlot)?.label
                    ?? (run.model === 'local-composite' ? '多图定妆拼接' : OPERATION_LABELS[run.operation]))} · {t(STATUS_LABELS[run.status])}</span>
                  <time dateTime={new Date(run.createdAt).toISOString()} className="text-xs text-canvas-text-muted">
                    {new Date(run.createdAt).toLocaleString()}
                  </time>
                </button>
              ))}
            </div>
            {activeRun && (
              <div className="ui-stack ui-stack--tight text-xs text-canvas-text-secondary">
                <p className="break-all">{activeRun.model === 'local-composite' ? t('本机拼接') : activeRun.model}</p>
                {activeRun.maskedEdit && <p>{t('画笔蒙版')}</p>}
                {activeRun.references.map((reference) => reference.sourceUrl && <SourceLink key={reference.id} url={reference.sourceUrl} />)}
                {activeRun.error && <p role="status">{t(activeRun.error)}</p>}
                <details>
                  <summary className="cursor-pointer">{t('任务回执')}</summary>
                  <div className="ui-card ui-stack ui-stack--tight break-all p-2 text-xs">
                    <p><span className="text-canvas-text-muted">{t('本机任务 ID')}：</span>{activeRun.id}</p>
                    {activeRun.remoteTaskIds?.map((taskId) => <p key={taskId}>
                      <span className="text-canvas-text-muted">{t('服务商任务 ID')}：</span>{taskId}
                    </p>)}
                  </div>
                </details>
                {activeRun.recoverable && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm self-start"
                  disabled={Boolean(pending) || !isTargetCurrent} onClick={resume}>
                  {t(pending === 'resume' ? '正在查询原任务…' : '继续查询并保存')}
                </button>}
                {activeRun.reviewStatus && (
                  <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm self-start"
                    disabled={Boolean(pending) || !isTargetCurrent} onClick={markReviewed}>
                    {t(activeRun.reviewStatus === 'prepared' ? '结束跟踪' : '已核对原任务')}
                  </button>
                )}
                <details>
                  <summary className="cursor-pointer">{t('历史提示词')}</summary>
                  <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words p-2">{activeRun.prompt}</p>
                </details>
                {activeRun.submittedPrompt && activeRun.submittedPrompt !== activeRun.prompt && (
                  <details>
                    <summary className="cursor-pointer">{t('提交提示词')}</summary>
                    <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words p-2">{activeRun.submittedPrompt}</p>
                  </details>
                )}
                <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm self-start" disabled={Boolean(pending) || activeRun.model === 'local-composite'}
                  onClick={() => {
                    changeOperation(activeRun.operation);
                    setMask(undefined);
                    setNeedsMask(activeRun.maskedEdit === true);
                    const historicModel = listCharacterVisualModels(target, activeRun.operation, 0, config).find((item) => item.id === activeRun.model);
                    setChannel(historicModel?.channel ?? 'standard');
                    setPromptOverrides((current) => ({ ...current, [activeRun.operation]: activeRun.prompt }));
                    setModelId(activeRun.model);
                    setAspectRatio(activeRun.aspectRatio ?? '');
                    setImageSize(activeRun.imageSize ?? '');
                    setGenerationParameters({ imageQuality: activeRun.imageQuality, imageBackground: activeRun.imageBackground,
                      workflowInputs: activeRun.workflowInputs, runninghubModelParameters: activeRun.runninghubModelParameters });
                    const knownIds = activeRun.references.map((reference) => reference.id)
                      .filter((id) => referenceOptions.some((reference) => reference.id === id));
                    if (activeRun.operation === 'appearance') setAppearanceReferenceIds(knownIds);
                    else setBaseReferenceId(knownIds[0] ?? '');
                    setPurposes((current) => ({
                      ...current, ...Object.fromEntries(activeRun.references.map((item) => [item.id, item.purpose ?? ''])),
                    }));
                  }}>{t('载入历史提示词')}</button>
              </div>
            )}
          </section>
        </div>

        <section className="ui-card ui-stack p-3" aria-label={t('生图设置')}>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(OPERATION_LABELS) as CharacterVisualOperation[]).map((key) => (
              <button type="button" key={key} aria-pressed={operation === key && channel === 'standard'} disabled={Boolean(pending)}
                className={`ui-btn ui-btn--sm ${operation === key && channel === 'standard' ? 'ui-btn--primary' : 'ui-btn--secondary'}`}
                onClick={() => changeOperation(key)}>{t(OPERATION_LABELS[key])}</button>
            ))}
            <button type="button" className={`ui-btn ui-btn--sm ${channel === 'midjourney' ? 'ui-btn--primary' : 'ui-btn--secondary'}`}
              aria-pressed={channel === 'midjourney'} disabled={Boolean(pending)} onClick={() => {
                changeOperation('appearance');
                setChannel('midjourney');
              }}>{t('用 MJ 出图')}</button>
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={Boolean(pending) || !isTargetCurrent}
              onClick={() => setAuxiliary('multi')}>{t('多图定妆拼接')}</button>
            {projectReference && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={Boolean(pending) || !isTargetCurrent}
              onClick={() => openProjectUpdate(projectReference.url, projectReference.id)}>{t('识图与项目更新')}</button>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="ui-card__title">{t('参考图')}</h3>
            <div className="flex flex-wrap gap-2">
              {referenceIds.length > 0 && (
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={Boolean(pending)}
                  onClick={clearReferenceSelection}>{t('清空选择')}</button>
              )}
              <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={Boolean(pending)}
                onClick={() => uploadInput.current?.click()}>{t('上传图片')}</button>
              <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" aria-expanded={libraryOpen}
                disabled={Boolean(pending)} onClick={() => setLibraryOpen((value) => !value)}>{t('从素材库中选择')}</button>
              <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={Boolean(pending) || !isTargetCurrent}
                onClick={openXiaohongshu}>{t('小红书找参考')}</button>
            </div>
            <input ref={uploadInput} className="sr-only" tabIndex={-1} type="file" accept="image/*" multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                importFiles(files);
              }} />
          </div>
          {libraryOpen && isTargetCurrent && (
            <LibraryImages projectId={sourceProjectId === projectId ? libraryProjectId : undefined} onSelect={(item) => {
              if (pending) return;
              addInputs([item]);
              setLibraryOpen(false);
            }} />
          )}
          {referenceOptions.length > 0 ? (
            <div className="flex max-h-48 flex-wrap gap-2 overflow-auto">
              {referenceOptions.map((reference) => {
                const selected = referenceIds.includes(reference.id);
                return (
                  <div key={reference.id} className="ui-stack ui-stack--tight w-20 shrink-0">
                    <button type="button" aria-pressed={selected} title={reference.label}
                      disabled={Boolean(pending)} onClick={() => toggleReference(reference.id)}
                      className={`ui-card ui-card--interactive w-full gap-1 p-1 text-left text-xs ${selected ? 'is-selected' : ''}`}>
                      <ViewportImage src={reference.url} alt="" className="h-14 w-full rounded object-cover" />
                      <span className="w-full truncate px-1">{reference.label}</span>
                    </button>
                    {inputs.some((item) => item.id === reference.id) && (
                      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm"
                        aria-label={t('移除参考图')} disabled={Boolean(pending)} onClick={() => removeInput(reference.id)}>
                        {t('移除')}
                      </button>
                    )}
                    {reference.sourceUrl && <SourceLink url={reference.sourceUrl} />}
                    {reference.sourceUrl && !character.referenceImages?.some((item) => item.id === reference.id) && (
                      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={Boolean(pending)}
                        onClick={() => void runAction('adopt', async () => { onKeepReference(reference); },
                          t('加入参考图失败，请检查角色是否已切换或参考图数量是否达到上限'))}>{t('加入参考图')}</button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : <p className="text-xs text-canvas-text-muted">{t('可上传图片、从素材库选择，或在此窗口粘贴图片。')}</p>}
          {references.length > 0 && (
            <ol className="flex flex-wrap gap-2" aria-label={t('本次参考图顺序')}>
              {references.map((reference, index) => (
                <li key={reference.id} className="flex max-w-full items-center gap-2 rounded-lg border border-canvas-border px-2 text-xs">
                  <span className="truncate">{t('图片 {number}', { number: index + 1 })} · {reference.label}</span>
                  <Select value={reference.purpose ?? ''} size="sm" aria-label={t('标注参考图用途')} disabled={Boolean(pending)}
                    onChange={(value) => setPurposes((current) => ({ ...current, [reference.id]: value }))}>
                    <option value="">{t('标注用途')}</option>
                    {PURPOSES.map((purpose) => <option key={purpose} value={purpose}>{t(purpose)}</option>)}
                  </Select>
                </li>
              ))}
            </ol>
          )}
          {operation === 'edit' && base && <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={Boolean(pending) || !models.some((item) => item.supportsMask)}
              onClick={() => void runAction('import', async (signal) => {
                const snapshot = await freezeCharacterVisualMaskBase(base.url, signal);
                setMaskBase(snapshot);
                setAuxiliary('mask');
              }, t('图片读取失败'))}>{t(activeMask ? '编辑画笔蒙版' : '画笔蒙版')}</button>
            {(activeMask || needsMask) && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={Boolean(pending)}
              onClick={() => { setMask(undefined); setNeedsMask(false); }}>{t('改用文字描述')}</button>}
          </div>}
          <label className="ui-stack ui-stack--tight">
            <span className="ui-label">{t(operation === 'edit' ? '修改描述' : '提示词')}</span>
            <textarea className="ui-textarea min-h-24 w-full resize-y" rows={4} maxLength={30000}
              value={prompt} disabled={Boolean(pending)}
              placeholder={operation === 'edit' ? t('说明要改哪里、改成什么样，以及希望保留的部分') : undefined}
              onChange={(event) => patchPrompt(event.target.value)} />
          </label>
          <div className="ui-stack ui-stack--tight">
            <CharacterVisualGenerationSettings models={models} model={model}
              values={{ ...generationValues, aspectRatio: ratio, imageSize: size }} disabled={Boolean(pending) || !isTargetCurrent}
              onSelect={(option) => {
                setModelId(option.id);
                setAspectRatio(ratio);
                setImageSize(size);
                setError('');
              }} onChange={(patch) => {
                if (patch.aspectRatio !== undefined) setAspectRatio(patch.aspectRatio);
                if (patch.imageSize !== undefined) setImageSize(patch.imageSize);
                setGenerationParameters((current) => ({ ...current, ...patch }));
              }} />
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm self-start" aria-expanded={optimizeOpen}
              disabled={Boolean(pending) || !isTargetCurrent} onClick={() => setOptimizeOpen((value) => !value)}>{t('优化提示词')}</button>
          </div>
          {optimizeOpen && (
            <div className="ui-card ui-stack p-2">
              <div className="flex flex-wrap gap-2">
                <Select value={textModel?.value ?? ''} aria-label={t('文本模型')} placeholder={t('选择文本模型')}
                  disabled={Boolean(pending) || !textModels.length} onChange={setTextModelId}>
                  {textModels.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </Select>
                <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm"
                  disabled={Boolean(pending) || !textModel || !prompt.trim() || !isTargetCurrent}
                  onClick={optimize}>{t(pending === 'optimize' ? '优化中…' : '生成优化建议')}</button>
              </div>
              {optimizedPrompt && (
                <>
                  <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm">{optimizedPrompt}</p>
                  <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm self-start"
                    disabled={Boolean(pending) || !isTargetCurrent} onClick={() => patchPrompt(optimizedPrompt)}>{t('采用优化提示词')}</button>
                </>
              )}
            </div>
          )}
        </section>
      </div>
      <footer className="ui-card__footer flex flex-wrap items-center justify-between gap-2">
        <div aria-live="polite" className="min-w-0 text-xs text-canvas-text-secondary">
          {error ? <p role="alert">{error}</p> : availableMessage}
        </div>
        <div className="flex gap-2">
          <button type="button" className="ui-btn ui-btn--secondary" onClick={onClose}>{t('返回角色编辑')}</button>
          <button type="button" className="ui-btn ui-btn--primary" onClick={generate}
            disabled={Boolean(pending) || !prompt.trim() || Boolean(availableMessage)}>
            {t(pending === 'generate' ? '生成中…' : '生成候选图')}
          </button>
        </div>
      </footer>
    </ModalOverlay>
    {auxiliary && <LazyLoadBoundary label="角色形象工作台" resetKey={auxiliary}>
      <Suspense fallback={<LazyLoadFallback label="角色形象工作台" />}>
        {auxiliary === 'mask' && base && maskBase && <MattingEditor key={base.id} isOpen imageUrl={maskBase.url}
          initialMask={activeMask && activeMask.baseDigest === maskBase.digest ? activeMask.overlayUrl : undefined}
          onClose={() => { setAuxiliary(undefined); setMaskBase(undefined); }} onSave={(overlayUrl) => {
            setAuxiliary(undefined);
            setMaskBase(undefined);
            void runAction('import', async (signal) => {
              const pngDataUrl = await prepareCharacterVisualMask(maskBase.url, overlayUrl, signal);
              setMask({ referenceId: base.id, baseUrl: base.url, baseDigest: maskBase.digest, overlayUrl, pngDataUrl });
              setNeedsMask(true);
              if (!model?.supportsMask) setModelId(models.find((item) => item.supportsMask)?.id ?? '');
            }, t('蒙版处理失败，请涂抹有效区域'));
          }} />}
        {auxiliary === 'multi' && <CharacterVisualMultiView target={target} character={character} isNew={isNew}
          models={listCharacterVisualModels(target, 'appearance', 0, config)} references={references} runs={runs} assertCurrent={assertCurrent}
          onGenerated={addRun} onComposite={(result) => {
            setSelectedRunId(result.id.slice(0, 36));
            setSelectedCandidateId(result.id);
            setHistoryRevision((value) => value + 1);
            setAuxiliary(undefined);
          }} onClose={() => setAuxiliary(undefined)} />}
        {auxiliary === 'project' && projectImage && <CharacterVisualProjectUpdate character={character} scope={scope} {...projectImage}
          assertCurrent={assertCurrent} onApplyFields={onApplyFields} onClose={() => setAuxiliary(undefined)} />}
      </Suspense>
    </LazyLoadBoundary>}
  </>);
}
