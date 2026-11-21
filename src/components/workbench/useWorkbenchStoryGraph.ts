import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { t as translate } from '../../i18n';
import { resolveAssistantModel } from '../../services/ai/assistantStream';
import { buildChatModelCatalog } from '../../services/chat/detachedChatSyncController';
import { sanitizeDomainText } from '../../services/chat/subAgentMaterials';
import { configValuesEqual } from '../../services/configPatch';
import { hasUnsettledEpisodeEditorSession, isEpisodeEditorWriteLocked } from '../../services/episodeEditorSessionService';
import { buildStoryGraphCandidatePatch, extractStoryGraphCandidates } from '../../services/storyGraphExtractionService';
import { applyStoryGraphPatch, createEmptyStoryGraph, hashStoryGraphSource, projectStoryGraphView,
  validateStoryGraphEvidence } from '../../services/storyGraphService';
import { needsNativeEpisodeContent } from '../../store/nativeProjectView';
import { listEpisodes, seriesOwnerId } from '../../store/store.utils';
import { useAppStore } from '../../store/useAppStore';
import type { CanvasProject } from '../../types';
import type { DramaAssetLibrary } from '../../types/dramaAssets';
import type { ScriptWorkbenchAction, ScriptWorkbenchSnapshot, WorkbenchEditorTab } from '../../types/scriptWorkbench';
import type { StoryGraphAssetOption, StoryGraphCandidates, StoryGraphDetail, StoryGraphEvidence, StoryGraphExtractionState,
  StoryGraphExtractRequest, StoryGraphFilter, StoryGraphPatch, StoryGraphSource } from '../../types/storyGraph';
import { STORY_GRAPH_EDGE_KINDS, STORY_GRAPH_NODE_KINDS } from '../../types/storyGraph';

type StoryGraphAction = Extract<ScriptWorkbenchAction, { type: `story_graph_${string}` }>;

interface WorkbenchGraphEditor {
  hasDraftChanges: (episode: CanvasProject) => boolean;
  currentDraftIsDirty: () => boolean;
  windowHandoffPending: () => boolean;
  selectBuiltinOutline: () => Promise<unknown> | undefined;
  revealSource: (episodeId: string, part: StoryGraphEvidence['part']) => void;
}

interface WorkbenchStoryGraphOptions {
  t: typeof translate;
  isOpen: boolean;
  sessionId: string;
  seriesId: string | null;
  series: CanvasProject | null;
  selectedEpisodeRef: RefObject<string | null>;
  currentEpisodeId: string | undefined;
  activeTab: WorkbenchEditorTab;
  contextReady: boolean;
  dramaAssets: DramaAssetLibrary;
}

export function useWorkbenchStoryGraph({
  t, isOpen, sessionId, seriesId, series, selectedEpisodeRef, currentEpisodeId, activeTab, contextReady, dramaAssets,
}: WorkbenchStoryGraphOptions) {
  const [emptyStoryGraph] = useState(() => createEmptyStoryGraph());
  const [graphFilter, setGraphFilter] = useState<StoryGraphFilter>();
  const [graphExtraction, setGraphExtraction] = useState<StoryGraphExtractionState>({ status: 'idle', completed: 0, total: 0 });
  const [sourceLocation, setSourceLocation] = useState<ScriptWorkbenchSnapshot['sourceLocation']>();
  const sourceLocationSequence = useRef(0);
  const graphController = useRef<AbortController | null>(null);
  const graphRunId = useRef<string | undefined>(undefined);
  const graphGeneration = useRef(0);
  const graphCandidate = useRef<StoryGraphCandidates | null>(null);
  const graphContinuation = useRef<{ request: StoryGraphExtractRequest; candidate: StoryGraphCandidates; epoch: number } | null>(null);
  const graphEditorLease = useRef<{ graphId: string; epoch: number } | null>(null);
  const graphWritesInFlight = useRef(0);
  const [graphEditorOpen, setGraphEditorOpen] = useState(false);
  useEffect(() => () => {
    graphGeneration.current += 1;
    graphController.current?.abort();
    graphCandidate.current = null;
    graphEditorLease.current = null;
  }, [seriesId, isOpen]);

  // 编辑会话可在后续渲染之后才被查询或丢弃，此处始终读取当时的租约。
  const session = useMemo(() => ({
    isEditing: () => graphEditorLease.current !== null,
    isWriting: () => graphWritesInFlight.current > 0,
    hasPendingExtraction: () => !!(graphController.current || graphCandidate.current),
    captureEditorRelease: () => {
      const lease = graphEditorLease.current;
      return () => {
        if (lease && graphEditorLease.current === lease) {
          graphEditorLease.current = null;
          setGraphEditorOpen(false);
        }
      };
    },
  }), []);

  const readGraphContext = () => {
    const state = useAppStore.getState();
    const owner = state.projects.find((project) => project.id === seriesId);
    if (!isOpen || !owner || !state.currentProjectId || state.projectLoadStatus !== 'ready'
      || state.isCreatingProject || state.isReturningToStartPage || state.switchingProjectName !== null
      || seriesOwnerId(state.projects, state.currentProjectId) !== seriesId) {
      throw new Error(t('关系图所在剧集已变化，请回到原剧集重试'));
    }
    return { state, owner, graph: owner.series?.storyGraph ?? createEmptyStoryGraph(`${emptyStoryGraph.id}-${owner.exchangeEpoch ?? 0}`) };
  };
  const readGraphSource = (episodeId: string, part: 'outline' | 'script') => {
    const { state, owner } = readGraphContext();
    if (part !== 'outline' && part !== 'script') throw new Error(t('关系图来源类型无效'));
    const episode = listEpisodes(state.projects, owner.id).find((entry) => entry.id === episodeId);
    if (!episode) throw new Error(t('关系图来源分集已删除或不属于本剧'));
    if (needsNativeEpisodeContent(episode)) throw new Error(t('关系图来源分集正文尚未加载，请重新读取'));
    return { episode, text: (part === 'outline' ? episode.episodeOutline : episode.episodeScript) ?? '' };
  };
  const loadGraphSource = async (episodeId: string, part: 'outline' | 'script') => {
    const { owner } = readGraphContext();
    const episode = await useAppStore.getState().loadEpisodeCreative(episodeId);
    if (episode.parentId !== owner.id) throw new Error(t('关系图来源分集已删除或不属于本剧'));
    return readGraphSource(episodeId, part);
  };
  const modelFingerprint = async (modelId: string) => {
    const { state } = readGraphContext();
    const model = buildChatModelCatalog(state).assistantModelGroups.flatMap((group) => group.models).find((item) => item.value === modelId);
    const resolved = resolveAssistantModel(seriesId, modelId);
    if (!model || model.provider === 'comfyui' || !resolved) throw new Error(t('请选择可用的文本模型'));
    const fingerprint = await hashStoryGraphSource(JSON.stringify(resolved));
    readGraphContext();
    if (!configValuesEqual(resolved, resolveAssistantModel(seriesId, modelId))) throw new Error(t('文本模型配置已变化，请重新选择'));
    return { model, fingerprint };
  };
  const graphScopeGuard = (epoch: number, selectedId: string | null) => {
    const { owner } = readGraphContext();
    if ((owner.exchangeEpoch ?? 0) !== epoch || selectedEpisodeRef.current !== selectedId) {
      throw new Error(t('关系图会话或分集已变化，请核对后重试'));
    }
  };
  const validateGraphPatch = async (patch: StoryGraphPatch) => {
    const { state, owner, graph } = readGraphContext();
    const episodeIds = new Set(listEpisodes(state.projects, owner.id).map((entry) => entry.id));
    const checkedSources: Array<Pick<StoryGraphSource, 'episodeId' | 'part' | 'text'>> = [];
    for (const item of [...(patch.upsertNodes ?? []), ...(patch.upsertEdges ?? [])]) {
      const previous = 'source' in item ? graph.edges.find((edge) => edge.id === item.id) : graph.nodes.find((node) => node.id === item.id);
      if (item.episodeIds.some((id) => !episodeIds.has(id) && !previous?.episodeIds.includes(id))) throw new Error(t('关系图引用了本剧以外的分集'));
      if ('source' in item) {
        for (const key of ['fromEpisodeId', 'toEpisodeId'] as const) {
          const oldValue = previous && 'source' in previous ? previous[key] : undefined;
          if (item[key] && !episodeIds.has(item[key]) && item[key] !== oldValue) throw new Error(t('关系图引用了本剧以外的分集'));
        }
      }
      for (const evidence of item.evidence) {
        if (previous?.evidence.some((entry) => configValuesEqual(entry, evidence))) continue;
        const { text } = await loadGraphSource(evidence.episodeId, evidence.part);
        const source: StoryGraphSource = { episodeId: evidence.episodeId, part: evidence.part, text, sourceHash: await hashStoryGraphSource(text) };
        if (!validateStoryGraphEvidence(evidence, source)) throw new Error(t('原文证据已变化，请重新绑定'));
        checkedSources.push(source);
      }
      if ('asset' in item && item.asset) {
        const oldAsset = previous && 'asset' in previous ? previous.asset : undefined;
        if (!configValuesEqual(oldAsset, item.asset)) {
          const pool = item.asset.kind === 'character' ? state.dramaAssets.characters : item.asset.kind === 'scene' ? state.dramaAssets.scenes : state.dramaAssets.props;
          if (!pool.some((asset) => asset.id === item.asset?.id)) throw new Error(t('绑定的正式资产已删除或不属于本剧'));
        }
      }
    }
    return () => {
      for (const source of checkedSources) {
        if (readGraphSource(source.episodeId, source.part).text !== source.text) throw new Error(t('原文证据已变化，请重新绑定'));
      }
    };
  };
  const commitGraphPatch = async (patch: StoryGraphPatch, expectedRevision: number, assertCandidate?: () => void) => {
    const { owner, graph } = readGraphContext();
    const epoch = owner.exchangeEpoch ?? 0;
    const selectedId = selectedEpisodeRef.current;
    const lease = graphEditorLease.current;
    if (lease && (lease.graphId !== graph.id || lease.epoch !== epoch)) throw new Error(t('关系图版本已变化，请重新打开详情'));
    if (patch.graphId && patch.graphId !== graph.id) throw new Error(t('关系图版本已变化，请刷新后重试'));
    const boundedPatch = { ...patch, graphId: graph.id };
    applyStoryGraphPatch(graph, boundedPatch, expectedRevision);
    graphWritesInFlight.current += 1;
    try {
      const assertSources = await validateGraphPatch(boundedPatch);
      graphScopeGuard(epoch, selectedId);
      assertSources();
      assertCandidate?.();
      await useAppStore.getState().updateStoryGraph(owner.id, boundedPatch, expectedRevision, {
        expectedExchangeEpoch: epoch, assertCurrent: () => { graphScopeGuard(epoch, selectedId); assertSources(); assertCandidate?.(); },
      });
      return true;
    } finally { graphWritesInFlight.current -= 1; }
  };
  const startGraphExtraction = async (
    input: StoryGraphExtractRequest,
    hasDraftChanges: (episode: CanvasProject) => boolean,
  ) => {
    if (graphEditorLease.current || graphWritesInFlight.current > 0) throw new Error(t('请先保存或关闭关系图详情'));
    if (graphController.current || graphCandidate.current) throw new Error(t('请先取消提取，或采纳、丢弃当前候选'));
    const { owner, graph } = readGraphContext();
    if (!Array.isArray(input.episodeIds) || input.episodeIds.length < 1 || input.episodeIds.length > 100
      || !Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 2
      || input.parts.some((part) => part !== 'outline' && part !== 'script')
      || typeof input.modelId !== 'string' || input.modelId.length > 256
      || (input.startChunk !== undefined && (!Number.isSafeInteger(input.startChunk) || input.startChunk < 0))) {
      throw new Error(t('关系图提取参数无效'));
    }
    const epoch = owner.exchangeEpoch ?? 0;
    const controller = new AbortController();
    graphController.current = controller;
    const generation = ++graphGeneration.current;
    const runId = crypto.randomUUID();
    graphRunId.current = runId;
    const assertScope = () => {
      controller.signal.throwIfAborted();
      if (graphGeneration.current !== generation) throw new Error(t('关系图提取已取消'));
      const current = readGraphContext();
      if ((current.owner.exchangeEpoch ?? 0) !== epoch) throw new Error(t('关系图会话或分集已变化，请核对后重试'));
      const live = current.graph;
      if (live.id !== graph.id || live.revision !== graph.revision) throw new Error(t('关系图版本已变化，请重新提取'));
    };
    setGraphExtraction({ status: 'running', runId, completed: 0, total: 0 });
    try {
      const capturedModel = await modelFingerprint(input.modelId);
      assertScope();
      const sources: StoryGraphSource[] = [];
      for (const episodeId of [...new Set(input.episodeIds)]) {
        for (const part of [...new Set(input.parts)]) {
          const { episode, text } = await loadGraphSource(episodeId, part);
          if (hasDraftChanges(episode) || isEpisodeEditorWriteLocked(episodeId)
            || hasUnsettledEpisodeEditorSession(episodeId)) throw new Error(t('请先保存所选分集的稿件，再提取关系图'));
          if (text.trim()) sources.push({ episodeId, part, text, sourceHash: await hashStoryGraphSource(text) });
          assertScope();
        }
      }
      const bindings = sources.map(({ episodeId, part, sourceHash }) => ({ episodeId, part, sourceHash }));
      const continuation = graphContinuation.current;
      if ((input.startChunk ?? 0) > 0 && (!continuation || continuation.epoch !== epoch
        || continuation.candidate.nextChunk !== input.startChunk || continuation.candidate.graphId !== graph.id
        || continuation.candidate.modelFingerprint !== capturedModel.fingerprint
        || !configValuesEqual(continuation.candidate.sourceBindings, bindings)
        || continuation.request.modelId !== input.modelId)) throw new Error(t('续批材料或模型已变化，请从第一批重新提取'));
      const assertCurrent = async () => {
        assertScope();
        for (const source of sources) if (readGraphSource(source.episodeId, source.part).text !== source.text) throw new Error(t('稿件来源已变化，请重新提取'));
        if ((await modelFingerprint(input.modelId)).fingerprint !== capturedModel.fingerprint) throw new Error(t('文本模型配置已变化，请重新选择'));
        assertScope();
        for (const source of sources) if (readGraphSource(source.episodeId, source.part).text !== source.text) throw new Error(t('稿件来源已变化，请重新提取'));
      };
      await assertCurrent();
      const candidate = await extractStoryGraphCandidates({ seriesId: owner.id, sessionId, graphId: graph.id,
        graphRevision: graph.revision, model: { model: capturedModel.model.value, provider: capturedModel.model.provider, fingerprint: capturedModel.fingerprint },
        sources, startChunk: input.startChunk }, { signal: controller.signal, assertCurrent,
        onProgress: (progress) => {
          if (graphGeneration.current === generation) setGraphExtraction({ status: 'running', runId, completed: progress.completedCalls, total: progress.totalCalls });
        },
      });
      await assertCurrent();
      graphCandidate.current = candidate;
      graphContinuation.current = { request: structuredClone(input), candidate, epoch };
      setGraphExtraction({ status: 'ready', runId, completed: candidate.callsUsed, total: candidate.callsUsed, candidate,
        ...(candidate.hasMore && candidate.nextChunk !== undefined ? { continuation: { request: structuredClone(input), nextChunk: candidate.nextChunk, totalChunks: candidate.totalChunks } } : {}) });
    } catch (cause) {
      const error = sanitizeDomainText(cause instanceof Error ? cause.message : t('关系图提取失败')).slice(0, 300);
      if (graphGeneration.current === generation) setGraphExtraction((previous) => ({ ...previous,
        status: controller.signal.aborted ? 'cancelled' : 'failed', runId, error: controller.signal.aborted ? undefined : error }));
      if (controller.signal.aborted) return false;
      throw new Error(error, { cause });
    } finally {
      if (graphController.current === controller) graphController.current = null;
    }
    return true;
  };

  const effectiveGraphFilter = useMemo<StoryGraphFilter>(() => graphFilter ?? { episodeIds: currentEpisodeId ? [currentEpisodeId] : [] }, [graphFilter, currentEpisodeId]);
  const liveStoryGraph = useMemo(() => series?.series?.storyGraph
    ?? createEmptyStoryGraph(`${emptyStoryGraph.id}-${series?.exchangeEpoch ?? 0}`), [series?.series?.storyGraph, series?.exchangeEpoch, emptyStoryGraph.id]);
  const graphView = useMemo(() => activeTab === 'story-graph'
    ? projectStoryGraphView(liveStoryGraph, effectiveGraphFilter) : undefined, [activeTab, liveStoryGraph, effectiveGraphFilter]);
  const graphAssets = useMemo<StoryGraphAssetOption[]>(() => [
    ...dramaAssets.characters.map((asset) => ({ kind: 'character' as const, id: asset.id, label: asset.name })),
    ...dramaAssets.scenes.map((asset) => ({ kind: 'scene' as const, id: asset.id, label: asset.name })),
    ...dramaAssets.props.map((asset) => ({ kind: 'prop' as const, id: asset.id, label: asset.name })),
  ].slice(0, 500), [dramaAssets]);

  const handleAction = async (action: StoryGraphAction, editor: WorkbenchGraphEditor): Promise<unknown> => {
    switch (action.type) {
      case 'story_graph_filter': {
        const { owner, graph } = readGraphContext();
        const input = action.filter;
        const knownEpisodes = new Set(listEpisodes(useAppStore.getState().projects, owner.id).map((episode) => episode.id));
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 120))
          || (input.episodeIds !== undefined && (!Array.isArray(input.episodeIds) || input.episodeIds.length > 100 || input.episodeIds.some((id) => !knownEpisodes.has(id))))
          || (input.nodeKinds !== undefined && (!Array.isArray(input.nodeKinds) || input.nodeKinds.length > 7 || input.nodeKinds.some((kind) => !STORY_GRAPH_NODE_KINDS.includes(kind))))
          || (input.edgeKinds !== undefined && (!Array.isArray(input.edgeKinds) || input.edgeKinds.length > 10 || input.edgeKinds.some((kind) => !STORY_GRAPH_EDGE_KINDS.includes(kind))))
          || (input.focusNodeId !== undefined && (typeof input.focusNodeId !== 'string' || !graph.nodes.some((node) => node.id === input.focusNodeId)))) {
          throw new Error(t('关系图筛选条件无效'));
        }
        setGraphFilter({ episodeIds: input.episodeIds, search: input.search, nodeKinds: input.nodeKinds,
          edgeKinds: input.edgeKinds, focusNodeId: input.focusNodeId, neighbors: input.neighbors === true });
        return true;
      }
      case 'story_graph_detail': {
        const { state, graph } = readGraphContext();
        const item = action.selection?.kind === 'node' ? graph.nodes.find((node) => node.id === action.selection.id)
          : action.selection?.kind === 'edge' ? graph.edges.find((edge) => edge.id === action.selection.id) : undefined;
        if (!item) throw new Error(t('关系图条目已删除或不在当前图中'));
        const evidenceStatuses: StoryGraphDetail['evidenceStatuses'] = [];
        for (const evidence of item.evidence) {
          try {
            const { text } = await loadGraphSource(evidence.episodeId, evidence.part);
            const hash = await hashStoryGraphSource(text);
            const currentText = readGraphSource(evidence.episodeId, evidence.part).text;
            evidenceStatuses.push(text === currentText && validateStoryGraphEvidence(evidence, { ...evidence, text, sourceHash: hash }) ? 'current' : 'changed');
          } catch { evidenceStatuses.push('missing'); }
        }
        const current = readGraphContext().graph;
        if (current.id !== graph.id || current.revision !== graph.revision) throw new Error(t('关系图版本已变化，请重新选择条目'));
        let assetAvailable: boolean | undefined;
        if ('asset' in item && item.asset) {
          const pool = item.asset.kind === 'character' ? state.dramaAssets.characters : item.asset.kind === 'scene' ? state.dramaAssets.scenes : state.dramaAssets.props;
          assetAvailable = pool.some((asset) => asset.id === item.asset?.id);
        }
        return { item: structuredClone(item), evidenceStatuses, assetAvailable } satisfies StoryGraphDetail;
      }
      case 'story_graph_patch': return commitGraphPatch(action.patch, action.expectedRevision);
      case 'story_graph_resolve_evidence': {
        const query = action.query;
        if (!query || typeof query.quote !== 'string' || !query.quote.trim() || query.quote.length > 240) throw new Error(t('请输入不超过 240 字的原文摘录'));
        const { owner } = readGraphContext();
        const epoch = owner.exchangeEpoch ?? 0;
        const selectedId = selectedEpisodeRef.current;
        const { text } = await loadGraphSource(query.episodeId, query.part);
        const start = text.indexOf(query.quote);
        if (start < 0 || text.indexOf(query.quote, start + 1) >= 0) throw new Error(t('摘录需在已保存稿件中唯一匹配，请调整摘录'));
        const sourceHash = await hashStoryGraphSource(text);
        graphScopeGuard(epoch, selectedId);
        if (readGraphSource(query.episodeId, query.part).text !== text) throw new Error(t('原文证据已变化，请重新绑定'));
        return { episodeId: query.episodeId, part: query.part, sourceHash, start, end: start + query.quote.length, quote: query.quote } satisfies StoryGraphEvidence;
      }
      case 'story_graph_locate': {
        if (graphEditorLease.current) throw new Error(t('请先保存或关闭关系图详情，再查看出处'));
        if (editor.currentDraftIsDirty()) throw new Error(t('请先保存或处理当前草稿，再查看原文出处'));
        const evidence = action.evidence;
        const { owner } = readGraphContext();
        const epoch = owner.exchangeEpoch ?? 0;
        const selectedId = selectedEpisodeRef.current;
        const { text, episode } = await loadGraphSource(evidence.episodeId, evidence.part);
        if (editor.hasDraftChanges(episode)
          || isEpisodeEditorWriteLocked(evidence.episodeId) || hasUnsettledEpisodeEditorSession(evidence.episodeId)) {
          throw new Error(t('目标分集还有未处理的修改，请先保存后查看出处'));
        }
        const sourceHash = await hashStoryGraphSource(text);
        graphScopeGuard(epoch, selectedId);
        if (readGraphSource(evidence.episodeId, evidence.part).text !== text
          || !validateStoryGraphEvidence(evidence, { ...evidence, text, sourceHash })) throw new Error(t('原文来源已变化，请先重新绑定证据'));
        if (evidence.part === 'outline') await editor.selectBuiltinOutline();
        editor.revealSource(evidence.episodeId, evidence.part);
        sourceLocationSequence.current += 1;
        setSourceLocation({ ...evidence, sequence: sourceLocationSequence.current });
        return true;
      }
      case 'story_graph_extract': return startGraphExtraction(action.request, editor.hasDraftChanges);
      case 'story_graph_editor': {
        if (typeof action.open !== 'boolean' || typeof action.graphId !== 'string'
          || !Number.isSafeInteger(action.expectedRevision) || !Number.isSafeInteger(action.epoch)) throw new Error(t('关系图版本已变化，请重新打开详情'));
        if (action.open) {
          if (editor.windowHandoffPending()) throw new Error(t('工作台窗口正在交接，请稍后打开详情'));
          const { owner, graph } = readGraphContext();
          if (typeof action.graphId !== 'string' || action.graphId !== graph.id || action.expectedRevision !== graph.revision
            || action.epoch !== (owner.exchangeEpoch ?? 0)) throw new Error(t('关系图版本已变化，请重新打开详情'));
          graphEditorLease.current = { graphId: graph.id, epoch: owner.exchangeEpoch ?? 0 };
          setGraphEditorOpen(true);
        } else {
          const lease = graphEditorLease.current;
          if (lease && (lease.graphId !== action.graphId || lease.epoch !== action.epoch)) throw new Error(t('关系图编辑会话已变化，请重新核对'));
          graphEditorLease.current = null; setGraphEditorOpen(false);
        }
        return true;
      }
      case 'story_graph_cancel': {
        if (!graphController.current || !action.runId || action.runId !== graphRunId.current) throw new Error(t('关系图提取已结束，请核对最新候选'));
        graphGeneration.current += 1;
        graphController.current?.abort(); graphController.current = null;
        setGraphExtraction((previous) => ({ status: 'cancelled', runId: previous.runId, completed: previous.completed, total: previous.total, continuation: previous.continuation }));
        return true;
      }
      case 'story_graph_discard': {
        if (graphController.current) throw new Error(t('请先取消正在执行的关系图提取'));
        if (graphCandidate.current && action.candidateId !== graphCandidate.current.id) throw new Error(t('关系图候选已变化，请重新核对'));
        graphCandidate.current = null;
        setGraphExtraction((previous) => ({ status: 'idle', runId: previous.runId, completed: 0, total: 0, continuation: previous.continuation }));
        return true;
      }
      case 'story_graph_adopt': {
        const candidate = graphCandidate.current;
        const { owner, graph } = readGraphContext();
        if (!candidate || candidate.id !== action.candidateId || candidate.seriesId !== owner.id || candidate.sessionId !== sessionId
          || candidate.graphId !== graph.id || candidate.graphRevision !== graph.revision) throw new Error(t('关系图候选已变化，请重新核对'));
        const epoch = owner.exchangeEpoch ?? 0;
        if (graphContinuation.current?.candidate.id !== candidate.id || graphContinuation.current.epoch !== epoch) throw new Error(t('关系图候选已变化，请重新核对'));
        const sourceTexts = new Map<string, string>();
        for (const binding of candidate.sourceBindings) {
          const { text } = await loadGraphSource(binding.episodeId, binding.part);
          if (await hashStoryGraphSource(text) !== binding.sourceHash) throw new Error(t('候选来源已变化，请重新提取'));
          sourceTexts.set(`${binding.episodeId}:${binding.part}`, text);
        }
        const patch = buildStoryGraphCandidatePatch(graph, candidate, action.selection);
        await commitGraphPatch(patch, graph.revision, () => {
          if (graphCandidate.current !== candidate || (readGraphContext().owner.exchangeEpoch ?? 0) !== epoch) throw new Error(t('关系图候选已变化，请重新核对'));
          for (const binding of candidate.sourceBindings) {
            const source = readGraphSource(binding.episodeId, binding.part);
            if (source.text !== sourceTexts.get(`${binding.episodeId}:${binding.part}`)) throw new Error(t('候选来源已变化，请重新提取'));
          }
        });
        graphCandidate.current = null;
        setGraphExtraction((previous) => ({ status: 'idle', runId: previous.runId, completed: 0, total: 0, continuation: previous.continuation }));
        return true;
      }
    }
  };

  return {
    session,
    handleAction,
    clearSourceLocation: () => setSourceLocation(undefined),
    snapshot: {
      hasSavedStoryGraph: contextReady && Boolean(series?.series?.storyGraph?.nodes.length),
      storyGraphView: graphView, storyGraphFilter: effectiveGraphFilter,
      storyGraphAssets: graphView && contextReady ? graphAssets : undefined,
      storyGraphExtraction: graphView ? graphExtraction : undefined, storyGraphEditorOpen: graphEditorOpen, sourceLocation,
    },
  };
}
