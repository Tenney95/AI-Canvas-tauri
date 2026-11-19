import { lazy, Suspense, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';

const ProjectImportRecoveryDialog = lazy(() => import('./ProjectImportRecoveryDialog'));

export default function ProjectTransferNotice({ ownerId }: { ownerId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const block = useAppStore((state) => state.nativeProjectWriteBlock);
  const status = useAppStore((state) => state.projectLoadStatus);
  return <>
    {status === 'readonly' && block && (
      <div className="ui-alert ui-alert--warning absolute bottom-3 left-1/2 z-[175] w-max max-w-[calc(100%_-_1.5rem)] -translate-x-1/2 items-center">
        <span role="status">{t(block.phase === 'db_committed' ? '项目更新已写入，完成收尾后可编辑。' : '项目更新尚未完成，当前画布为只读。')}</span>
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm shrink-0" onClick={() => setOpen(true)}>{t('处理原操作')}</button>
      </div>
    )}
    {open && <Suspense fallback={null}><ProjectImportRecoveryDialog ownerId={ownerId} onClose={() => setOpen(false)} /></Suspense>}
  </>;
}
