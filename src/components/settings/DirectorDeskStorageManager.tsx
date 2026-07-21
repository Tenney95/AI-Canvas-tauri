import { useEffect, useState } from 'react';
import { Icon } from '@iconify/react';
import { useAppStore } from '../../store/useAppStore';
import {
  getDirectorDeskRuntimeStatus,
  isDirectorDeskRuntimeAvailable,
  removeDirectorDeskRuntime,
  type DirectorDeskRuntimeStatus,
} from '../../services/directorDeskRuntimeService';
import { closeDirectorDeskWindow } from '../../services/directorDeskWindowService';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

export default function DirectorDeskStorageManager() {
  const showToast = useAppStore((state) => state.showToast);
  const runtimeAvailable = isDirectorDeskRuntimeAvailable();
  const [status, setStatus] = useState<DirectorDeskRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(runtimeAvailable);
  const [removing, setRemoving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!runtimeAvailable) return;
    let active = true;
    void getDirectorDeskRuntimeStatus()
      .then((nextStatus) => {
        if (active) setStatus(nextStatus);
      })
      .catch((reason) => {
        if (active) showToast(reason instanceof Error ? reason.message : String(reason), 'error');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [runtimeAvailable, showToast]);

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await closeDirectorDeskWindow();
      setStatus(await removeDirectorDeskRuntime());
      setConfirming(false);
      showToast('已删除 3D 导演台本地资源', 'success');
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className="mt-5 border-t border-canvas-border pt-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-canvas-text">3D 导演台资源</h3>
          <p className="mt-1 text-xs text-canvas-text-muted">
            按需下载的运行资源由所有导演台节点共用。
          </p>
        </div>
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-500/15 text-violet-400">
          <Icon icon="mdi:video-3d" width="18" height="18" />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-canvas-border bg-canvas-card p-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-canvas-text">
            {loading
              ? '正在读取...'
              : status?.installed
                ? `已安装 v${status.version}`
                : '未安装'}
          </p>
          <p className="mt-1 text-[11px] text-canvas-text-muted">
            {status?.installed ? `占用 ${formatBytes(status.installedBytes)}` : '创建或打开导演台节点时可下载'}
          </p>
        </div>
        {status?.installed && (
          confirming ? (
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                className="rounded-lg bg-canvas-hover px-2.5 py-1.5 text-xs text-canvas-text-secondary hover:bg-canvas-border"
                onClick={() => setConfirming(false)}
                disabled={removing}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg bg-red-500/15 px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-500/25 disabled:opacity-50"
                onClick={() => { void handleRemove(); }}
                disabled={removing}
              >
                {removing ? '正在删除...' : '确认删除'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-canvas-hover px-2.5 py-1.5 text-xs text-canvas-text-secondary hover:bg-canvas-border"
              onClick={() => setConfirming(true)}
            >
              <Icon icon="lucide:trash-2" width="13" height="13" />
              删除资源
            </button>
          )
        )}
      </div>
    </section>
  );
}
