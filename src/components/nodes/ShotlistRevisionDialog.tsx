import { useId, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { buildShotlistRevisionPrompt, getShotlistScriptChange } from '../../services/shotlistRevisionService';
import { useT } from '../../i18n';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';

export default function ShotlistRevisionDialog({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const t = useT();
  const inputPrefix = useId();
  const snapshot = useAppStore(useShallow((state) => ({ nodes: state.nodes, projects: state.projects, projectId: state.currentProjectId, ready: state.projectLoadStatus })));
  const [selection, setSelection] = useState<string[]>([]);
  const rows = snapshot.nodes.find((node) => node.id === nodeId)?.data.shotlistRows ?? [];
  const result = useMemo(() => {
    try { return { change: getShotlistScriptChange({ projectId: snapshot.projectId ?? '' }, nodeId) }; }
    catch (error) { return { error: error instanceof Error ? error.message : t('检查剧本变化失败') }; }
  }, [snapshot, nodeId, t]);
  const selected = selection.filter((id) => rows.some((row) => row.id === id));
  const prepare = () => {
    try {
      const state = useAppStore.getState();
      state.openChatWithDraft(buildShotlistRevisionPrompt({ projectId: state.currentProjectId ?? '' }, nodeId, selected));
      onClose();
    } catch (error) { useAppStore.getState().showToast(error instanceof Error ? error.message : t('检查剧本变化失败'), 'error'); }
  };
  return <ModalOverlay isOpen onClose={onClose} ariaLabel={t('剧本改动复核')}>
    <div className="ui-card flex max-h-[80vh] w-[min(860px,calc(100vw-32px))] flex-col overflow-hidden text-canvas-text">
      <header className="ui-card__header flex items-center gap-2"><h2 className="flex-1 text-sm font-semibold">{t('剧本改动复核')}</h2><PopupCloseButton onClick={onClose} ariaLabel={t('关闭剧本改动复核')} /></header>
      <div className="min-h-0 overflow-y-auto p-4">
        {result.error ? <p role="alert" className="text-sm">{result.error}</p> : result.change && <>
          <p className="mb-3 text-xs text-canvas-text-secondary">{result.change.changed ? t('剧本与来源快照不同，请选择需要助手复核的镜头。') : t('剧本与来源快照一致')}</p>
          {result.change.changed && <>
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <section className="ui-card p-3"><h3 className="mb-2 text-xs font-semibold">{t('来源快照的变化范围')}</h3><pre className="whitespace-pre-wrap break-words font-sans text-xs leading-6">{result.change.beforePreview || t('此处为空')}</pre></section>
              <section className="ui-card p-3"><h3 className="mb-2 text-xs font-semibold">{t('当前剧本的变化范围')}</h3><pre className="whitespace-pre-wrap break-words font-sans text-xs leading-6">{result.change.afterPreview || t('此处为空')}</pre></section>
            </div>
            <p className="mb-3 text-xs text-canvas-text-muted">{t('这里只提示文本变化范围；助手会读取完整正文，判断所选镜头是否需要调整。')}</p>
            {result.change.previewTruncated && <p className="mb-3 text-xs text-canvas-text-muted">{t('较长差异仅显示开头部分')}</p>}
            <button type="button" className="ui-btn ui-btn--sm mb-2" onClick={() => setSelection(selected.length === rows.length ? [] : rows.map((row) => row.id))}>{t('全选或清空')}</button>
            <div className="grid gap-2 sm:grid-cols-2">{rows.map((row) => <div key={row.id} className="ui-card min-w-0 p-2 text-xs">
              <input id={`${inputPrefix}-${row.id}`} type="checkbox" className="ui-checkbox" checked={selected.includes(row.id)} onChange={(event) => setSelection((current) => event.target.checked ? [...new Set([...current, row.id])] : current.filter((id) => id !== row.id))} />
              <label htmlFor={`${inputPrefix}-${row.id}`} className="flex min-w-0 gap-2"><span className="shrink-0">{t('镜头 {number}', { number: row.shotNo })}</span><span className="truncate text-canvas-text-secondary">{row.content || row.dialogue || '—'}</span></label>
            </div>)}</div>
          </>}
        </>}
      </div>
      <footer className="ui-card__footer flex justify-end gap-2"><button type="button" className="ui-btn ui-btn--primary" disabled={!result.change?.changed || !selected.length} onClick={prepare}>{t('让助手调整所选镜头')}</button></footer>
    </div>
  </ModalOverlay>;
}
