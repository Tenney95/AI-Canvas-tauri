import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n';
import type { InstalledPlugin, PluginHealthSnapshot } from '../../../types/plugin';
import { inspectPluginHealth } from '../../../services/plugins/pluginHealthService';
import { resolvePluginDependencies } from '../../../services/plugins/pluginDependencyService';

const LABELS: Record<PluginHealthSnapshot['state'], string> = {
  ready: '实际可用', disabled: '实际停用', missing: '缺少原生注册', blocked: '执行被阻塞', invalid: '快照或授权无效', unavailable: '状态未确认',
};

export default function PluginDiagnosticsPanel({ plugin, plugins }: { plugin: InstalledPlugin; plugins: readonly InstalledPlugin[] }) {
  const t = useT();
  const [health, setHealth] = useState<PluginHealthSnapshot>();
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  const dependencies = resolvePluginDependencies(plugins, plugin.id);
  const signature = `${plugin.enabled}:${plugin.sourceDigest}:${plugin.revisionDigest}:${dependencies.fingerprint}`;
  const [readSignature, setReadSignature] = useState('');
  const refresh = async () => {
    const id = ++request.current;
    setBusy(true);
    try {
      const snapshot = await inspectPluginHealth(plugin, plugins);
      if (request.current === id) { setHealth(snapshot); setReadSignature(signature); }
    } finally { if (request.current === id) setBusy(false); }
  };
  return <details className="mt-2 text-xs">
    <summary className="cursor-pointer text-canvas-text-secondary">{t('健康与生效诊断')}</summary>
    <div className="ui-card mt-2 space-y-2 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-badge ui-badge--outline">{plugin.enabled ? t('配置启用') : t('配置停用')}</span>
        {health && readSignature === signature && <span className={`ui-badge ${health.state === 'ready' ? 'ui-badge--success' : 'ui-badge--warning'}`}>{t(LABELS[health.state])}</span>}
        <button type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={() => void refresh()}>{busy ? t('读取中…') : t('刷新原生状态')}</button>
      </div>
      {health && readSignature !== signature && <p className="text-canvas-text-muted">{t('配置已变化，请刷新原生状态')}</p>}
      {health && readSignature === signature && <>
        <p className="break-all text-canvas-text-muted">{t('活动 revision：')}{health.activeRevision ?? t('无')}</p>
        <p className="text-canvas-text-secondary">{health.snapshotVerified ? t('私有快照已核对') : t('私有快照未确认')}</p>
        {health.reasons.map((reason) => <p key={reason} className="text-canvas-text-secondary">{t(reason)}</p>)}
      </>}
      {plugin.manifest.dependencies?.map((dependency) => <div key={dependency.pluginId} className="flex flex-wrap gap-2 text-canvas-text-secondary">
        <span>{dependency.pluginId}</span><span>{dependency.minVersion ? `≥ ${dependency.minVersion}` : ''}</span>
        <span className="ui-badge ui-badge--outline">{dependency.optional ? t('可选依赖') : t('必需依赖')}</span>
      </div>)}
      {dependencies.warnings.length > 0 && <p className="text-canvas-text-muted">{t('部分可选依赖不可用')}</p>}
      <p className="text-canvas-text-muted">{t('只读取状态，不运行、修复或重新激活插件。')}</p>
    </div>
  </details>;
}
