/** Muse 会话仅由原生 WebView 和凭据存储持有，此组件只读取有限状态。 */
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { isTauriEnv } from '../../services/fs/core';
import { confirmAction } from '../../services/confirmDialog';
import AnimatedButton from '../shared/AnimatedButton';

interface MuseAuthStatus {
  loggedIn: boolean;
  loginOpen: boolean;
  activeTaskId?: string;
  message?: string;
}

export default function MuseAccountControls({ onLoggedInChange }: { onLoggedInChange?: (loggedIn: boolean) => void }) {
  const t = useT();
  const desktop = isTauriEnv();
  const [status, setStatus] = useState<MuseAuthStatus>({ loggedIn: false, loginOpen: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mounted = useRef(false);
  const request = useRef(0);
  const refreshing = useRef<Promise<void> | null>(null);
  const actionInFlight = useRef(false);
  const applyStatus = useCallback((next: MuseAuthStatus) => {
    setStatus(next);
    onLoggedInChange?.(next.loggedIn);
  }, [onLoggedInChange]);

  const refresh = useCallback((): Promise<void> => {
    if (!desktop || actionInFlight.current) return Promise.resolve();
    if (refreshing.current) return refreshing.current;
    const identity = ++request.current;
    const pending = (async () => {
      try {
        const next = await invoke<MuseAuthStatus>('muse_auth_status');
        if (mounted.current && identity === request.current) {
          applyStatus(next);
          setMessage(next.message ? t(next.message) : '');
        }
      } catch {
        if (mounted.current && identity === request.current) {
          onLoggedInChange?.(false);
          setMessage(t('无法读取 Muse 登录状态，请重试'));
        }
      } finally {
        refreshing.current = null;
      }
    })();
    refreshing.current = pending;
    return pending;
  }, [applyStatus, desktop, onLoggedInChange, t]);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      await refreshing.current;
      if (mounted.current) await refresh();
    })();
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, [refresh]);

  useEffect(() => {
    if (!desktop || !status.loginOpen) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(() => void poll(), 2000);
    };
    timer = window.setTimeout(() => void poll(), 2000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [desktop, status.loginOpen, refresh]);

  const runAction = async (command: 'muse_login_open' | 'muse_logout' | 'muse_release' | 'muse_task_open', taskId?: string) => {
    if (busy || actionInFlight.current || !desktop) return;
    actionInFlight.current = true;
    setBusy(true);
    request.current++;
    try {
      await refreshing.current;
      if (!mounted.current) return;
      await invoke(command, taskId ? { taskId } : {});
      if (command === 'muse_logout' && mounted.current) applyStatus({ loggedIn: false, loginOpen: false });
      actionInFlight.current = false;
      if (mounted.current) await refresh();
    } catch {
      if (mounted.current) setMessage(t('Muse 操作未完成，请检查官网窗口或稍后重试'));
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const releaseTask = async () => {
    const taskId = status.activeTaskId;
    if (!taskId || busy) return;
    const confirmed = await confirmAction(t('请先在 Muse 官网核对原任务已结束。解除占用不会取消远端任务；原任务记录仍可继续查询。确定解除占用？'), {
      title: t('解除 Muse 任务占用'), kind: 'warning', okLabel: t('已核对，解除占用'), cancelLabel: t('取消'),
    });
    if (confirmed) await runAction('muse_release', taskId);
  };

  return (
    <div className="ui-card p-3 flex flex-col gap-2" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm text-canvas-text">
          {status.message ? t('Muse 登录状态待确认') : status.loggedIn ? t('Muse 账号已登录') : t('Muse 账号未登录')}
        </strong>
        <div className="flex flex-wrap gap-2">
          <AnimatedButton type="button" className="ui-btn ui-btn--primary" disabled={!desktop || busy || !!status.activeTaskId}
            onClick={() => void runAction('muse_login_open')}>
            {status.loginOpen ? t('返回登录窗口') : status.loggedIn ? t('重新登录') : t('登录 Muse')}
          </AnimatedButton>
          <AnimatedButton type="button" className="ui-btn" disabled={!desktop || busy} onClick={() => void refresh()}>
            {t('刷新状态')}
          </AnimatedButton>
          {status.loggedIn && <AnimatedButton type="button" className="ui-btn" disabled={busy || !!status.activeTaskId}
            onClick={() => void runAction('muse_logout')}>{t('退出登录')}</AnimatedButton>}
        </div>
      </div>
      <p className="ui-hint">{desktop
        ? t('在弹出的 Muse 官网窗口完成登录，应用会自动保存登录会话，无需复制 Cookie。')
        : t('Muse 网页登录和生成仅在 Tauri 桌面应用中可用。')}</p>
      <p className="ui-hint">{t('生成时应用会操作 Muse 网页，请勿在任务窗口中手动聊天。比例和时长通过提示词请求，实际结果以 Muse 为准。')}</p>
      {status.activeTaskId && <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="ui-hint">{t('Muse 有任务占用，请先继续查询原任务或到官网核对状态。')}</span>
        <AnimatedButton type="button" className="ui-btn ui-btn--sm" disabled={busy}
          onClick={() => void runAction('muse_task_open', status.activeTaskId)}>{t('查看原任务')}</AnimatedButton>
        <AnimatedButton type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={() => void releaseTask()}>
          {t('已在 Muse 核对，解除占用')}
        </AnimatedButton>
      </div>}
      <span className="ui-hint" role="status" aria-live="polite">{message || (status.loginOpen && !status.loggedIn ? t('正在等待官网登录完成…') : '')}</span>
    </div>
  );
}
