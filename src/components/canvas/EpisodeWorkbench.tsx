import { memo, useEffect, useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CheckCircle2, LayoutGrid, ListVideo, Play } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import { episodeShotGroups, shotVideoNodes } from '../../utils/episodeLayout';
import { checkVideoServices, inspectVideoNode } from '../../services/videoBatchPlanning';
import type { VideoBatchItemStatus, VideoBatchScope, VideoPreflightItem } from '../../types/videoBatch';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';

const statusLabels: Record<VideoBatchItemStatus, string> = {
  waiting: '等待', running: '生成中', success: '已完成', error: '失败', cancelled: '未提交', unknown: '待核对',
};

function EpisodeWorkbench() {
  const t = useT();
  const projectId = useAppStore((s) => s.currentProjectId);
  const projectName = useAppStore((s) => s.projectName);
  const nodes = useAppStore((s) => s.nodes);
  const selected = useAppStore((s) => s.selectedNodeIds);
  const batchesByProject = useAppStore((s) => s.videoBatches);
  const busy = useAppStore((s) => s.videoBatchBusy);
  const loadBatches = useAppStore((s) => s.loadVideoBatches);
  const { fitView } = useReactFlow();
  const [scope, setScope] = useState<VideoBatchScope>('episode');
  const [columns, setColumns] = useState(3);
  const [checking, setChecking] = useState(false);
  const [panel, setPanel] = useState<'check' | 'queue' | null>(null);
  const [check, setCheck] = useState<{ projectId: string; items: VideoPreflightItem[] } | null>(null);
  const [regenerate, setRegenerate] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const groups = useMemo(() => episodeShotGroups(nodes), [nodes]);
  const candidates = useMemo(() => shotVideoNodes(nodes, scope === 'selected' ? selected : undefined), [nodes, selected, scope]);
  const batches = projectId ? batchesByProject[projectId] || [] : [];
  const items = check?.projectId === projectId ? check.items : [];
  const ready = items.filter((i) => !i.issues.length && (!i.existing || i.stale || regenerate));
  const unresolved = batches.some((b) => b.items.some((i) => i.status === 'unknown' && ready.some((r) => r.nodeId === i.nodeId)));
  const notify = (error: unknown) => useAppStore.getState().showToast(error instanceof Error ? error.message : t('操作失败'), 'error');

  useEffect(() => {
    if (projectId) void loadBatches(projectId).catch(() => useAppStore.getState().showToast('无法读取视频队列记录', 'error'));
  }, [projectId, loadBatches]);

  const focus = (ids: string[]) => {
    setPanel(null);
    void fitView({ nodes: ids.map((id) => ({ id })), padding: 0.3, duration: 250, maxZoom: 0.9 });
  };

  const inspect = async (ids?: string[]) => {
    if (checking || !projectId) return;
    const state = useAppStore.getState();
    const list = ids ? state.nodes.filter((n) => ids.includes(n.id) && n.data.type === 'ai-video')
      : shotVideoNodes(state.nodes, scope === 'selected' ? state.selectedNodeIds : undefined);
    const planned = list.map((n) => inspectVideoNode(n, state))
      .filter((i) => ids || scope !== 'pending' || !i.existing || i.stale
        || state.nodes.find((n) => n.id === i.nodeId)?.data.status === 'error');
    setChecking(true); setRegenerate(Boolean(ids)); setAcknowledged(false);
    try {
      const checked = await checkVideoServices(planned, state);
      if (useAppStore.getState().currentProjectId !== projectId) return;
      setCheck({ projectId, items: checked }); setPanel('check');
    } catch (error) { notify(error); }
    finally { setChecking(false); }
  };

  const layout = () => {
    const ids = useAppStore.getState().layoutEpisodeGroups(scope === 'selected', columns);
    if (ids.length) focus(ids.slice(0, columns));
  };
  const submit = () => {
    if (!projectId || !ready.length || busy || (unresolved && !acknowledged)) return;
    const operation = useAppStore.getState().startVideoBatch(projectId, ready);
    setPanel('queue');
    void operation.catch(notify);
  };
  if (!groups.length && !nodes.some((n) => n.data.type === 'ai-video') && !batches.length) return null;

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
        <span className="whitespace-nowrap px-1 text-[11px] text-canvas-text-secondary/70">{candidates.length} {t('视频')}</span>
        <Select fixedMenu size="sm" className="w-[56px] shrink-0" aria-label={t('布局列数')} value={columns} onChange={(value) => setColumns(Number(value))}>
          {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} {t('列')}</option>)}
        </Select>
        <button className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" title={t('统一布局')} aria-label={t('统一布局')} onClick={layout} disabled={busy || !groups.length}><LayoutGrid size={14} aria-hidden="true" /></button>
        <button className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" title={checking ? t('检查中') : t('检查物料')} aria-label={checking ? t('检查中') : t('检查物料')} onClick={() => void inspect()} disabled={checking || !candidates.length}><CheckCircle2 size={14} aria-hidden="true" /></button>
        <button className="ui-btn ui-btn--sm ui-btn--primary" title={busy ? t('批次执行中') : t('生成本集视频')} aria-label={busy ? t('批次执行中') : t('生成本集视频')} onClick={() => void inspect()} disabled={busy || checking || !candidates.length}><Play size={14} aria-hidden="true" /></button>
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
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={regenerate} onChange={(e) => setRegenerate(e.target.checked)} />{t('已有结果也重新生成，并保留旧版本')}</label>
          {unresolved && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />{t('已核对上次未确认的任务与输出，确认需要再次提交')}</label>}
          <div className="overflow-auto min-h-0"><table className="w-full text-sm"><thead><tr className="text-left text-canvas-text-secondary"><th className="p-2">{t('镜头')}</th><th className="p-2">{t('生成时长')}</th><th className="p-2">{t('检查结果')}</th></tr></thead><tbody>
            {items.map((i) => <tr key={i.nodeId} className="border-t border-canvas-border"><td className="p-2"><button className="text-left hover:underline" onClick={() => focus([i.nodeId])}>{i.label}</button></td><td className="p-2 whitespace-nowrap">{i.duration ? `${i.duration}s` : t('模型默认')}</td><td className="p-2">{i.issues.length ? i.issues.join('；') : i.stale ? t('参考或参数已更新') : i.existing && !regenerate ? t('已有结果，跳过') : t('就绪')}</td></tr>)}
          </tbody></table>{!items.length && <p className="py-6 text-center text-canvas-text-secondary">{t('当前范围没有可生成的视频镜头')}</p>}</div>
          <div className="flex justify-end gap-2"><button className="ui-btn" onClick={() => setPanel(null)}>{t('关闭')}</button><button className="ui-btn ui-btn--primary" disabled={!ready.length || busy || (unresolved && !acknowledged)} onClick={submit}>{t('生成就绪镜头')} ({ready.length})</button></div>
        </> : <>
          <p className="text-sm text-canvas-text-secondary">{t('切换项目会停止后续提交。重开后不会自动重投，待核对任务需先检查服务与输出。取消等待不会中断已经提交的任务。')}</p>
          <div className="overflow-auto min-h-0 space-y-5">
            {[...batches].reverse().map((batch) => <section key={batch.id} className="border border-canvas-border rounded-lg p-3">
              <div className="flex flex-wrap justify-between items-center gap-2 mb-2"><span className="text-sm">{new Date(batch.createdAt).toLocaleString()} · {t('完成')} {batch.items.filter((i) => i.status === 'success').length}/{batch.items.length}</span><div className="flex gap-2">
                <button className="ui-btn ui-btn--sm" disabled={!batch.items.some((i) => i.status === 'waiting')} onClick={() => projectId && void useAppStore.getState().cancelWaitingVideos(projectId, batch.id).catch(notify)}>{t('取消等待')}</button>
                <button className="ui-btn ui-btn--sm" disabled={busy || checking || !batch.items.some((i) => i.status === 'error')} onClick={() => void inspect(batch.items.filter((i) => i.status === 'error').map((i) => i.nodeId))}>{t('重试失败项')}</button>
              </div></div>
              {batch.items.map((i) => <div key={i.nodeId} className="flex flex-wrap gap-x-3 gap-y-1 py-2 border-t border-canvas-border text-sm"><button className="text-left flex-1 min-w-0 hover:underline" onClick={() => focus([i.nodeId])}>{i.label}</button><span className="text-canvas-text-secondary">{t(statusLabels[i.status])}</span>{i.message && <span className="w-full text-xs text-canvas-text-secondary">{i.message}</span>}</div>)}
            </section>)}
            {!batches.length && <p className="py-8 text-center text-canvas-text-secondary">{t('本集暂无视频批次')}</p>}
          </div>
        </>}
      </div>
    </ModalOverlay>
  </>;
}

export default memo(EpisodeWorkbench);
