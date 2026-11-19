import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link2 } from 'lucide-react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import {
  activeWsagentOwner, connectWsagentProject, getWsagentSharedStatus, observeWsagentBinding, revokeWsagentPairing,
} from '../../services/wsagentSharedImages';
import { getWsagentCreativeSyncState, getWsagentScriptSyncState, subscribeWsagentCreativeSync } from '../../services/wsagentCreativeStatus';
import type { WsagentScriptSyncState, WsagentSharedStatus } from '../../types/wsagentShared';

const SCRIPT_STATUS: Record<Exclude<WsagentScriptSyncState, 'idle'>, string> = {
  syncing: '正在同步剧本…',
  ready: '剧本已同步',
  offline: '剧本暂未同步，稍后重试',
  conflict: '剧本版本有冲突，已保留两端原稿',
  ambiguous: '有多份未对应的 WSAGENT 剧本，已保留原稿',
  deferred: '剧本有正在编辑的草稿，保存或关闭后再同步',
};

/** 只操作当前作品。每个画布上的节点共用作品绑定，不保存一份节点级配置。 */
export default function WsagentConnectControl({ scopeOwner, allowDisconnect = false }: {
  scopeOwner?: string;
  allowDisconnect?: boolean;
}) {
  const ownerId = useAppStore(activeWsagentOwner);
  if (!ownerId || (scopeOwner && ownerId !== scopeOwner)) return null;
  return <ProjectConnection key={ownerId} ownerId={ownerId} allowDisconnect={allowDisconnect} />;
}

function ProjectConnection({ ownerId, allowDisconnect }: { ownerId: string; allowDisconnect: boolean }) {
  const t = useT();
  const creativeSync = useSyncExternalStore(subscribeWsagentCreativeSync, () => getWsagentCreativeSyncState(ownerId));
  const scriptSync = useSyncExternalStore(subscribeWsagentCreativeSync, () => getWsagentScriptSyncState(ownerId));
  const [status, setStatus] = useState<WsagentSharedStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<AbortController>(null);

  useEffect(() => {
    let live = true;
    let changed = false;
    const unsubscribe = observeWsagentBinding(ownerId, (next) => { changed = true; setStatus(next); setError(''); });
    void getWsagentSharedStatus(ownerId).then((next) => {
      if (live && !changed) setStatus(next);
    }).catch((cause: unknown) => {
      if (live && !changed) setError(messageFromError(cause));
    });
    return () => { live = false; unsubscribe(); current.current?.abort(); current.current = null; };
  }, [ownerId]);

  const run = async (action: (ownerId: string) => Promise<WsagentSharedStatus>) => {
    if (current.current) return;
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    setError('');
    try { await action(ownerId); }
    catch (cause) { if (!controller.signal.aborted) setError(messageFromError(cause)); }
    finally {
      if (current.current === controller) { current.current = null; setBusy(false); }
    }
  };

  const paired = !!status?.peerProjectId;
  return <div className="ui-stack ui-stack--tight">
    <div className="ui-row">
      <button type="button" className="nodrag ui-btn ui-btn--secondary ui-btn--sm" disabled={busy}
        onClick={() => void run(connectWsagentProject)}>
        <Link2 size={14} aria-hidden="true" />
        {busy ? t('处理中…') : paired ? t('重新连接') : t('连接 WSAGENT')}
      </button>
      <span role="status" className={paired ? 'ui-badge ui-badge--success' : 'sr-only'}>{paired ? t('本作品已配对') : null}</span>
      {allowDisconnect && status?.enabled && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy}
        onClick={() => void run(revokeWsagentPairing)}>{t('解除配对')}</button>}
    </div>
    {paired && creativeSync !== 'idle' && <p role="status" className="ui-hint">
      {t(creativeSync === 'ready' ? '角色、道具、场景已同步'
        : creativeSync === 'conflict' ? '创作资产有并发修改，已保留两端内容'
          : creativeSync === 'offline' ? '创作资产暂未同步，稍后重试' : '正在同步创作资产…')}
    </p>}
    {paired && scriptSync !== 'idle' && <p role="status" className="ui-hint">{t(SCRIPT_STATUS[scriptSync])}</p>}
    {error && <p role="alert" className="ui-alert ui-alert--danger">
      <span className="ui-alert__body break-words">{t(error)}</span>
    </p>}
  </div>;
}

function messageFromError(cause: unknown): string {
  return typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : 'WSAGENT 连接失败';
}
