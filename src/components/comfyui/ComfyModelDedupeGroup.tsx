import { useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { ComfyDuplicateModelGroup, ComfyModelDedupeGroupSelection, ComfyModelDedupeRequest, ComfyModelLinkType } from '../../types/comfyModelDedupe';
import { formatSize } from '../../utils/assetFormat';
import { defaultComfyModelSelection, MAX_COMFY_MODEL_DEDUPE_TARGETS } from '../../utils/comfyModelDedupeSelection';
import ModalOverlay from '../shared/ModalOverlay';
import Select from '../shared/Select';

interface Props {
  group: ComfyDuplicateModelGroup;
  scanId: string;
  busy: boolean;
  selection: ComfyModelDedupeGroupSelection;
  onSelectionChange: (selection: ComfyModelDedupeGroupSelection) => void;
  onApply: (request: ComfyModelDedupeRequest) => void;
}

export default function ComfyModelDedupeGroup({ group, scanId, busy, selection, onSelectionChange, onApply }: Props) {
  const t = useT();
  const { keeperId, linkType } = selection;
  const targets = new Set(selection.targetIds);
  const [confirming, setConfirming] = useState(false);
  const keeper = group.files.find((file) => file.id === keeperId);
  const selectedTargets = group.files.filter((file) => targets.has(file.id) && file.id !== keeperId && !file.alreadyShared);
  const selectKeeper = (id: string) => {
    onSelectionChange({ ...defaultComfyModelSelection(group, id), linkType });
  };

  return <article className="ui-card p-3 gap-3">
    <div className="ui-row ui-row--between flex-wrap">
      <div className="ui-row flex-wrap"><Icon icon="lucide:files" width={16} /><h3 className="text-sm font-medium">{t('{count} 个相同内容的模型文件', { count: group.files.length })}</h3><span className="ui-badge ui-badge--outline">{formatSize(group.size)}{t(' / 份')}</span></div>
      <span className="text-xs text-canvas-text-secondary">{t('本组最多可释放 {size}', { size: formatSize(group.reclaimableBytes) })}</span>
    </div>
    <p className="ui-hint break-all select-text" title={group.hash}>BLAKE3 · {group.hash}</p>
    <div className="rounded-lg border border-canvas-border overflow-hidden">
      <table className="ui-table"><thead><tr><th className="w-20">{t('保留')}</th><th className="w-20">{t('替换')}</th><th>{t('原文件名与路径')}</th></tr></thead><tbody>
        {group.files.map((file) => <tr key={file.id}>
          <td><input type="radio" name={`keeper-${group.id}`} className="accent-brand cursor-pointer" aria-label={t('保留 {path}', { path: file.relativePath })} checked={keeperId === file.id} disabled={busy} onChange={() => selectKeeper(file.id)} /></td>
          <td><input type="checkbox" className="accent-brand cursor-pointer" aria-label={t('替换 {path}', { path: file.relativePath })} checked={targets.has(file.id) && file.id !== keeperId && !file.alreadyShared} disabled={busy || file.id === keeperId || file.alreadyShared || (!targets.has(file.id) && targets.size >= MAX_COMFY_MODEL_DEDUPE_TARGETS)} onChange={(event) => {
            const checked = event.target.checked;
            const next = new Set(targets);
            if (checked && next.size < MAX_COMFY_MODEL_DEDUPE_TARGETS) next.add(file.id);
            else if (!checked) next.delete(file.id);
            onSelectionChange({ ...selection, targetIds: [...next] });
          }} /></td>
          <td className="min-w-0"><p className="font-mono text-xs break-all select-text">{file.relativePath}</p>{file.alreadyShared && <span className="ui-badge ui-badge--outline mt-1">{t('已有硬链接，仅可作为保留项')}</span>}</td>
        </tr>)}
      </tbody></table>
    </div>
    {group.files.filter((file) => file.id !== keeperId && !file.alreadyShared).length > MAX_COMFY_MODEL_DEDUPE_TARGETS && <p className="ui-hint">{t('每次最多替换 256 份；其余副本可在重新扫描后继续处理。')}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Select<ComfyModelLinkType> value={linkType} onChange={(value) => onSelectionChange({ ...selection, linkType: value })} size="sm" fixedMenu disabled={busy} aria-label={t('链接方式')} className="w-56 max-w-full"
        options={[{ value: 'hardlink', label: t('硬链接（同一磁盘，推荐）') }, { value: 'symlink', label: t('软链接（需系统权限）') }]} />
      <span className="ui-hint flex-1">{t('预计释放 {size}', { size: formatSize(group.size * selectedTargets.length) })}</span>
      <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !keeper || !selectedTargets.length} onClick={() => setConfirming(true)}><Icon icon="lucide:link" width={14} />{t('预览并替换 {count} 项', { count: selectedTargets.length })}</button>
    </div>
    <ModalOverlay isOpen={confirming} onClose={() => setConfirming(false)} ariaLabel={t('确认模型链接替换')} className="w-[calc(100%_-_24px)] max-w-2xl bg-canvas-surface" zIndex={260}>
      <div className="p-3 space-y-3">
        <h2 className="text-sm font-semibold">{t('确认模型链接替换')}</h2>
        <p className="ui-hint">{t('请先停止 ComfyUI 和模型下载。每个目标保留原路径与文件名，改为读取保留副本的内容。执行前还会重新校验内容并弹出系统确认。')}</p>
        <div className="ui-card p-3 gap-2"><p className="ui-label">{t('保留副本')}</p><p className="font-mono text-xs break-all select-text">{keeper?.relativePath}</p></div>
        <div role="region" aria-label={t('待替换模型路径')} tabIndex={0} className="ui-scroll max-h-48 rounded-lg border border-canvas-border p-2"><ul className="space-y-2 text-xs font-mono">{selectedTargets.map((file) => <li key={file.id} className="break-all select-text">{file.relativePath}</li>)}</ul></div>
        <div className="ui-alert ui-alert--warning">{t('链接共享文件内容；任一插件原地改写权重会影响其他路径。软链接的保留副本被移动或删除后会失效。')}</div>
        <div className="ui-row ui-row--between flex-wrap"><span className="text-xs">{linkType === 'hardlink' ? t('硬链接') : t('软链接')} · {t('预计释放 {size}', { size: formatSize(group.size * selectedTargets.length) })}</span>
          <div className="ui-row"><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => setConfirming(false)}>{t('取消')}</button><button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !selectedTargets.length} onClick={() => {
            setConfirming(false);
            onApply({ scanId, groupId: group.id, keeperId, targetIds: selectedTargets.map((file) => file.id), linkType });
          }}>{t('继续')}</button></div>
        </div>
      </div>
    </ModalOverlay>
  </article>;
}
