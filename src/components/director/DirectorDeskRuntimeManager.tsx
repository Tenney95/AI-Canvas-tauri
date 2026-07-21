import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import {
  cancelDirectorDeskInstall,
  getDirectorDeskRuntimeStatus,
  installDirectorDeskRuntime,
  isDirectorDeskRuntimeAvailable,
  subscribeDirectorDeskInstallProgress,
  type DirectorDeskInstallProgress,
} from '../../services/directorDeskRuntimeService';
import { openDirectorDeskWindow } from '../../services/directorDeskWindowService';
import DirectorDeskDownloadDialog, {
  type DirectorDeskDialogPhase,
} from './DirectorDeskDownloadDialog';

const DEFAULT_VERSION = '0.3.1';

function progressState(progress: DirectorDeskInstallProgress) {
  const ratio = progress.totalBytes > 0
    ? Math.min(1, progress.transferredBytes / progress.totalBytes)
    : 0;
  if (progress.stage === 'downloading') {
    return { percent: ratio * 78, text: '正在下载运行资源...' };
  }
  if (progress.stage === 'verifying') {
    return { percent: 82, text: '正在校验下载内容...' };
  }
  if (progress.stage === 'extracting') {
    return { percent: 84 + ratio * 15, text: '正在安装本地资源...' };
  }
  return { percent: 100, text: '安装完成' };
}

export default function DirectorDeskRuntimeManager() {
  const request = useAppStore((state) => state.directorDeskRuntimeRequest);

  if (!request) return null;

  return (
    <DirectorDeskRuntimeRequestController
      key={request.instanceId}
      request={request}
    />
  );
}

function DirectorDeskRuntimeRequestController({
  request,
}: {
  request: { instanceId: string; openAfterInstall: boolean };
}) {
  const clearRequest = useAppStore((state) => state.clearDirectorDeskRuntimeRequest);
  const theme = useAppStore((state) => state.config.theme);
  const showToast = useAppStore((state) => state.showToast);
  const runtimeAvailable = isDirectorDeskRuntimeAvailable();
  const [phase, setPhase] = useState<DirectorDeskDialogPhase | 'checking'>(
    runtimeAvailable ? 'checking' : 'error',
  );
  const [version, setVersion] = useState(DEFAULT_VERSION);
  const [progress, setProgress] = useState(0);
  const [stageText, setStageText] = useState('正在准备下载...');
  const [error, setError] = useState<string | null>(
    runtimeAvailable ? null : '3D 导演台运行资源仅支持 Tauri 桌面端下载',
  );
  const [cancelling, setCancelling] = useState(false);
  const cancelRequestedRef = useRef(false);
  const installStartedRef = useRef(false);

  useEffect(() => {
    if (!runtimeAvailable) return;
    let active = true;
    void getDirectorDeskRuntimeStatus()
      .then((status) => {
        if (!active) return;
        setVersion(status.version);
        if (status.installed) {
          clearRequest();
          return;
        }
        setPhase('prompt');
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase('error');
      });
    return () => { active = false; };
  }, [clearRequest, runtimeAvailable]);

  const startInstall = useCallback(async () => {
    if (installStartedRef.current) return;
    installStartedRef.current = true;
    setPhase('downloading');
    setError(null);
    setProgress(0);
    setStageText('正在连接下载服务...');
    setCancelling(false);
    cancelRequestedRef.current = false;

    let unlisten: (() => void) | undefined;
    try {
      unlisten = await subscribeDirectorDeskInstallProgress((event) => {
        const next = progressState(event);
        setProgress(next.percent);
        setStageText(next.text);
      });
      if (cancelRequestedRef.current) {
        clearRequest();
        return;
      }
      const status = await installDirectorDeskRuntime();
      if (cancelRequestedRef.current) {
        clearRequest();
        return;
      }
      setVersion(status.version);
      setProgress(100);
      clearRequest();
      const nodeStillExists = useAppStore.getState().nodes.some((node) => {
        if (node.type !== 'ai-director') return false;
        const nodeInstanceId = typeof node.data.directorInstanceId === 'string'
          ? node.data.directorInstanceId
          : node.id;
        return nodeInstanceId === request.instanceId;
      });
      if (request.openAfterInstall && nodeStillExists) {
        await openDirectorDeskWindow({
          instanceId: request.instanceId,
          theme: theme === 'light' ? 'light' : 'dark',
        });
      }
    } catch (reason) {
      if (cancelRequestedRef.current) {
        clearRequest();
        return;
      }
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase('error');
    } finally {
      unlisten?.();
      installStartedRef.current = false;
      setCancelling(false);
    }
  }, [clearRequest, request, theme]);

  const handleCancel = useCallback(() => {
    if (phase !== 'downloading') {
      clearRequest();
      return;
    }
    cancelRequestedRef.current = true;
    setCancelling(true);
    void cancelDirectorDeskInstall().catch((reason) => {
      cancelRequestedRef.current = false;
      setCancelling(false);
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setPhase('error');
      showToast(message, 'error');
    });
  }, [clearRequest, phase, showToast]);

  if (phase === 'checking') return null;

  return (
    <DirectorDeskDownloadDialog
      phase={phase}
      version={version}
      progress={progress}
      stageText={stageText}
      error={error}
      cancelling={cancelling}
      onConfirm={() => { void startInstall(); }}
      onCancel={handleCancel}
      onRetry={() => { void startInstall(); }}
    />
  );
}
