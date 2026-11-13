/**
 * EpisodeWorkbench — 提供分集画布工作台界面与交互。
 */
import { memo, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CheckCircle2, LayoutGrid, ListVideo, Play } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { t as translate, useT } from '../../i18n';
import { episodeWorkbenchSummary, shotVideoNodes } from '../../utils/episodeLayout';
import { checkVideoServices, inspectVideoNode } from '../../services/videoBatchPlanning';
import { isUnresolvedVideoBatchStatus, latestVideoBatchItems } from '../../services/videoBatchRunner';
import { expandShotlistRowMentions } from '../../services/shotlistPromptService';
import type { VideoBatchItem, VideoBatchItemStatus, VideoBatchScope, VideoPreflightItem } from '../../types/videoBatch';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';

const statusLabels: Record<VideoBatchItemStatus, string> = {
  waiting: '等待', running: '生成中', success: '已完成', error: '失败', cancelled: '未提交', unknown: '待核对',
  paused: '查询已暂停', delivery_pending: '待保存原结果',
};

function EpisodeWorkbench() {
  const t = useT();
  const projectId = useAppStore((s) => s.currentProjectId);
  const projectName = useAppStore((s) => s.projectName);
  const [scope, setScope] = useState<VideoBatchScope>('episode');
  const { groupCount, videoCount, hasVideoNodes } = useAppStore(useShallow((s) => (
    episodeWorkbenchSummary(s.nodes, scope === 'selected' ? s.selectedNodeIds : undefined)
  )));
  const batchesByProject = useAppStore((s) => s.videoBatches);
  const busy = useAppStore((s) => s.videoBatchBusy);
  const loadBatches = useAppStore((s) => s.loadVideoBatches);
  const [columns, setColumns] = useState(3);
  const [checking, setChecking] = useState(false);
  const inspectController = useRef<AbortController | null>(null);
  const [panel, setPanel] = useState<'check' | 'queue' | null>(null);
  const [check, setCheck] = useState<{ projectId: string; items: VideoPreflightItem[] } | null>(null);
  const [regenerate, setRegenerate] = useState(false);
  const [acknowledged, setAcknowledged] = useState<ReadonlyMap<string, VideoBatchItem> | null>(null);
  const batches = projectId ? batchesByProject[projectId] || [] : [];
  const items = check?.projectId === projectId ? check.items : [];
  const ready = items.filter((i) => !i.issues.length && (!i.existing || i.stale || regenerate));
  const latestItems = latestVideoBatchItems(batches);
  const unresolved = new Map(ready.flatMap(({ nodeId }) => {
    const item = latestItems.get(nodeId);
    return item && isUnresolvedVideoBatchStatus(item.status) ? [[nodeId, item] as const] : [];
  }));
  const hasAcknowledged = [...unresolved].every(([nodeId, item]) => acknowledged?.get(nodeId) === item);
  const notify = (error: unknown) => useAppStore.getState().showToast(t(error instanceof Error ? error.message : '操作失败'), 'error');

  useEffect(() => {
    if (projectId) void loadBatches(projectId).catch(() => useAppStore.getState().showToast(translate('无法读取视频队列记录'), 'error'));
    return () => { inspectController.current?.abort(); };
  }, [projectId, loadBatches]);

  const focus = (ids: string[]) => {
    setPanel(null);
    window.dispatchEvent(new CustomEvent('canvas-focus-nodes', {
      detail: { nodeIds: ids, padding: 0.3, duration: 250, maxZoom: 0.9 },
    }));
  };

  const inspect = async (ids?: string[]) => {
    if (checking || !projectId || inspectController.current) return;
    const controller = new AbortController();
    inspectController.current = controller;
    const isCurrent = () => !controller.signal.aborted && useAppStore.getState().currentProjectId === projectId;
    setChecking(true); setRegenerate(Boolean(ids)); setAcknowledged(null);
    try {
      const initial = useAppStore.getState();
      if (!isCurrent()) return;
      const initialNodes = ids ? initial.nodes.filter((n) => ids.includes(n.id) && n.data.type === 'ai-video')
        : shotVideoNodes(initial.nodes, scope === 'selected' ? initial.selectedNodeIds : undefined);
      const needsGlobals = initialNodes.some((node) => [node.data.prompt || '', ...Object.values(node.data.workflowInputs ?? {})]
        .some((text) => {
          try { return expandShotlistRowMentions(text, initial.nodes).includes('@drama{global/'); }
          catch { return text.includes('@drama{global/'); }
        }));
      if (needsGlobals) await initial.loadGlobalDramaAssets();
      if (!isCurrent()) return;
      const state = useAppStore.getState();
      const targetIds = new Set(initialNodes.map((node) => node.id));
      const list = state.nodes.filter((node) => targetIds.has(node.id) && node.data.type === 'ai-video');
      const planned = list.map((node) => inspectVideoNode(node, state))
        .filter((item) => ids || scope !== 'pending' || !item.existing || item.stale
          || state.nodes.find((node) => node.id === item.nodeId)?.data.status === 'error');
      const checked = await checkVideoServices(planned, state);
      if (!isCurrent()) return;
      setCheck({ projectId, items: checked }); setPanel('check');
    } catch (error) { if (isCurrent()) notify(error); }
    finally { if (inspectController.current === controller) { inspectController.current = null; setChecking(false); } }
  };

  const layout = () => {
    const ids = useAppStore.getState().layoutEpisodeGroups(scope === 'selected', columns);
    if (ids.length) focus(ids.slice(0, columns));
  };
  const submit = () => {
    if (!projectId || !ready.length || busy || !hasAcknowledged) return;
    const operation = useAppStore.getState().startVideoBatch(projectId, ready, undefined, acknowledged ?? undefined);
    setAcknowledged(null);
    setPanel('queue');
    void operation.catch(notify);
  };
  if (!groupCount && !hasVideoNodes && !batches.length) return null;

  return <>
    <div className="pointer-events-none absolute inset-x-3 bottom-2 z-40 flex justify-center">
      <div className="episode-workbench pointer-events-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-1 rounded-[14px] border border-canvas-border bg-canvas-surface/60 backdrop-blur-xl shadow-lg shadow-black/30 select-none" aria-label={t('逐镜工作台')}>
        <span className="max-w-32 truncate px-2 text-[11px] font-semibold text-canvas-text/90" title={projectName}>{projectName}</span>
        <span className="mx-0.5 h-4 w-px bg-[var(--separator-color)]" aria-hidden="true" />
        <div className="flex items-center gap-1 whitespace-nowrap text-[11px] text-canvas-text-secondary/80">
          {t('生成范围')}
          <Select fixedMenu size="sm" className="w-28" aria-label={t('生成范围')} value={scope} onChange={(value) => setScope(value as VideoBatchScope)}>
            <option value="episode">{t('本集镜头')}</option><option value="selected">{t('选中镜头组')}</option><option value="pending">{t('待生成或失败')}</option>
          </Select>
        </div>
        <span className="whitespace-nowrap px-1 text-[11px] text-canvas-text-secondary/70">{videoCount} {t('视频')}</span>
        <Select fixedMenu size="sm" className="w-[56px] shrink-0" aria-label={t('布局列数')} value={columns} onChange={(value) => setColumns(Number(value))}>
          {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} {t('列')}</option>)}
        </Select>
        <button className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" title={t('统一布局')} aria-label={t('统一布局')} onClick={layout} disabled={busy || !groupCount}><LayoutGrid size={14} aria-hidden="true" /></button>
        <button className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" title={checking ? t('检查中') : t('检查物料')} aria-label={checking ? t('检查中') : t('检查物料')} onClick={() => void inspect()} disabled={checking || !videoCount}><CheckCircle2 size={14} aria-hidden="true" /></button>
        <button className="ui-btn ui-btn--sm ui-btn--primary" title={busy ? t('批次执行中') : t('生成本集视频')} aria-label={busy ? t('批次执行中') : t('生成本集视频')} onClick={() => void inspect()} disabled={busy || checking || !videoCount}><Play size={14} aria-hidden="true" /></button>
        <button className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" title={t('查看队列')} aria-label={t('查看队列')} onClick={() => setPanel('queue')}><ListVideo size={14} aria-hidden="true" /></button>
      </div>
    </div>
    <ModalOverlay isOpen={panel !== null} onClose={() => setPanel(null)} ariaLabel={panel === 'check' ? t('视频物料检查') : t('视频生成队列')} className="w-[min(900px,96vw)]">
      <div className="bg-canvas-surface border border-canvas-border rounded-xl p-5 text-canvas-text flex flex-col gap-4 max-h-[85vh]">
        <div className="flex items-center justify-between gap-4"><h2 className="text-lg font-semibold">{panel === 'check' ? t('视频物料检查与提交') : t('视频生成队列')}</h2><PopupCloseButton ariaLabel={t('关闭')} onClick={() => setPanel(null)} /></div>
        {panel === 'check' ? <>
          <p className="text-sm text-canvas-text-secondary">{t('仅生成视频，按镜号串行执行；每镜使用自己的参数，原结果保留在输出历史。')}</p>
          <p className="text-xs text-canvas-text-secondary">{t('检查节点引用和参数，并探测 ComfyUI 在线状态。其他接口的鉴权与可用性在提交时验证；画面质量仍需人工确认。')}</p>
          <div className="flex flex-wrap gap-4 text-sm" role="status"><span>{t('可提交')} {ready.length}</span><span>{t('缺项')} {items.filter((i) => i.issues.length).length}</span><span>{t('已有结果')} {items.filter((i) => i.existing).length}</span><span>{t('待更新')} {items.filter((i) => i.stale).length}</span></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={regenerate} onChange={(e) => { setRegenerate(e.target.checked); setAcknowledged(null); }} />{t('已有结果也重新生成，并保留旧版本')}</label>
          {unresolved.size > 0 && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={hasAcknowledged} onChange={(e) => setAcknowledged(e.target.checked ? unresolved : null)} />{t('已核对上次未确认的任务与输出，确认需要再次提交')}</label>}
          <div className="overflow-auto min-h-0"><table className="w-full text-sm"><thead><tr className="text-left text-canvas-text-secondary"><th className="p-2">{t('镜头')}</th><th className="p-2">{t('生成时长')}</th><th className="p-2">{t('检查结果')}</th></tr></thead><tbody>
            {items.map((i) => <tr key={i.nodeId} className="border-t border-canvas-border"><td className="p-2"><button className="text-left hover:underline" onClick={() => focus([i.nodeId])}>{i.label}</button></td><td className="p-2 whitespace-nowrap">{i.duration ? `${i.duration}s` : t('模型默认')}</td><td className="p-2">{i.issues.length ? i.issues.join('；') : i.stale ? t('参考或参数已更新') : i.existing && !regenerate ? t('已有结果，跳过') : t('就绪')}</td></tr>)}
          </tbody></table>{!items.length && <p className="py-6 text-center text-canvas-text-secondary">{t('当前范围没有可生成的视频镜头')}</p>}</div>
          <div className="flex justify-end gap-2"><button className="ui-btn" onClick={() => setPanel(null)}>{t('关闭')}</button><button className="ui-btn ui-btn--primary" disabled={!ready.length || busy || !hasAcknowledged} onClick={submit}>{t('生成就绪镜头')} ({ready.length})</button></div>
        </> : <>
          <p className="text-sm text-canvas-text-secondary">{t('切换项目会停止后续提交。重开后不会自动重投，待核对任务需先检查服务与输出。取消等待不会中断已经提交的任务。')}</p>
          <div className="overflow-auto min-h-0 space-y-5">
            {[...batches].reverse().map((batch) => {
              const failed = batch.items.filter((item) => item.status === 'error' && latestItems.get(item.nodeId) === item);
              return <section key={batch.id} className="border border-canvas-border rounded-lg p-3">
                <div className="flex flex-wrap justify-between items-center gap-2 mb-2">
                  <span className="text-sm">{new Date(batch.createdAt).toLocaleString()} · {t('完成')} {batch.items.filter((i) => i.status === 'success').length}/{batch.items.length}</span>
                  <div className="flex gap-2">
                    <button className="ui-btn ui-btn--sm" disabled={!batch.items.some((i) => i.status === 'waiting')} onClick={() => projectId && void useAppStore.getState().cancelWaitingVideos(projectId, batch.id).catch(notify)}>{t('取消等待')}</button>
                    <button className="ui-btn ui-btn--sm" disabled={busy || checking || !failed.length} onClick={() => void inspect(failed.map((i) => i.nodeId))}>{t('重试失败项')}</button>
                  </div>
                </div>
                {batch.items.map((i) => <div key={i.nodeId} className="flex flex-wrap gap-x-3 gap-y-1 py-2 border-t border-canvas-border text-sm">
                  <button className="text-left flex-1 min-w-0 hover:underline" onClick={() => focus([i.nodeId])}>{i.label}</button>
                  <span className="text-canvas-text-secondary">{t(statusLabels[i.status])}</span>
                  {projectId && latestItems.get(i.nodeId) === i && (i.recovery?.nativeOperationId || i.recovery?.receipt?.taskId) &&
                    <button type="button" className="ui-btn ui-btn--sm" disabled={busy}
                      onClick={() => void useAppStore.getState().recoverVideoBatchItem(projectId, batch.id, i.nodeId).catch(notify)}>
                      {t('继续查询 / 保存')}
                    </button>}
                  {i.message && <span className="w-full text-xs text-canvas-text-secondary">{t(i.message)}</span>}
                </div>)}
              </section>;
            })}
            {!batches.length && <p className="py-8 text-center text-canvas-text-secondary">{t('本集暂无视频批次')}</p>}
          </div>
        </>}
      </div>
    </ModalOverlay>
  </>;
}

export default memo(EpisodeWorkbench);
