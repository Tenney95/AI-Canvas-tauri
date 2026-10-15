import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import DownloadProgress from './DownloadProgress';
import ModalOverlay from './ModalOverlay';

/** 单独订阅下载展示，避免字节进度带动画布重新渲染。 */
export default function NodeOutputDownloadDialog({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  const download = useAppStore((state) => state.nodeOutputDownload);

  return <ModalOverlay
    isOpen={download !== null}
    onClose={onCancel}
    closeOnBackdrop={false}
    ariaLabel={t('另存为')}
    className="w-80 max-w-[calc(100vw-2rem)]"
  >
    {download ? <div className="space-y-3 p-3">
      <h2 className="text-sm font-semibold text-canvas-text">{t('另存为')}</h2>
      <p className="truncate text-xs text-canvas-text-secondary" title={download.fileName}>{download.fileName}</p>
      <DownloadProgress
        downloadedBytes={download.transferredBytes}
        totalBytes={download.totalBytes ?? undefined}
        label={download.phase === 'saving' ? t('正在保存文件…') : t('正在下载文件…')}
      />
      <div className="flex justify-end">
        <button
          type="button"
          className="ui-btn ui-btn--secondary ui-btn--sm"
          disabled={download.phase === 'saving'}
          onClick={onCancel}
        >{t('取消下载')}</button>
      </div>
    </div> : null}
  </ModalOverlay>;
}
