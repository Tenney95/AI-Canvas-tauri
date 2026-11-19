import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { listPendingNativeProjectImports, resumeNativeProjectImport, type PendingNativeProjectImport } from '../../services/nativeProjectImportService';
import { useAppStore } from '../../store/useAppStore';

export default function PendingProjectImports({ suspended }: { suspended: boolean }) {
  const t = useT();
  const [rows, setRows] = useState<PendingNativeProjectImport[]>([]);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [resuming, setResuming] = useState<string | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    if (suspended || resuming !== null) return;
    const controller = new AbortController();
    void listPendingNativeProjectImports(controller.signal).then((pending) => {
      if (controller.signal.aborted) return;
      setRows(pending);
      setError(false);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [suspended, resuming, revision]);

  async function resume(operation: PendingNativeProjectImport) {
    if (suspended || busy.current) return;
    busy.current = true;
    setResuming(operation.operationId);
    try {
      const result = await resumeNativeProjectImport(operation.operationId);
      setRows((pending) => pending.filter((row) => row.operationId !== operation.operationId));
      const state = useAppStore.getState();
      // 收尾后只刷新目录。用户当前画布及未保存的编辑继续留在原处。
      try {
        await state.refreshProjectCatalog();
        state.showToast(t('已导入「{name}」', { name: result.projectName }), 'info');
      } catch {
        state.showToast(t('项目已导入，请重新打开项目库'), 'info');
      }
    } catch (cause) {
      useAppStore.getState().showToast(cause instanceof Error ? cause.message : t('原导入未完成，请重试'), 'error');
    } finally {
      busy.current = false;
      setResuming(null);
    }
  }

  if (!rows.length && !error) return null;
  return <section className="mb-3 space-y-2" aria-label={t('待处理导入')} aria-busy={resuming !== null}>
    <h3 className="text-xs font-semibold text-canvas-text">{t('待处理导入')}</h3>
    {error && <div role="alert" className="ui-alert ui-alert--warning items-center justify-between">
      <span>{t('读取待处理导入失败')}</span>
      <button type="button" className="ui-btn ui-btn--sm" disabled={suspended || resuming !== null}
        onClick={() => setRevision((value) => value + 1)}>{t('重试')}</button>
    </div>}
    {rows.map((operation) => <div key={operation.operationId} className="ui-card flex flex-wrap items-center justify-between gap-2 p-2">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium">{operation.projectName || t('未命名项目')}</p>
        <p className="text-xs text-canvas-text-secondary">
          {operation.phase === 'db_committed' ? t('项目已导入，待收尾') : t('导入未完成')}
          {' · '}{new Date(operation.updatedAt).toLocaleString()}
        </p>
        <p className="break-all font-mono text-xs text-canvas-text-muted">{operation.operationId}</p>
      </div>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm shrink-0"
        disabled={suspended || resuming !== null} onClick={() => void resume(operation)}>
        {resuming === operation.operationId ? t('正在处理…') : operation.phase === 'db_committed' ? t('完成收尾') : t('继续原导入')}
      </button>
    </div>)}
  </section>;
}
