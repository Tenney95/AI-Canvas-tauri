import { useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { ComfyModelDedupeBatchRequest, ComfyModelDedupeGroupRequest, ComfyModelDedupeScan } from '../../types/comfyModelDedupe';
import { formatSize } from '../../utils/assetFormat';
import { MAX_COMFY_MODEL_DEDUPE_TARGETS } from '../../utils/comfyModelDedupeSelection';
import ModalOverlay from '../shared/ModalOverlay';

interface Props {
  scan: ComfyModelDedupeScan | null;
  groups: ComfyModelDedupeGroupRequest[];
  busy: boolean;
  onApply: (request: ComfyModelDedupeBatchRequest) => void;
  onOpenHistory: () => void;
}

export default function ComfyModelDedupeActions({ scan, groups, busy, onApply, onOpenHistory }: Props) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const groupById = new Map(scan?.groups.map((group) => [group.id, group]));
  const count = groups.reduce((sum, group) => sum + group.targetIds.length, 0);
  const size = groups.reduce((sum, group) => sum + (groupById.get(group.groupId)?.size ?? 0) * group.targetIds.length, 0);
  const skipped = scan?.skippedEntries ?? [];
  const tooMany = count > MAX_COMFY_MODEL_DEDUPE_TARGETS;

  return <div className="flex shrink-0 flex-wrap items-start justify-between gap-2">
    {scan && (!!scan.warnings.length || !!scan.skippedFiles) && <details className="min-w-0 flex-1 basis-72 text-xs text-canvas-text-secondary">
      <summary className="cursor-pointer">{t('扫描说明 {count} 条 · 跳过 {skipped} 项', { count: scan.warnings.length, skipped: scan.skippedFiles })}</summary>
      <div className="ui-scroll mt-2 max-h-48 space-y-2 rounded-lg border border-canvas-border p-2">
        {!!scan.warnings.length && <ul className="space-y-1">{scan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        {!!skipped.length && <ul className="space-y-2 border-t border-canvas-border pt-2">{skipped.map((entry, index) => <li key={index}><p className="break-all font-mono select-text">{entry.relativePath}</p><p className="text-canvas-text-muted">{entry.reason}</p></li>)}</ul>}
        {!!scan.omittedSkippedEntries && <p>{t('另有 {count} 项未展开，请缩小范围查看。', { count: scan.omittedSkippedEntries })}</p>}
        {!!scan.skippedFiles && !skipped.length && !scan.omittedSkippedEntries && <p>{t('本次结果没有具体跳过列表，重新扫描后可查看。')}</p>}
      </div>
    </details>}
    <div className="ml-auto flex flex-wrap justify-end gap-2">
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={onOpenHistory}><Icon icon="lucide:history" width={14} />{t('替换历史')}</button>
      {scan && <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !count || tooMany} onClick={() => setConfirming(true)}><Icon icon="lucide:replace-all" width={14} />{t('全部替换（{count} 项）', { count })}</button>}
      {tooMany && <p className="ui-hint basis-full text-right">{t('单批最多 256 项，请取消部分勾选或逐组处理后重新扫描。')}</p>}
    </div>
    <ModalOverlay isOpen={confirming && !!scan} onClose={() => setConfirming(false)} ariaLabel={t('预览全部模型替换')} className="flex max-h-[85vh] w-[calc(100%_-_24px)] max-w-3xl flex-col bg-canvas-surface" zIndex={260}>
      <div className="shrink-0 border-b border-canvas-border p-3 space-y-2">
        <h2 className="text-sm font-semibold">{t('预览全部模型替换')}</h2>
        <p className="ui-hint">{t('按各组当前的保留项、替换勾选和链接方式执行，包含搜索隐藏及尚未展开的组。请先停止 ComfyUI 和模型下载。')}</p>
        <p className="text-xs">{t('{groups} 组 · {count} 项 · 预计释放 {size}', { groups: groups.length, count, size: formatSize(size) })}</p>
      </div>
      <div className="ui-scroll min-h-0 flex-1 space-y-2 p-3">
        {groups.map((request) => {
          const group = groupById.get(request.groupId);
          if (!group) return null;
          const keeper = group.files.find((file) => file.id === request.keeperId);
          return <div key={request.groupId} className="ui-card p-3 gap-2 text-xs">
            <div className="ui-row ui-row--between"><span>{request.linkType === 'hardlink' ? t('硬链接') : t('软链接')}</span><span>{formatSize(group.size)}{t(' / 份')}</span></div>
            <p className="break-all font-mono select-text">{t('保留：')}{keeper?.relativePath}</p>
            <ul className="space-y-1 text-canvas-text-secondary">{group.files.filter((file) => request.targetIds.includes(file.id)).map((file) => <li key={file.id} className="break-all font-mono select-text">{t('替换：')}{file.relativePath}</li>)}</ul>
          </div>;
        })}
      </div>
      <div className="shrink-0 border-t border-canvas-border p-3 space-y-3">
        <p className="ui-hint">{t('链接共享内容，原地改写可能影响其他路径。每项会重新验证；遇到失败即停止，已完成项保留，并记录处理历史。')}</p>
        <div className="ui-row justify-end"><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => setConfirming(false)}>{t('取消')}</button><button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !scan || !count || tooMany} onClick={() => {
          if (!scan) return;
          setConfirming(false);
          onApply({ scanId: scan.scanId, groups });
        }}>{t('继续并确认替换')}</button></div>
      </div>
    </ModalOverlay>
  </div>;
}
