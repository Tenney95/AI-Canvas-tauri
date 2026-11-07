import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, type Connection, type NodeChange, type ReactFlowInstance } from '@xyflow/react';
// 独立工作台不加载主画布；图谱需自行声明 React Flow 的基础布局样式。
import '@xyflow/react/dist/style.css';
import { useReducedMotion } from 'framer-motion';
import { useT } from '../../i18n';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import type { CanvasProject, ModelGroup } from '../../types';
import type { StoryGraphAssetOption, StoryGraphCandidateSelection, StoryGraphCandidates, StoryGraphDetail, StoryGraphEdge,
  StoryGraphEdgeKind, StoryGraphEvidence, StoryGraphEvidenceQuery, StoryGraphExtractionState, StoryGraphExtractRequest, StoryGraphFilter,
  StoryGraphNode as StoryRecord, StoryGraphNodeKind, StoryGraphPatch, StoryGraphPosition, StoryGraphPresentation, StoryGraphSelection, StoryGraphView } from '../../types/storyGraph';
import { STORY_GRAPH_NODE_KINDS, STORY_GRAPH_EDGE_KINDS } from '../../types/storyGraph';
import { layoutStoryGraphConstellation, STORY_GRAPH_NODE_LABELS, STORY_GRAPH_EDGE_LABELS, STORY_GRAPH_CERTAINTY_LABELS } from '../../services/storyGraphService';
import Select from '../shared/Select';
import Tabs from '../shared/Tabs';
import ModalOverlay from '../shared/ModalOverlay';
import ModelSelector from '../nodes/shared/ModelSelector';
import StoryGraphNode, { type StoryGraphFlowNode } from './StoryGraphNode';
import StoryGraphRelationEdge, { type StoryGraphFlowEdge } from './StoryGraphEdge';
import StoryGraphDetails from './StoryGraphDetails';
import StoryGraphTimeline from './StoryGraphTimeline';

export interface StoryGraphPanelProps {
  view: StoryGraphView;
  filter?: StoryGraphFilter;
  episodes: Array<Pick<CanvasProject, 'id' | 'name' | 'episodeNo'>>;
  currentEpisodeId?: string;
  assets: StoryGraphAssetOption[];
  modelGroups: ModelGroup[];
  theme?: 'dark' | 'light';
  extraction?: StoryGraphExtractionState;
  disabled?: boolean;
  onFilterChange: (filter: StoryGraphFilter) => Promise<unknown>;
  onReadDetail: (selection: StoryGraphSelection) => Promise<StoryGraphDetail>;
  onPatch: (patch: StoryGraphPatch, expectedRevision: number) => Promise<unknown>;
  onLocateEvidence: (evidence: StoryGraphEvidence) => Promise<unknown>;
  onResolveEvidence: (query: StoryGraphEvidenceQuery) => Promise<StoryGraphEvidence>;
  onExtract: (request: StoryGraphExtractRequest) => Promise<unknown>;
  onCancelExtraction: () => Promise<unknown>;
  onDiscardCandidates: () => Promise<unknown>;
  onAdoptCandidates: (candidateId: string, selection: StoryGraphCandidateSelection) => Promise<unknown>;
  /** 未保存的详情或位置变更阻止工作台跨窗口交接。 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 主窗口先确认编辑租约，再显示可输入表单。 */
  onEditorStateChange: (open: boolean) => Promise<unknown>;
}

const NODE_TYPES = { 'story-record': StoryGraphNode };
const EDGE_TYPES = { 'story-relation': StoryGraphRelationEdge };
const EMPTY_FILTER: StoryGraphFilter = {};
const EMPTY_MODELS: [] = [];
const CARD_ORIGIN: [number, number] = [0, 0];
const DOT_ORIGIN: [number, number] = [0.5, 0.5];

function CandidateReview({ candidate, nodes, disabled, onAdopt, onDiscard, onClose, onLocate }: {
  candidate: StoryGraphCandidates;
  nodes: StoryGraphView['nodes'];
  disabled: boolean;
  onAdopt: (selection: StoryGraphCandidateSelection) => Promise<unknown>;
  onDiscard: () => Promise<unknown>;
  onClose: () => void;
  onLocate: (evidence: StoryGraphEvidence) => Promise<unknown>;
}) {
  const t = useT();
  const id = useId();
  const [tab, setTab] = useState<'nodes' | 'edges'>('nodes');
  const [page, setPage] = useState(0);
  const [nodeIds, setNodeIds] = useState<string[]>([]);
  const [edgeIds, setEdgeIds] = useState<string[]>([]);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const candidates = tab === 'nodes' ? candidate.nodes : candidate.edges;
  const unverifiedCount = [...candidate.nodes, ...candidate.edges].filter((item) => item.certainty === 'unknown' && item.evidence.length === 0).length;
  const lastPage = Math.max(0, Math.ceil(candidates.length / 20) - 1);
  const visible = candidates.slice(Math.min(page, lastPage) * 20, (Math.min(page, lastPage) + 1) * 20);
  const names = new Map([...nodes, ...candidate.nodes].map((node) => [node.id, node.label]));
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('故事关系图操作失败')); }
    finally { setBusy(false); }
  };
  const toggle = (item: StoryRecord | StoryGraphEdge, checked: boolean) => {
    if ('source' in item) {
      setEdgeIds((current) => checked ? [...new Set([...current, item.id])] : current.filter((entry) => entry !== item.id));
      if (checked) setNodeIds((current) => [...new Set([...current, ...[item.source, item.target].filter((entry) => candidate.nodes.some((node) => node.id === entry))])]);
    } else {
      setNodeIds((current) => checked ? [...new Set([...current, item.id])] : current.filter((entry) => entry !== item.id));
      if (!checked) setEdgeIds((current) => current.filter((entry) => !candidate.edges.some((edge) => edge.id === entry && (edge.source === item.id || edge.target === item.id))));
    }
  };

  return <ModalOverlay isOpen onClose={onClose} ariaLabel={t('审阅关系图候选')} className="w-full max-w-2xl max-h-[85vh] mx-2" zIndex={500}>
    <header className="flex items-center justify-between gap-2 border-b border-canvas-border p-3"><h3 className="text-sm font-semibold">{t('审阅关系图候选')}</h3>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} onClick={onClose} aria-label={t('关闭')}><Icon icon="lucide:x" width="16" /></button></header>
    <div className="min-h-0 space-y-3 overflow-y-auto p-3">
      <p className="ui-hint">{t('候选不会自动覆盖正式记录。同名人物须显式选择合并目标。')}</p>
      <p className="ui-hint">{t('采纳表示用户选择，不等于原文已经证明该推断。')}</p>
      <p className="ui-hint">{t('仅处理勾选项；采纳成功后，本批未选候选将被丢弃。')}</p>
      {unverifiedCount > 0 && <p role="status" className="ui-alert ui-alert--warning text-xs">{t('有 {count} 项候选缺少可定位的原文证据，已标为待核实；请核对后再采纳。', { count: unverifiedCount })}</p>}
      {candidate.hasMore && <p role="status" className="ui-alert ui-alert--info text-xs">{t('本批只分析部分材料；处理完候选后，可手动继续下一批。')}</p>}
      <Tabs size="sm" value={tab} onChange={(value) => { setTab(value); setPage(0); }} aria-label={t('候选记录类型')}
        items={[{ value: 'nodes', label: t('记录'), count: candidate.nodes.length }, { value: 'edges', label: t('关系'), count: candidate.edges.length }]} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="ui-hint">{t('已选 {nodes} 条记录、{edges} 条关系', { nodes: nodeIds.length, edges: edgeIds.length })}</span>
        <div className="flex gap-1"><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={disabled || busy} onClick={() => visible.forEach((item) => toggle(item, true))}>{t('全选本页')}</button>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={disabled || busy} onClick={() => visible.forEach((item) => toggle(item, false))}>{t('取消本页')}</button></div>
      </div>
      <ul className="space-y-2">{visible.map((item) => {
        const isEdge = 'source' in item;
        const checked = (isEdge ? edgeIds : nodeIds).includes(item.id);
        return <li key={item.id} className="ui-card gap-2 p-2">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <span className="relative min-w-0 flex-1"><input id={`${id}-${item.id}`} className="ui-checkbox" type="checkbox" checked={checked} disabled={disabled || busy} onChange={(event) => toggle(item, event.target.checked)} />
              <label htmlFor={`${id}-${item.id}`}><span className="break-words text-xs">{item.label}</span></label></span>
            <span className={`ui-badge shrink-0 ${item.certainty === 'unknown' ? 'ui-badge--warning' : item.certainty === 'explicit' ? 'ui-badge--info' : ''}`}>{t(STORY_GRAPH_CERTAINTY_LABELS[item.certainty])}</span>
            <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost shrink-0" onClick={() => setExpandedId((current) => current === item.id ? null : item.id)}>{t('详情')}</button>
          </div>
          {item.certainty === 'unknown' && item.evidence.length === 0 && <p className="ui-hint">{t('尚无原文证据')}</p>}
          {isEdge ? <p className="ui-hint break-words">{names.get(item.source) ?? item.source} {item.directed ? '→' : '—'} {names.get(item.target) ?? item.target}</p>
            : <div className="ui-field"><label className="ui-label" htmlFor={`${id}-mapping-${item.id}`}>{t('与已有记录合并')}</label>
              <Select id={`${id}-mapping-${item.id}`} size="sm" value={mappings[item.id] ?? ''} disabled={disabled || busy}
                options={[{ value: '', label: t('创建独立记录') }, ...nodes.map((node) => ({ value: node.id, label: node.label }))]}
                onChange={(value) => setMappings((current) => { const next = { ...current }; if (value) next[item.id] = value; else delete next[item.id]; return next; })} /></div>}
          {expandedId === item.id && <div className="space-y-2 border-t border-canvas-border pt-2 text-xs">
            <p className="whitespace-pre-wrap break-words text-canvas-text-secondary">{item.description || t('无补充说明')}</p>
            {item.evidence.length === 0 ? <p className="ui-hint">{t('尚无原文证据')}</p> : item.evidence.map((evidence, index) => <div key={index} className="space-y-1">
              <blockquote className="whitespace-pre-wrap break-words text-canvas-text">{evidence.quote}</blockquote>
              <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} onClick={() => void run(() => onLocate(evidence))}>{t('查看出处')}</button>
            </div>)}
          </div>}
        </li>;
      })}</ul>
      {candidates.length === 0 && <p className="ui-hint">{t('本批没有此类候选')}</p>}
      <div className="flex items-center justify-between gap-2"><span className="ui-hint">{t('第 {page} / {pages} 页', { page: Math.min(page, lastPage) + 1, pages: lastPage + 1 })}</span>
        <div className="flex gap-1"><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={page <= 0} onClick={() => setPage((current) => current - 1)}>{t('上一页')}</button>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={page >= lastPage} onClick={() => setPage((current) => current + 1)}>{t('下一页')}</button></div></div>
      <p className="ui-hint">{t('映射列表仅含当前可见记录，可先调整图谱筛选。')}</p>
      {error && <p role="alert" className="ui-error break-words">{t(error)}</p>}
    </div>
    <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-canvas-border p-3">
      {discarding ? <><span className="ui-hint">{t('丢弃后这些候选无法恢复。')}</span><div className="flex gap-2">
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} onClick={() => setDiscarding(false)}>{t('取消')}</button>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--danger" disabled={busy} onClick={() => void run(onDiscard)}>{t('确认丢弃')}</button></div></>
        : <><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} onClick={() => setDiscarding(true)}>{t('丢弃候选')}</button>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={disabled || busy || (!nodeIds.length && !edgeIds.length)}
            onClick={() => void run(() => onAdopt({ nodeIds, edgeIds, nodeMappings: Object.fromEntries(Object.entries(mappings).filter(([key]) => nodeIds.includes(key))) }))}>{t('采纳所选候选')}</button></>}
    </footer>
  </ModalOverlay>;
}

function StoryGraphPanelContent({ view, filter = EMPTY_FILTER, episodes, currentEpisodeId, assets, modelGroups, theme, extraction, disabled = false,
  onFilterChange, onReadDetail, onPatch, onLocateEvidence, onResolveEvidence, onExtract, onCancelExtraction, onDiscardCandidates, onAdoptCandidates, onDirtyChange, onEditorStateChange }: StoryGraphPanelProps) {
  const t = useT();
  const id = useId();
  const reducedMotion = useReducedMotion();
  const flowRef = useRef<ReactFlowInstance<StoryGraphFlowNode, StoryGraphFlowEdge> | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const readSequence = useRef(0);
  const detailDirtyRef = useRef(false);
  const notifiedDirtyRef = useRef(false);
  const dragPositionsRef = useRef<{ graphId: string; positions: Record<string, StoryGraphPosition> }>({ graphId: view.id, positions: {} });
  const operationInFlight = useRef(false);
  const [mode, setMode] = useState<'graph' | 'timeline' | 'list'>('graph');
  const [presentation, setPresentation] = useState<StoryGraphPresentation>('cards');
  const [dragging, setDragging] = useState(false);
  const [dotPositions, setDotPositions] = useState<{ graphId: string; revision: number; positions: Record<string, StoryGraphPosition> }>({ graphId: view.id, revision: view.revision, positions: {} });
  const [search, setSearch] = useState(filter.search ?? '');
  const [showLabels, setShowLabels] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [readingDetail, setReadingDetail] = useState(false);
  const [closingEditor, setClosingEditor] = useState(false);
  const [selected, setSelected] = useState<{ graphId: string; selection: StoryGraphSelection } | null>(null);
  const [editor, setEditor] = useState<{ graphId: string; detail: StoryGraphDetail; revision: number; isNew: boolean; key: number } | null>(null);
  const [dragPositions, setDragPositions] = useState<{ graphId: string; positions: Record<string, StoryGraphPosition> }>({ graphId: view.id, positions: {} });
  const [extractOpen, setExtractOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{ run: () => void | Promise<unknown> } | null>(null);
  const [episodePicker, setEpisodePicker] = useState(false);
  const [pickedEpisodes, setPickedEpisodes] = useState<string[]>(filter.episodeIds ?? (currentEpisodeId ? [currentEpisodeId] : []));
  const [extractEpisodes, setExtractEpisodes] = useState<string[]>(currentEpisodeId ? [currentEpisodeId] : []);
  const [extractParts, setExtractParts] = useState<Array<'outline' | 'script'>>(['script']);
  const [extractModel, setExtractModel] = useState('');
  useDialogFocus(fullscreen, panelRef, () => setFullscreen(false), { zIndex: 400 });
  const running = extraction?.status === 'running';
  const writeLocked = disabled || busy || running || readingDetail || closingEditor;
  const selection = selected?.graphId === view.id ? selected.selection : null;
  const currentEditor = editor?.graphId === view.id ? editor : null;
  useEffect(() => {
    if (mode !== 'graph') return;
    let secondFrame: number | undefined;
    // 等节点尺寸与 Handle bounds 更新后适配，不重挂载详情或图谱实例。
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        void flowRef.current?.fitView({ padding: 0.2, duration: reducedMotion ? 0 : 150 });
      });
    });
    return () => { cancelAnimationFrame(firstFrame); if (secondFrame !== undefined) cancelAnimationFrame(secondFrame); };
  }, [presentation, mode, view.id, reducedMotion]);
  const notifyDirty = () => {
    const dirty = detailDirtyRef.current || (dragPositionsRef.current.graphId === view.id && Object.keys(dragPositionsRef.current.positions).length > 0);
    if (notifiedDirtyRef.current !== dirty) { notifiedDirtyRef.current = dirty; onDirtyChange?.(dirty); }
  };
  const markDetailDirty = (dirty: boolean) => { detailDirtyRef.current = dirty; notifyDirty(); };
  const navigate = (action: () => void | Promise<unknown>, closeFirst = false) => {
    if (operationInFlight.current) return;
    if (detailDirtyRef.current || (dragPositionsRef.current.graphId === view.id && Object.keys(dragPositionsRef.current.positions).length)) setPendingNavigation({ run: action });
    else void run(async () => { if (closeFirst) await closeEditor(); await action(); });
  };
  const run = async (action: () => Promise<unknown>) => {
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true); setError('');
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('故事关系图操作失败')); }
    finally { operationInFlight.current = false; setBusy(false); }
  };
  const controlExtraction = async (action: () => Promise<unknown>) => {
    setError('');
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('故事关系图操作失败')); }
  };
  const selectRecord = async (next: StoryGraphSelection) => {
    const sequence = ++readSequence.current;
    setSelected({ graphId: view.id, selection: next }); setError(''); setReadingDetail(true);
    try {
      const detail = await onReadDetail(next);
      if (sequence !== readSequence.current) return;
      await onEditorStateChange(true);
      if (sequence === readSequence.current) setEditor({ graphId: view.id, detail, revision: view.revision, isNew: false, key: sequence });
    } catch (reason) { if (sequence === readSequence.current) setError(reason instanceof Error ? reason.message : t('故事关系图操作失败')); }
    finally { if (sequence === readSequence.current) setReadingDetail(false); }
  };
  const clearSelection = () => {
    if (selection || currentEditor) navigate(() => {}, true);
  };
  const select = (next: StoryGraphSelection) => {
    if (selection?.kind === next.kind && selection.id === next.id) clearSelection();
    else navigate(() => selectRecord(next));
  };
  const beginNode = () => navigate(async () => {
    const sequence = ++readSequence.current;
    const item: StoryRecord = { id: crypto.randomUUID(), kind: 'event', label: '', description: '', aliases: [], episodeIds: currentEpisodeId ? [currentEpisodeId] : [], evidence: [], origin: 'manual', certainty: 'unknown' };
    setReadingDetail(true);
    try {
      await onEditorStateChange(true);
      if (sequence !== readSequence.current) return;
      setSelected(null); setEditor({ graphId: view.id, detail: { item, evidenceStatuses: [] }, revision: view.revision, isNew: true, key: sequence }); markDetailDirty(true);
    } finally { if (sequence === readSequence.current) setReadingDetail(false); }
  });
  const beginEdge = (connection?: Connection) => navigate(async () => {
    if (!view.nodes.length) return;
    const sequence = ++readSequence.current;
    const source = connection?.source ?? (selection?.kind === 'node' ? selection.id : view.nodes[0].id);
    const target = connection?.target ?? view.nodes.find((node) => node.id !== source)?.id ?? source;
    const item: StoryGraphEdge = { id: crypto.randomUUID(), source, target, kind: 'related', directed: true, label: t('相关'), description: '', episodeIds: currentEpisodeId ? [currentEpisodeId] : [], evidence: [], origin: 'manual', certainty: 'unknown' };
    setReadingDetail(true);
    try {
      await onEditorStateChange(true);
      if (sequence !== readSequence.current) return;
      setSelected(null); setEditor({ graphId: view.id, detail: { item, evidenceStatuses: [] }, revision: view.revision, isNew: true, key: sequence }); markDetailDirty(true);
    } finally { if (sequence === readSequence.current) setReadingDetail(false); }
  });
  const connected = useMemo(() => {
    if (selection?.kind !== 'node') return null;
    return new Set([selection.id, ...view.edges.flatMap((edge) => edge.source === selection.id ? [edge.target] : edge.target === selection.id ? [edge.source] : [])]);
  }, [selection, view.edges]);
  const dotLayout = useMemo<Record<string, StoryGraphPosition>>(() => presentation === 'dots'
    ? layoutStoryGraphConstellation(view.nodes, view.edges) : {}, [presentation, view.nodes, view.edges]);
  const flowNodes = useMemo<StoryGraphFlowNode[]>(() => view.nodes.map((node, index) => ({
    id: node.id, type: 'story-record', origin: presentation === 'dots' ? DOT_ORIGIN : CARD_ORIGIN,
    position: presentation === 'dots'
      ? (dotPositions.graphId === view.id && dotPositions.revision === view.revision ? dotPositions.positions[node.id] : undefined)
        ?? dotLayout[node.id] ?? { x: 0, y: 0 }
      : (dragPositions.graphId === view.id ? dragPositions.positions[node.id] : undefined)
        ?? view.positions[node.id] ?? { x: Math.cos(index * Math.PI * 2 / Math.max(view.nodes.length, 1)) * 240, y: Math.sin(index * Math.PI * 2 / Math.max(view.nodes.length, 1)) * 240 },
    selected: selection?.kind === 'node' && selection.id === node.id,
    data: { label: node.label, kind: node.kind, certainty: node.certainty, evidenceCount: node.evidenceCount, presentation, dimmed: !!connected && !connected.has(node.id) },
  })), [view, dragPositions, dotPositions, dotLayout, presentation, selection, connected]);
  const flowEdges = useMemo<StoryGraphFlowEdge[]>(() => {
    const pairs = new Map<string, string[]>();
    for (const edge of view.edges) { const key = [edge.source, edge.target].sort().join('|'); pairs.set(key, [...(pairs.get(key) ?? []), edge.id]); }
    for (const pair of pairs.values()) pair.sort();
    return view.edges.map((edge) => {
      const pair = pairs.get([edge.source, edge.target].sort().join('|'))!;
      const index = pair.indexOf(edge.id);
      return { id: edge.id, type: 'story-relation', source: edge.source, target: edge.target,
        selected: selection?.kind === 'edge' && selection.id === edge.id,
        data: { label: edge.label || t(STORY_GRAPH_EDGE_LABELS[edge.kind]), kind: edge.kind, directed: edge.directed, showLabel: showLabels, presentation,
          dimmed: !!connected && !(connected.has(edge.source) && connected.has(edge.target)), parallelIndex: edge.source <= edge.target ? index : pair.length - 1 - index, parallelCount: pair.length } };
    });
  }, [view.edges, selection, showLabels, presentation, connected, t]);
  const nodeChanges = (changes: NodeChange<StoryGraphFlowNode>[]) => {
    const positions = changes.flatMap((change) => change.type === 'position' && change.position ? [[change.id, change.position] as const] : []);
    if (positions.length) {
      if (presentation === 'dots') {
        const visibleIds = new Set(view.nodes.map((node) => node.id));
        setDotPositions((previous) => ({ graphId: view.id, revision: view.revision, positions: Object.fromEntries(
          [...Object.entries(previous.graphId === view.id && previous.revision === view.revision ? previous.positions : {}), ...positions]
            .filter(([id]) => visibleIds.has(id)),
        ) }));
        return;
      }
      const current = dragPositionsRef.current;
      const next = { graphId: view.id, positions: { ...(current.graphId === view.id ? current.positions : {}), ...Object.fromEntries(positions) } };
      dragPositionsRef.current = next; setDragPositions(next); notifyDirty();
    }
  };
  const scope = !filter.episodeIds?.length ? 'all' : filter.episodeIds.length === 1 && filter.episodeIds[0] === currentEpisodeId ? 'current' : 'selected';
  const updateFilter = (changes: Partial<StoryGraphFilter>) => void run(() => onFilterChange({ ...filter, ...changes }));
  const closeEditor = async () => {
    const ownsOperation = !operationInFlight.current;
    if (ownsOperation) { operationInFlight.current = true; setBusy(true); }
    const sequence = readSequence.current;
    setClosingEditor(true);
    try {
      await onEditorStateChange(false);
      if (sequence === readSequence.current) { readSequence.current += 1; setEditor(null); setSelected(null); markDetailDirty(false); }
    } finally {
      setClosingEditor(false);
      if (ownsOperation) { operationInFlight.current = false; setBusy(false); }
    }
  };
  const commitEditor = async (editorKey: number, write: () => Promise<unknown>) => {
    if (operationInFlight.current) throw new Error(t('图谱操作尚未完成，请稍后再试'));
    operationInFlight.current = true; setBusy(true);
    try {
      await write();
      if (readSequence.current === editorKey) await closeEditor();
    } finally { operationInFlight.current = false; setBusy(false); }
  };
  const locateEvidence = async (evidence: StoryGraphEvidence) => {
    navigate(() => onLocateEvidence(evidence), true);
  };
  const content = <section ref={panelRef} className={`story-graph${presentation === 'dots' ? ' story-graph--dots' : ''}${fullscreen ? ' is-fullscreen' : ''}`} aria-label={t('故事关系图')}
    role={fullscreen ? 'dialog' : undefined} aria-modal={fullscreen ? true : undefined} tabIndex={-1}>
    <div className="story-graph-toolbar">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <form className="flex min-w-0 flex-1 items-center gap-1 sm:flex-initial" onSubmit={(event) => { event.preventDefault(); updateFilter({ search }); }}>
          <input className="ui-input ui-input--sm min-w-0 w-32" aria-label={t('搜索故事记录')} placeholder={t('搜索人物、事件或关系')} maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} />
          <button type="submit" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} aria-label={t('搜索')}><Icon icon="lucide:search" width="13" /></button>
        </form>
        <Select<'current' | 'all' | 'selected'> size="sm" className="w-24" aria-label={t('分集范围')} value={scope} disabled={busy}
          options={[{ value: 'current', label: t('本集'), disabled: !currentEpisodeId }, { value: 'all', label: t('全剧') }, { value: 'selected', label: t('选定分集') }]}
          onChange={(value) => { if (value === 'selected') { setPickedEpisodes(filter.episodeIds ?? (currentEpisodeId ? [currentEpisodeId] : [])); setEpisodePicker(true); }
            else updateFilter({ episodeIds: value === 'current' && currentEpisodeId ? [currentEpisodeId] : undefined }); }} />
        <Select<StoryGraphNodeKind | ''> size="sm" className="w-28" aria-label={t('记录类型筛选')} value={filter.nodeKinds?.length === 1 ? filter.nodeKinds[0] : ''} disabled={busy}
          options={[{ value: '', label: t('全部记录类型') }, ...STORY_GRAPH_NODE_KINDS.map((kind) => ({ value: kind, label: t(STORY_GRAPH_NODE_LABELS[kind]) }))]}
          onChange={(value) => updateFilter({ nodeKinds: value ? [value] : undefined })} />
        <Select<StoryGraphEdgeKind | ''> size="sm" className="w-28" aria-label={t('关系类型筛选')} value={filter.edgeKinds?.length === 1 ? filter.edgeKinds[0] : ''} disabled={busy}
          options={[{ value: '', label: t('全部关系类型') }, ...STORY_GRAPH_EDGE_KINDS.map((kind) => ({ value: kind, label: t(STORY_GRAPH_EDGE_LABELS[kind]) }))]}
          onChange={(value) => updateFilter({ edgeKinds: value ? [value] : undefined })} />
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} onClick={() => { setSearch(''); void run(() => onFilterChange(currentEpisodeId ? { episodeIds: [currentEpisodeId] } : {})); }}>{t('重置筛选')}</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Tabs size="sm" value={mode} onChange={setMode} aria-label={t('图谱展示方式')} items={[{ value: 'graph', label: t('关系图'), disabled: dragging }, { value: 'timeline', label: t('时间线'), disabled: dragging }, { value: 'list', label: t('列表'), disabled: dragging }]} />
        <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={writeLocked} onClick={beginNode}><Icon icon="lucide:plus" width="13" />{t('新增记录')}</button>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={writeLocked || !view.nodes.length} onClick={() => beginEdge()}>{t('新增关系')}</button>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={writeLocked || !!currentEditor || !!extraction?.candidate}
          onClick={() => { setExtractEpisodes(currentEpisodeId ? [currentEpisodeId] : []); setExtractParts(['script']); setExtractOpen(true); }}><Icon icon="lucide:scan-text" width="13" />{t('提取候选')}</button>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label={fullscreen ? t('退出图谱全屏') : t('全屏显示图谱')} onClick={() => setFullscreen((value) => !value)}><Icon icon={fullscreen ? 'lucide:minimize-2' : 'lucide:maximize-2'} width="14" /></button>
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-2 border-b border-canvas-border px-3 py-2 text-[11px] text-canvas-text-muted">
      <span>{t('{visible} / {total} 条记录', { visible: view.counts.visibleNodes, total: view.counts.totalNodes })}</span>
      <span>{t('{visible} / {total} 条关系', { visible: view.counts.visibleEdges, total: view.counts.totalEdges })}</span>
      {mode === 'graph' && <><div className="ui-segmented shrink-0" role="group" aria-label={t('图谱显示形态')}>
        <button type="button" className={`ui-segmented__item${presentation === 'cards' ? ' is-active' : ''}`} aria-pressed={presentation === 'cards'} disabled={dragging} onClick={() => setPresentation('cards')}>{t('卡片')}</button>
        <button type="button" className={`ui-segmented__item${presentation === 'dots' ? ' is-active' : ''}`} aria-pressed={presentation === 'dots'} disabled={dragging} onClick={() => setPresentation('dots')}>{t('点阵')}</button>
      </div><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => { void flowRef.current?.fitView({ padding: 0.2, duration: reducedMotion ? 0 : 150 }); }}>{t('适配视图')}</button>
        <button type="button" className={`ui-btn ui-btn--sm ui-btn--ghost${showLabels ? ' is-active' : ''}`} aria-pressed={showLabels} onClick={() => setShowLabels((value) => !value)}>{t('关系标签')}</button></>}
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy || selection?.kind !== 'node'} onClick={() => { if (selection?.kind === 'node') updateFilter({ focusNodeId: selection.id, neighbors: true }); }}>{t('展开一层关联')}</button>
      {filter.focusNodeId && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} onClick={() => updateFilter({ focusNodeId: undefined, neighbors: undefined })}>{t('显示筛选范围')}</button>}
    </div>
    {view.counts.truncated && <p role="status" className="ui-alert ui-alert--warning m-2 text-xs">{t('当前只展示部分记录，请收窄筛选；保存只修改所选项目，不会覆盖隐藏记录。')}</p>}
    {error && <p role="alert" className="ui-alert ui-alert--danger m-2 break-words text-xs">{t(error)}</p>}
    {(running || extraction?.candidate || extraction?.error || extraction?.continuation) && <div className="story-graph-progress" role="status">
      {running ? <><Icon icon="lucide:loader-circle" width="14" className="animate-spin motion-reduce:animate-none" /><span>{t('正在提取：{completed} / {total} 次调用', { completed: extraction.completed, total: extraction.total })}</span>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost ml-auto" onClick={() => void controlExtraction(onCancelExtraction)}>{t('取消提取')}</button></>
        : extraction?.candidate ? <><Icon icon="lucide:list-checks" width="14" /><span>{t('候选已就绪，等待审阅')}</span>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary ml-auto" onClick={() => setReviewOpen(true)}>{t('审阅候选')}</button></>
          : extraction?.continuation ? <><span>{t('还有材料尚未分析，可按原范围继续。')}</span><button type="button" className="ui-btn ui-btn--sm ui-btn--secondary ml-auto" disabled={writeLocked || !!currentEditor}
            onClick={() => { if (extraction.continuation) void run(() => onExtract({ ...extraction.continuation!.request, startChunk: extraction.continuation!.nextChunk })); }}>{t('继续下一批')}</button></>
            : <span className="break-words text-danger-light">{t(extraction?.error ?? '')}</span>}
    </div>}
    <div className="story-graph-body">
      <div className="story-graph-stage">
        {mode === 'graph' ? <ReactFlow<StoryGraphFlowNode, StoryGraphFlowEdge> nodes={flowNodes} edges={flowEdges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
          onInit={(instance) => { flowRef.current = instance; }} onNodesChange={nodeChanges} onPaneClick={clearSelection}
          onNodeClick={(_, node) => void select({ kind: 'node', id: node.id })} onEdgeClick={(_, edge) => void select({ kind: 'edge', id: edge.id })}
          onNodeDragStart={() => setDragging(true)}
          onConnect={(connection) => { if (!writeLocked) beginEdge(connection); }} onNodeDragStop={(_, node) => {
            setDragging(false);
            if (presentation === 'dots') return;
            if (!writeLocked) void run(async () => {
              await onPatch({ graphId: view.id, positions: { [node.id]: node.position } }, view.revision);
              const next = { graphId: view.id, positions: { ...(dragPositionsRef.current.graphId === view.id ? dragPositionsRef.current.positions : {}) } };
              delete next.positions[node.id]; dragPositionsRef.current = next; setDragPositions(next); notifyDirty();
            });
          }} nodesDraggable={!writeLocked && !currentEditor} nodesConnectable={!writeLocked && !currentEditor} edgesReconnectable={false} elementsSelectable
          deleteKeyCode={null} panOnDrag zoomOnScroll minZoom={0.1} maxZoom={2.5} fitView fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}>
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="story-graph-background" />
        </ReactFlow> : mode === 'timeline' ? <StoryGraphTimeline nodes={view.nodes} episodes={episodes} selected={selection} onSelect={(next) => void select(next)} />
          : <div className="story-graph-list"><h3 className="ui-label mb-2">{t('可见故事记录')}</h3><ul className="space-y-1.5">{view.nodes.map((node) => <li key={node.id}>
            <button type="button" className={`ui-card ui-card--interactive story-graph-list__item${selection?.kind === 'node' && selection.id === node.id ? ' is-selected' : ''}`} onClick={() => void select({ kind: 'node', id: node.id })}>
              <span className={`story-graph-legend-dot story-graph-kind-${node.kind}`} aria-hidden="true" /><span className="min-w-0 flex-1 break-words">{node.label}</span><span className="text-canvas-text-muted">{t(STORY_GRAPH_NODE_LABELS[node.kind])}</span>
            </button></li>)}</ul><h3 className="ui-label mb-2 mt-4">{t('可见故事关系')}</h3><ul className="space-y-1.5">{view.edges.map((edge) => <li key={edge.id}>
              <button type="button" className={`ui-card ui-card--interactive story-graph-list__item${selection?.kind === 'edge' && selection.id === edge.id ? ' is-selected' : ''}`} onClick={() => void select({ kind: 'edge', id: edge.id })}>
                <span className="min-w-0 break-words">{view.nodes.find((node) => node.id === edge.source)?.label} {edge.directed ? '→' : '—'} {view.nodes.find((node) => node.id === edge.target)?.label} · {edge.label}</span></button>
            </li>)}</ul></div>}
        {view.nodes.length === 0 && mode === 'graph' && <div className="story-graph-empty pointer-events-none absolute inset-0"><Icon icon="lucide:network" width="28" /><strong>{t(view.counts.totalNodes ? '没有匹配的故事记录' : '把故事的关键点连接起来')}</strong>
          <p>{t(view.counts.totalNodes ? '调整分集、类型或关键词后再查看。' : '手动新增人物、事件和伏笔，或从已保存稿件提取候选。')}</p></div>}
        <div className="story-graph-legend" aria-label={t('记录类型图例')}>{STORY_GRAPH_NODE_KINDS.map((kind) => <span key={kind}><i className={`story-graph-legend-dot story-graph-kind-${kind}`} />{t(STORY_GRAPH_NODE_LABELS[kind])}</span>)}</div>
      </div>
      {currentEditor && <StoryGraphDetails key={currentEditor.key} detail={currentEditor.detail} revision={currentEditor.revision} currentRevision={view.revision} isNew={currentEditor.isNew}
        nodes={view.nodes} episodes={episodes} assets={assets} disabled={writeLocked} onClose={clearSelection} onDirtyChange={markDetailDirty} onResolveEvidence={onResolveEvidence} onLocateEvidence={locateEvidence}
        onSave={(item) => commitEditor(currentEditor.key, () => onPatch({ graphId: view.id, ...('source' in item ? { upsertEdges: [item] } : { upsertNodes: [item] }) }, currentEditor.revision))}
        onDelete={(next) => commitEditor(currentEditor.key, () => onPatch({ graphId: view.id, ...(next.kind === 'node' ? { removeNodeIds: [next.id] } : { removeEdgeIds: [next.id] }) }, currentEditor.revision))} />}
    </div>
  </section>;

  return <>
    {content}
    {pendingNavigation && <ModalOverlay isOpen onClose={() => setPendingNavigation(null)} ariaLabel={t('保留未保存的图谱编辑')} className="w-full max-w-sm mx-2" zIndex={550}>
      <div className="space-y-3 p-3"><h3 className="text-sm font-semibold">{t('保留未保存的图谱编辑')}</h3><p className="ui-hint">{t('当前图谱编辑尚未保存。继续会丢弃这些编辑，正式图和原稿不变。')}</p>
        <div className="flex justify-end gap-2"><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => setPendingNavigation(null)}>{t('返回编辑')}</button>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--danger" disabled={busy} onClick={() => void run(async () => {
            const action = pendingNavigation.run;
            await closeEditor();
            dragPositionsRef.current = { graphId: view.id, positions: {} }; setDragPositions({ graphId: view.id, positions: {} }); notifyDirty();
            setPendingNavigation(null); await action();
          })}>{t('丢弃编辑并继续')}</button></div></div>
    </ModalOverlay>}
    {episodePicker && <ModalOverlay isOpen onClose={() => setEpisodePicker(false)} ariaLabel={t('选择图谱分集范围')} className="w-full max-w-sm max-h-[75vh] mx-2" zIndex={500}>
      <h3 className="border-b border-canvas-border p-3 text-sm font-semibold">{t('选择图谱分集范围')}</h3><div className="min-h-0 space-y-3 overflow-y-auto p-3">
        {episodes.map((episode) => <div key={episode.id} className="relative"><input type="checkbox" id={`${id}-filter-${episode.id}`} className="ui-checkbox" checked={pickedEpisodes.includes(episode.id)}
          onChange={(event) => setPickedEpisodes((current) => event.target.checked ? [...current, episode.id] : current.filter((entry) => entry !== episode.id))} /><label htmlFor={`${id}-filter-${episode.id}`}>{episode.name}</label></div>)}</div>
      <footer className="flex justify-end gap-2 border-t border-canvas-border p-3"><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => setEpisodePicker(false)}>{t('取消')}</button>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={!pickedEpisodes.length || busy} onClick={() => { updateFilter({ episodeIds: pickedEpisodes }); setEpisodePicker(false); }}>{t('应用范围')}</button></footer>
    </ModalOverlay>}
    {extractOpen && <ModalOverlay isOpen onClose={() => setExtractOpen(false)} ariaLabel={t('从稿件提取关系图候选')} className="w-full max-w-md max-h-[80vh] mx-2" zIndex={500}>
      <h3 className="border-b border-canvas-border p-3 text-sm font-semibold">{t('从稿件提取关系图候选')}</h3><div className="min-h-0 space-y-3 overflow-y-auto p-3">
        <p className="ui-hint">{t('仅读取勾选的已保存稿件；最多 8 次顺序调用，每次最多 12,000 字，不自动重试。')}</p>
        <fieldset className="space-y-2"><legend className="ui-label mb-2">{t('选择材料分集')}</legend>{episodes.map((episode) => <div key={episode.id} className="relative">
          <input type="checkbox" className="ui-checkbox" id={`${id}-extract-${episode.id}`} checked={extractEpisodes.includes(episode.id)} onChange={(event) => setExtractEpisodes((current) => event.target.checked ? [...current, episode.id] : current.filter((entry) => entry !== episode.id))} />
          <label htmlFor={`${id}-extract-${episode.id}`}>{episode.name}</label></div>)}</fieldset>
        <fieldset className="flex flex-wrap gap-3"><legend className="ui-label mb-2">{t('选择稿件类型')}</legend>{(['script', 'outline'] as const).map((part) => <span key={part} className="relative">
          <input id={`${id}-part-${part}`} type="checkbox" className="ui-checkbox" checked={extractParts.includes(part)} onChange={(event) => setExtractParts((current) => event.target.checked ? [...current, part] : current.filter((entry) => entry !== part))} />
          <label htmlFor={`${id}-part-${part}`}>{part === 'script' ? t('本集剧本') : t('本集大纲')}</label></span>)}</fieldset>
        <div className="ui-field"><span className="ui-label">{t('提取使用的文本模型')}</span><ModelSelector size="sm" nodeType="ai-text" persistPreference={false} theme={theme} selectedModel={extractModel}
          configuredGroupsOverride={modelGroups} generalModelsOverride={EMPTY_MODELS} onSelect={(model) => setExtractModel(model.value)} /></div>
        <p className="ui-hint">{t('开始后会产生所选模型用量；结果先进入候选，采纳前不会修改正式图。')}</p>
      </div><footer className="flex justify-end gap-2 border-t border-canvas-border p-3"><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => setExtractOpen(false)}>{t('取消')}</button>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={writeLocked || !extractEpisodes.length || !extractParts.length || !extractModel}
          onClick={() => { setExtractOpen(false); void run(() => onExtract({ episodeIds: extractEpisodes, parts: extractParts, modelId: extractModel })); }}>{t('开始提取候选')}</button></footer>
    </ModalOverlay>}
    {reviewOpen && extraction?.candidate && <CandidateReview key={extraction.candidate.id} candidate={extraction.candidate} nodes={view.nodes} disabled={writeLocked || !!currentEditor}
      onClose={() => setReviewOpen(false)} onLocate={locateEvidence}
      onAdopt={async (candidateSelection) => { await onAdoptCandidates(extraction.candidate!.id, candidateSelection); setReviewOpen(false); }}
      onDiscard={async () => { await onDiscardCandidates(); setReviewOpen(false); }} />}
  </>;
}

export default function StoryGraphPanel(props: StoryGraphPanelProps) {
  return <ReactFlowProvider><StoryGraphPanelContent {...props} /></ReactFlowProvider>;
}
