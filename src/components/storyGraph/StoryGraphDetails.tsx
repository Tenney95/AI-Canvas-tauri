import { useId, useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { CanvasProject } from '../../types';
import type { StoryGraphAssetOption, StoryGraphCertainty, StoryGraphDetail, StoryGraphEdge, StoryGraphEdgeKind, StoryGraphEvidence, StoryGraphEvidenceQuery,
  StoryGraphNode, StoryGraphNodeKind, StoryGraphPart, StoryGraphSelection, StoryGraphViewNode } from '../../types/storyGraph';
import { STORY_GRAPH_NODE_KINDS, STORY_GRAPH_EDGE_KINDS } from '../../types/storyGraph';
import { STORY_GRAPH_NODE_LABELS, STORY_GRAPH_EDGE_LABELS, STORY_GRAPH_CERTAINTY_LABELS } from '../../services/storyGraphService';
import Select from '../shared/Select';
import NumberStepper from '../shared/NumberStepper';

interface StoryGraphDetailsProps {
  detail: StoryGraphDetail;
  revision: number;
  currentRevision: number;
  isNew?: boolean;
  nodes: StoryGraphViewNode[];
  episodes: Array<Pick<CanvasProject, 'id' | 'name' | 'episodeNo'>>;
  assets: StoryGraphAssetOption[];
  disabled?: boolean;
  onSave: (item: StoryGraphNode | StoryGraphEdge) => Promise<unknown>;
  onDelete: (selection: StoryGraphSelection) => Promise<unknown>;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onLocateEvidence: (evidence: StoryGraphEvidence) => Promise<unknown>;
  onResolveEvidence: (query: StoryGraphEvidenceQuery) => Promise<StoryGraphEvidence>;
}

/** keyed 编辑器：新详情由用户选择初始化，失败时保留用户输入。 */
export default function StoryGraphDetails({ detail, revision, currentRevision, isNew = false, nodes, episodes, assets,
  disabled = false, onSave, onDelete, onClose, onDirtyChange, onLocateEvidence, onResolveEvidence }: StoryGraphDetailsProps) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState(() => structuredClone(detail.item));
  const [aliases, setAliases] = useState(() => 'source' in detail.item ? '' : detail.item.aliases.join(', '));
  const [statuses, setStatuses] = useState(detail.evidenceStatuses);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [evidenceQuery, setEvidenceQuery] = useState<StoryGraphEvidenceQuery>(() => ({ episodeId: detail.item.episodeIds.find((entry) => episodes.some((episode) => episode.id === entry)) ?? episodes[0]?.id ?? '', part: 'script', quote: '' }));
  const node = 'kind' in draft && !('source' in draft) ? draft : null;
  const edge = 'source' in draft ? draft : null;
  const stale = revision !== currentRevision;
  const locked = disabled || busy || stale;
  const episodeNames = new Map(episodes.map((episode) => [episode.id, episode.name]));
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('故事关系图操作失败')); }
    finally { setBusy(false); }
  };
  const change = <K extends keyof (StoryGraphNode | StoryGraphEdge)>(key: K, value: (StoryGraphNode | StoryGraphEdge)[K]) => {
    onDirtyChange(true);
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const updateNode = (changes: Partial<StoryGraphNode>) => { onDirtyChange(true); setDraft((current) => 'source' in current ? current : { ...current, ...changes }); };
  const updateEdge = (changes: Partial<StoryGraphEdge>) => { onDirtyChange(true); setDraft((current) => 'source' in current ? { ...current, ...changes } : current); };
  const endpointOptions = (value: string) => [...nodes.map((entry) => ({ value: entry.id, label: entry.label })),
    ...(!nodes.some((entry) => entry.id === value) ? [{ value, label: t('节点不在当前视图'), disabled: true }] : [])];
  const episodeOptions = (value: string) => [{ value: '', label: t('未指定分集') }, ...episodes.map((episode) => ({ value: episode.id, label: episode.name })),
    ...(value && !episodeNames.has(value) ? [{ value, label: t('来源分集已移除'), disabled: true }] : [])];
  const removeEvidence = (index: number) => {
    change('evidence', draft.evidence.filter((_, entry) => entry !== index));
    setStatuses((current) => current.filter((_, entry) => entry !== index));
  };

  return <aside className="story-graph-details" aria-label={t('故事记录详情')}>
    <div className="flex items-center justify-between gap-2 border-b border-canvas-border p-3">
      <h3 className="min-w-0 truncate text-xs font-semibold">{isNew ? t(edge ? '新增关系' : '新增记录') : t('故事记录详情')}</h3>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={onClose} disabled={busy} aria-label={t('关闭详情')}><Icon icon="lucide:x" width="14" /></button>
    </div>
    <form className="min-h-0 space-y-3 overflow-y-auto p-3" onSubmit={(event) => { event.preventDefault(); if (!locked) void run(() => onSave(draft)); }}>
      {stale && <p role="status" className="ui-alert ui-alert--warning text-xs">{t('图谱已更新，保留当前输入；请重新选择记录后编辑。')}</p>}
      <div className="flex flex-wrap gap-1.5">
        <span className="ui-badge">{draft.origin === 'ai' ? t('AI 候选采纳') : t('人工记录')}</span>
        <span className="ui-badge">{t(STORY_GRAPH_CERTAINTY_LABELS[draft.certainty])}</span>
      </div>
      <div className="ui-field">
        <label className="ui-label" htmlFor={`${id}-name`}>{t('名称或关系说明')}</label>
        <input id={`${id}-name`} className="ui-input ui-input--sm" maxLength={120} required value={draft.label} disabled={locked} onChange={(event) => change('label', event.target.value)} />
      </div>
      {node && <div className="ui-field">
        <label className="ui-label" htmlFor={`${id}-kind`}>{t('记录类型')}</label>
        <Select<StoryGraphNodeKind> id={`${id}-kind`} size="sm" value={node.kind} disabled={locked} options={STORY_GRAPH_NODE_KINDS.map((kind) => ({ value: kind, label: t(STORY_GRAPH_NODE_LABELS[kind]) }))}
          onChange={(kind) => updateNode({ kind, ...(kind !== 'foreshadow' ? { foreshadowStatus: undefined } : {}) })} />
      </div>}
      {edge && <>
        <div className="ui-field"><label className="ui-label" htmlFor={`${id}-kind`}>{t('关系类型')}</label>
          <Select<StoryGraphEdgeKind> id={`${id}-kind`} size="sm" value={edge.kind} disabled={locked} options={STORY_GRAPH_EDGE_KINDS.map((kind) => ({ value: kind, label: t(STORY_GRAPH_EDGE_LABELS[kind]) }))}
            onChange={(kind) => updateEdge({ kind })} /></div>
        <div className="grid grid-cols-2 gap-2">
          <div className="ui-field"><label className="ui-label" htmlFor={`${id}-source`}>{t('起点')}</label>
            <Select id={`${id}-source`} size="sm" value={edge.source} options={endpointOptions(edge.source)} disabled={locked} onChange={(source) => updateEdge({ source })} /></div>
          <div className="ui-field"><label className="ui-label" htmlFor={`${id}-target`}>{t('终点')}</label>
            <Select id={`${id}-target`} size="sm" value={edge.target} options={endpointOptions(edge.target)} disabled={locked} onChange={(target) => updateEdge({ target })} /></div>
        </div>
        <p className="ui-hint">{t('节点列表仅含当前可见记录，可先调整筛选范围。')}</p>
        <div className="flex items-center justify-between gap-2"><span className="ui-label">{t('有向关系')}</span>
          <button type="button" role="switch" aria-checked={edge.directed} aria-label={t('有向关系')} className="ui-switch" disabled={locked} onClick={() => updateEdge({ directed: !edge.directed })} /></div>
        <div className="grid grid-cols-2 gap-2">
          <div className="ui-field"><label className="ui-label" htmlFor={`${id}-from`}>{t('起始分集')}</label>
            <Select id={`${id}-from`} size="sm" value={edge.fromEpisodeId ?? ''} options={episodeOptions(edge.fromEpisodeId ?? '')} disabled={locked} onChange={(value) => updateEdge({ fromEpisodeId: value || undefined })} /></div>
          <div className="ui-field"><label className="ui-label" htmlFor={`${id}-to`}>{t('结束分集')}</label>
            <Select id={`${id}-to`} size="sm" value={edge.toEpisodeId ?? ''} options={episodeOptions(edge.toEpisodeId ?? '')} disabled={locked} onChange={(value) => updateEdge({ toEpisodeId: value || undefined })} /></div>
        </div>
      </>}
      <div className="ui-field"><label className="ui-label" htmlFor={`${id}-certainty`}>{t('确定性')}</label>
        <Select<StoryGraphCertainty> id={`${id}-certainty`} size="sm" value={draft.certainty} disabled={locked} options={(['explicit', 'inferred', 'unknown'] as const).map((certainty) => ({ value: certainty, label: t(STORY_GRAPH_CERTAINTY_LABELS[certainty]) }))}
          onChange={(certainty) => change('certainty', certainty)} /></div>
      <div className="ui-field"><label className="ui-label" htmlFor={`${id}-description`}>{t('记录说明')}</label>
        <textarea id={`${id}-description`} className="ui-textarea text-xs" rows={3} maxLength={1000} value={draft.description} disabled={locked} onChange={(event) => change('description', event.target.value)} /></div>
      {node && <>
        <div className="ui-field"><label className="ui-label" htmlFor={`${id}-aliases`}>{t('别名，用逗号分隔')}</label>
          <input id={`${id}-aliases`} className="ui-input ui-input--sm" maxLength={480} value={aliases} disabled={locked}
            onChange={(event) => { setAliases(event.target.value); updateNode({ aliases: [...new Set(event.target.value.split(/[,，]/).map((entry) => entry.trim()).filter(Boolean))] }); }} /></div>
        {(node.kind === 'event' || node.kind === 'foreshadow') && <>
          <div className="ui-field"><label className="ui-label" htmlFor={`${id}-order`}>{t('叙事顺序')}</label>
            <div className="flex items-center gap-2"><NumberStepper id={`${id}-order`} size="sm" className="min-w-0 flex-1" min={0} max={100000} step={1} value={node.storyOrder ?? 0} disabled={locked}
              onChange={(storyOrder) => updateNode({ storyOrder })} /><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={locked || node.storyOrder === undefined} onClick={() => updateNode({ storyOrder: undefined })}>{t('清除')}</button></div></div>
          <div className="ui-field"><label className="ui-label" htmlFor={`${id}-time`}>{t('故事内时间')}</label>
            <input id={`${id}-time`} className="ui-input ui-input--sm" maxLength={120} value={node.storyTime ?? ''} disabled={locked} onChange={(event) => updateNode({ storyTime: event.target.value || undefined })} /></div>
        </>}
        {node.kind === 'foreshadow' && <div className="ui-field"><label className="ui-label" htmlFor={`${id}-foreshadow`}>{t('伏笔状态')}</label>
          <Select<'planted' | 'developing' | 'resolved'> id={`${id}-foreshadow`} size="sm" value={node.foreshadowStatus ?? 'planted'} disabled={locked}
            options={[{ value: 'planted', label: t('已埋设') }, { value: 'developing', label: t('推进中') }, { value: 'resolved', label: t('已回收') }]}
            onChange={(foreshadowStatus) => updateNode({ foreshadowStatus })} /></div>}
        <div className="ui-field"><label className="ui-label" htmlFor={`${id}-asset`}>{t('关联正式资产')}</label>
          <Select id={`${id}-asset`} size="sm" value={node.asset ? `${node.asset.kind}:${node.asset.id}` : ''} disabled={locked}
            options={[{ value: '', label: t('不关联资产') }, ...assets.map((asset) => ({ value: `${asset.kind}:${asset.id}`, label: asset.label })),
              ...(node.asset && !assets.some((asset) => asset.id === node.asset?.id && asset.kind === node.asset.kind) ? [{ value: `${node.asset.kind}:${node.asset.id}`, label: t('关联资产已移除'), disabled: true }] : [])]}
            onChange={(value) => { const asset = assets.find((entry) => `${entry.kind}:${entry.id}` === value); updateNode({ asset: asset ? { kind: asset.kind, id: asset.id } : undefined }); }} />
          {detail.assetAvailable === false && <p className="ui-hint">{t('关联资产已移除，记录仍保留。')}</p>}
        </div>
      </>}
      <fieldset disabled={locked} className="space-y-1.5"><legend className="ui-label">{t('关联分集')}</legend>
        <div className="flex max-h-32 flex-wrap gap-x-3 gap-y-2 overflow-y-auto">
          {episodes.map((episode) => <span key={episode.id} className="relative min-w-0 max-w-full">
            <input id={`${id}-episode-${episode.id}`} type="checkbox" className="ui-checkbox" checked={draft.episodeIds.includes(episode.id)}
              onChange={(event) => change('episodeIds', event.target.checked ? [...draft.episodeIds, episode.id] : draft.episodeIds.filter((entry) => entry !== episode.id))} />
            <label htmlFor={`${id}-episode-${episode.id}`}><span className="max-w-48 truncate" title={episode.name}>{episode.name}</span></label>
          </span>)}
        </div>
        {draft.episodeIds.some((entry) => !episodeNames.has(entry)) && <p className="ui-hint">{t('部分来源分集已移除，记录仍保留。')}</p>}
      </fieldset>
      <section className="space-y-2 border-t border-canvas-border pt-3" aria-label={t('原文证据')}>
        <h4 className="ui-label">{t('原文证据')}</h4>
        {draft.evidence.length === 0 && <p className="ui-hint">{t('尚无原文证据；人工说明与推断不会自动变成原文事实。')}</p>}
        {draft.evidence.map((evidence, index) => <div key={`${evidence.episodeId}-${evidence.part}-${evidence.start}-${index}`} className="ui-card p-2 text-xs">
          <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words text-canvas-text-secondary">{episodeNames.get(evidence.episodeId) ?? t('来源分集已移除')} · {evidence.part === 'script' ? t('本集剧本') : t('本集大纲')}</span>
            <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={locked} aria-label={t('移除证据')} onClick={() => removeEvidence(index)}><Icon icon="lucide:x" width="12" /></button></div>
          <p className="my-2 whitespace-pre-wrap break-words text-canvas-text">{evidence.quote}</p>
          <div className="flex flex-wrap items-center justify-between gap-1"><span className={statuses[index] === 'current' ? 'text-canvas-text-muted' : 'text-warning-light'}>
            {statuses[index] === 'current' ? t('原文匹配') : statuses[index] === 'missing' ? t('来源已缺失') : t('来源已变化')}</span>
            <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} onClick={() => void run(() => onLocateEvidence(evidence))}>{t('查看出处')}</button></div>
        </div>)}
        {draft.evidence.length < 4 && <div className="ui-card gap-2 p-2">
          <label className="ui-label" htmlFor={`${id}-quote`}>{t('从已保存稿件绑定摘录')}</label>
          <Select size="sm" value={evidenceQuery.episodeId} aria-label={t('证据分集')} disabled={locked || !episodes.length}
            options={episodes.map((episode) => ({ value: episode.id, label: episode.name }))} onChange={(episodeId) => setEvidenceQuery((current) => ({ ...current, episodeId }))} />
          <Select<StoryGraphPart> size="sm" value={evidenceQuery.part} aria-label={t('证据稿件类型')} disabled={locked}
            options={[{ value: 'script', label: t('本集剧本') }, { value: 'outline', label: t('本集大纲') }]} onChange={(part) => setEvidenceQuery((current) => ({ ...current, part }))} />
          <textarea id={`${id}-quote`} className="ui-textarea text-xs" rows={2} maxLength={240} value={evidenceQuery.quote} disabled={locked}
            placeholder={t('粘贴不超过 240 字的原文摘录')} onChange={(event) => setEvidenceQuery((current) => ({ ...current, quote: event.target.value }))} />
          <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={locked || !evidenceQuery.episodeId || !evidenceQuery.quote.trim()}
            onClick={() => void run(async () => {
              const evidence = await onResolveEvidence(evidenceQuery);
              change('evidence', [...draft.evidence, evidence]);
              setStatuses((current) => [...current, 'current']);
              setEvidenceQuery((current) => ({ ...current, quote: '' }));
            })}>{t('核对并绑定摘录')}</button>
        </div>}
      </section>
      {error && <p role="alert" className="ui-error break-words">{t(error)}</p>}
      {deleting ? <div role="alertdialog" aria-label={t('确认删除故事记录')} className="ui-alert ui-alert--warning space-y-2 text-xs">
        <p>{node ? t('删除记录将同时移除关联连线，原稿和正式资产不会删除。') : t('仅删除这条关系，关联记录和原稿会保留。')}</p>
        <div className="flex justify-end gap-2"><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} onClick={() => setDeleting(false)}>{t('取消')}</button>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--danger" disabled={locked} onClick={() => void run(() => onDelete({ kind: edge ? 'edge' : 'node', id: draft.id }))}>{t('确认删除')}</button></div>
      </div> : <div className="flex items-center justify-between gap-2 border-t border-canvas-border pt-3">
        {!isNew ? <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost text-danger-light" disabled={locked} onClick={() => setDeleting(true)}>{t('删除记录')}</button> : <span />}
        <button type="submit" className="ui-btn ui-btn--sm ui-btn--primary" disabled={locked || !draft.label.trim()}>{busy ? t('保存中…') : t('保存记录')}</button>
      </div>}
    </form>
  </aside>;
}
