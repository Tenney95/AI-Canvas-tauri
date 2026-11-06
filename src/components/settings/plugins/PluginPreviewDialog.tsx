import { useEffect, useRef, useState } from 'react';
import { useT, getLocale } from '../../../i18n';
import { useAppStore } from '../../../store/useAppStore';
import { resolveAppearanceMode } from '../../../services/appearance/appearanceRuntime';
import { readLocalPluginPackage, selectNativePluginDirectory } from '../../../services/fs/pluginPackageFiles';
import { createPluginPreview } from '../../../services/plugins/pluginPreviewService';
import ModalOverlay from '../../shared/ModalOverlay';
import PopupCloseButton from '../../shared/PopupCloseButton';
import Select from '../../shared/Select';

type PreviewSession = Awaited<ReturnType<typeof createPluginPreview>>;
export default function PluginPreviewDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [session, setSession] = useState<PreviewSession>();
  const [busy, setBusy] = useState(false);
  const [hasDirectory, setHasDirectory] = useState(false);
  const [status, setStatus] = useState('');
  const [exports, setExports] = useState<Array<{ value: string; label: string }>>([]);
  const [selectedExport, setSelectedExport] = useState('');
  const directory = useRef<string | undefined>(undefined);
  const current = useRef<PreviewSession | undefined>(undefined);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; void current.current?.dispose().catch(() => undefined); }, []);
  const load = async (choose: boolean, exportName = selectedExport) => {
    if (busy) return;
    const request = ++generation.current;
    setBusy(true); setStatus('');
    await current.current?.dispose().catch(() => undefined); current.current = undefined; setSession(undefined);
    try {
      if (choose) {
        const selected = await selectNativePluginDirectory();
        if (!selected) return;
        directory.current = typeof selected === 'string' ? selected : selected[0];
        setHasDirectory(Boolean(directory.current));
      }
      if (!directory.current) return;
      const bundle = await readLocalPluginPackage([directory.current], true, { verifyIntegrity: true });
      if (request !== generation.current) return;
      if (!bundle?.uiSource || !bundle.manifest.ui) { setExports([]); setSelectedExport(''); setStatus(t('此插件没有自定义界面；清单已读取，未运行工具。')); return; }
      const available = bundle.manifest.contributes.nodeTools.filter((item) => item.dialog?.ui);
      setExports([...new Map(available.map((item) => [item.dialog!.ui!, { value: item.dialog!.ui!, label: item.title }])).values()]);
      const tool = (!choose && available.find((item) => item.dialog?.ui === exportName)) || available[0];
      if (!tool?.dialog?.ui) throw new Error('missing export');
      setSelectedExport(tool.dialog.ui);
      const preview = await createPluginPreview({ manifest: bundle.manifest, uiSource: bundle.uiSource, exportName: tool.dialog.ui,
        theme: resolveAppearanceMode(useAppStore.getState().config.appearance?.mode ?? useAppStore.getState().config.theme), locale: getLocale(), onClose,
        onSubmit: () => setStatus(t('模拟提交已接收，未运行插件或写入画布。')) });
      if (request !== generation.current) { await preview.dispose(); return; }
      current.current = preview; setSession(preview);
    } catch { if (request === generation.current) setStatus(t('预览失败，请检查清单、UI 导出及产物摘要。')); }
    finally { if (request === generation.current) setBusy(false); }
  };
  return <ModalOverlay isOpen onClose={onClose} ariaLabel={t('开发界面预览')} className="w-[min(960px,95vw)]">
    <div className="ui-card flex max-h-[90vh] flex-col overflow-hidden">
      <div className="ui-card__header"><h3 className="ui-card__title">{t('开发界面预览')}</h3><PopupCloseButton onClick={onClose} /></div>
      <div className="space-y-2 p-3">
        <div className="ui-alert ui-alert--info">{t('模拟数据预览：不安装、不激活，不调用模型、网络或文件能力。')}</div>
        <div className="flex flex-wrap gap-2"><button type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={() => void load(true)}>{t('选择开发目录')}</button>
          <button type="button" className="ui-btn ui-btn--sm" disabled={busy || !hasDirectory} onClick={() => void load(false)}>{t('重新载入')}</button>
          {exports.length > 1 && <Select size="sm" className="w-56 max-w-full" aria-label={t('预览界面')} value={selectedExport} options={exports}
            disabled={busy} onChange={(value) => void load(false, value)} />}</div>
        <p role="status" className="text-xs text-canvas-text-secondary">{busy ? t('读取中…') : status}</p>
      </div>
      {session && <iframe title={t('模拟插件界面')} sandbox="allow-scripts" referrerPolicy="no-referrer"
        className="h-[60vh] w-full border-0" src={session.src} ref={(frame) => session.attach(frame?.contentWindow ?? null)} />}
    </div>
  </ModalOverlay>;
}
