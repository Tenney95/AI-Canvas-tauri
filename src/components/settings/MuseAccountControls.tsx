/** Muse 会话由原生持有；手动输入仅存于本组件，成功导入后立即清空。 */
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { isTauriEnv } from '../../services/fs/core';
import { confirmAction } from '../../services/confirmDialog';
import AnimatedButton from '../shared/AnimatedButton';
import { openExternal } from './providerConnection/providerConnectionShared';

interface MuseAuthStatus {
  loggedIn: boolean;
  credentialStored?: boolean;
  sessionState?: 'verified' | 'invalid' | 'unverified' | 'missing';
  loginOpen: boolean;
  loginState?: 'closed' | 'loading' | 'waiting-login' | 'ready' | 'blocked' | 'timeout' | 'failed';
  checking?: boolean;
  activeTaskId?: string;
  nativeNavigation?: unknown;
}

const NATIVE_NAVIGATION_STAGES = {
  waiting: '等待原生导航', accepted: '原生导航请求已接受', starting: '已开始原生导航',
  completed: '原生导航已完成', failed: '原生导航失败',
} as const;
const NATIVE_NAVIGATION_FAILURE_STAGES = {
  controller: '浏览器控制器', register: '导航事件注册', navigate: '发起导航', event: '读取导航结果',
} as const;
const NATIVE_NAVIGATION_POLICIES = {
  'allow-muse': '允许Muse', 'allow-login': '允许登录跳转', 'deny-redirect': '拒绝其他跳转',
} as const;
// 对应本机 webview2-com-sys 的 COREWEBVIEW2_WEB_ERROR_STATUS（0..18），不是故障根因推断。
const NATIVE_WEB_ERROR_LABELS: readonly string[] = [
  'WebView2 未提供具体错误',
  'WebView2 报告：证书名称不匹配', 'WebView2 报告：证书已过期',
  'WebView2 报告：客户端证书错误', 'WebView2 报告：证书已吊销', 'WebView2 报告：证书无效',
  'WebView2 报告：服务器不可达', 'WebView2 报告：请求超时', 'WebView2 报告：服务器响应无效',
  'WebView2 报告：连接已中止', 'WebView2 报告：连接已重置', 'WebView2 报告：连接已断开',
  'WebView2 报告：无法连接', 'WebView2 报告：域名无法解析', 'WebView2 报告：操作已取消',
  'WebView2 报告：重定向失败', 'WebView2 报告：意外错误',
  'WebView2 报告：需要服务器身份验证', 'WebView2 报告：需要代理身份验证',
];

function isNormalizedDnsHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 253 || /[^a-z0-9.-]/.test(value)) return false;
  const labels = value.split('.');
  return labels.length >= 2 && /[a-z]/.test(labels[labels.length - 1])
    && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/** 原生诊断仍按不可信数据处理；仅固定阶段与有限数字能进入界面。 */
function nativeNavigationLines(value: unknown): Array<{ label: string; code?: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  if (typeof item.stage !== 'string' || !Object.hasOwn(NATIVE_NAVIGATION_STAGES, item.stage)) return [];
  const lines: Array<{ label: string; code?: string }> = [
    { label: NATIVE_NAVIGATION_STAGES[item.stage as keyof typeof NATIVE_NAVIGATION_STAGES] },
  ];
  if (typeof item.failureStage === 'string' && Object.hasOwn(NATIVE_NAVIGATION_FAILURE_STAGES, item.failureStage)) {
    lines.push({ label: NATIVE_NAVIGATION_FAILURE_STAGES[item.failureStage as keyof typeof NATIVE_NAVIGATION_FAILURE_STAGES] });
  }
  if (typeof item.hresult === 'string' && /^0x[0-9A-F]{8}$/.test(item.hresult)) {
    lines.push({ label: 'HRESULT', code: item.hresult });
  }
  if (typeof item.webErrorStatus === 'number' && Number.isInteger(item.webErrorStatus) && item.webErrorStatus >= 0 && item.webErrorStatus <= 255) {
    lines.push({ label: 'WebView2 状态', code: String(item.webErrorStatus) });
    const description = NATIVE_WEB_ERROR_LABELS[item.webErrorStatus];
    if (description) lines.push({ label: description });
  }
  if (typeof item.httpStatusCode === 'number' && Number.isInteger(item.httpStatusCode) && item.httpStatusCode >= 100 && item.httpStatusCode <= 599) {
    lines.push({ label: 'HTTP 状态', code: String(item.httpStatusCode) });
  }
  if (typeof item.isSuccess === 'boolean') lines.push({ label: item.isSuccess ? '导航成功' : '导航失败' });
  if (typeof item.startingCancel === 'boolean') {
    lines.push({ label: item.startingCancel ? '导航开始时已被宿主取消：是' : '导航开始时已被宿主取消：否' });
  }
  if (typeof item.localPolicy === 'string' && Object.hasOwn(NATIVE_NAVIGATION_POLICIES, item.localPolicy)) {
    lines.push({ label: NATIVE_NAVIGATION_POLICIES[item.localPolicy as keyof typeof NATIVE_NAVIGATION_POLICIES] });
  }
  if (item.localPolicy === 'deny-redirect' && isNormalizedDnsHost(item.blockedHost)) {
    lines.push({ label: '被拒绝的目标主机', code: item.blockedHost });
  }
  if (item.downloadBlocked === true) lines.push({ label: '下载导航已被应用阻止' });
  return lines;
}

interface MuseAccountControlsProps {
  onLoggedInChange?: (loggedIn: boolean) => void;
  onCredentialReadyChange?: (ready: boolean) => void;
}

export default function MuseAccountControls({ onLoggedInChange, onCredentialReadyChange }: MuseAccountControlsProps) {
  const t = useT();
  const desktop = isTauriEnv();
  const [status, setStatus] = useState<MuseAuthStatus>({ loggedIn: false, loginOpen: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [cookie, setCookie] = useState('');
  const [showCookie, setShowCookie] = useState(false);
  const [pollLogin, setPollLogin] = useState(true);
  const manualId = useId();
  const mounted = useRef(false);
  const request = useRef(0);
  const refreshing = useRef<Promise<void> | null>(null);
  const actionInFlight = useRef(false);
  const invalidateRequests = useCallback(() => { request.current++; }, []);
  const applyStatus = useCallback((next: MuseAuthStatus) => {
    setStatus(next);
    onLoggedInChange?.(next.loggedIn);
    onCredentialReadyChange?.((next.credentialStored ?? next.loggedIn) && next.sessionState !== 'invalid');
  }, [onLoggedInChange, onCredentialReadyChange]);

  const refresh = useCallback((verify = false): Promise<void> => {
    if (!desktop || actionInFlight.current) return Promise.resolve();
    if (refreshing.current) return refreshing.current;
    const identity = ++request.current;
    const pending = (async () => {
      try {
        const next = await invoke<MuseAuthStatus>('muse_auth_status', verify ? { verify: true } : {});
        if (mounted.current && identity === request.current) {
          applyStatus(next);
          if (verify || next.loggedIn) setMessage('');
        }
      } catch {
        if (mounted.current && identity === request.current) {
          onLoggedInChange?.(false);
          setStatus((current) => ({ ...current, loggedIn: false,
            sessionState: current.credentialStored ? 'unverified' : 'missing' }));
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
      invalidateRequests();
    };
  }, [refresh, invalidateRequests]);

  useEffect(() => {
    if (!desktop || (!status.checking && (!status.loginOpen || !pollLogin))) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(() => void poll(), 2000);
    };
    timer = window.setTimeout(() => void poll(), 2000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [desktop, status.checking, status.loginOpen, pollLogin, refresh]);

  const runAction = async (command: 'muse_login_open' | 'muse_logout' | 'muse_release' | 'muse_task_open', taskId?: string, retry = false) => {
    if (busy || actionInFlight.current || !desktop) return;
    actionInFlight.current = true;
    setBusy(true);
    request.current++;
    try {
      const next = await invoke<MuseAuthStatus | undefined>(command, taskId ? { taskId } : command === 'muse_login_open' ? { retry } : {});
      if (!mounted.current) return;
      if (command === 'muse_login_open') setPollLogin(true);
      if (next && typeof next.loggedIn === 'boolean') applyStatus(next);
      if (command === 'muse_logout') {
        applyStatus({ loggedIn: false, credentialStored: false, sessionState: 'missing', loginOpen: false, loginState: 'closed' });
        setCookie('');
        setShowCookie(false);
      }
      setMessage('');
    } catch (error) {
      const code = typeof error === 'string' ? error : error instanceof Error ? error.message : undefined;
      const errorMessage = code === 'muse_webview_init_timeout'
        ? 'Muse 原生浏览器初始化超时，尚未进入官网，请重试登录或手动填写 Cookie。'
        : code === 'muse_webview_init_failed'
          ? 'Muse 原生浏览器初始化失败，请重试登录或手动填写 Cookie。'
          : 'Muse 操作未完成，请检查官网窗口或稍后重试';
      if (mounted.current) setMessage(t(errorMessage));
      const identity = request.current;
      try {
        const next = await invoke<MuseAuthStatus>('muse_auth_status', {});
        if (mounted.current && identity === request.current) applyStatus(next);
      } catch {
        // 缓存诊断不可用时保留上面的固定错误文案，不回显原生异常。
      }
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const importCookies = async () => {
    if (!desktop || busy || actionInFlight.current || status.activeTaskId || !cookie.trim()) return;
    actionInFlight.current = true;
    setBusy(true);
    request.current++;
    try {
      // 导入仅写原生凭据；不等待旧的联网检查，也不在保存后自动发起验证。
      const next = await invoke<MuseAuthStatus>('muse_import_cookies', { cookie: cookie.trim() });
      if (!mounted.current) return;
      setCookie('');
      setShowCookie(false);
      setPollLogin(false);
      applyStatus(next);
      setMessage(t('会话已保存，尚未验证。可以先保存连接，再点击“验证 / 刷新状态”检查登录。'));
    } catch {
      if (mounted.current) setMessage(t('Cookie 保存失败，请检查格式或稍后重试。'));
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const verifyStatus = async () => {
    const identity = request.current;
    await refreshing.current;
    if (mounted.current && identity === request.current) await refresh(true);
  };

  const releaseTask = async () => {
    const taskId = status.activeTaskId;
    if (!taskId || busy) return;
    const confirmed = await confirmAction(t('请先在 Muse 官网核对原任务已结束。解除占用不会取消远端任务；原任务记录仍可继续查询。确定解除占用？'), {
      title: t('解除 Muse 任务占用'), kind: 'warning', okLabel: t('已核对，解除占用'), cancelLabel: t('取消'),
    });
    if (confirmed) await runAction('muse_release', taskId);
  };

  const loginFailed = status.loginState === 'blocked' || status.loginState === 'timeout' || status.loginState === 'failed';
  const navigationLines = nativeNavigationLines(status.nativeNavigation);
  const statusMessage = status.loginState === 'waiting-login'
    ? t('请在 Muse 登录窗口完成认证，返回 Muse 后会自动检查登录状态。')
    : status.checking
    ? t('正在验证 Muse 会话，请稍候；已保存的凭据仍可用于保存连接。')
    : status.sessionState === 'invalid'
    ? t('Muse 会话已失效，请重新登录或填写新的 Cookie。')
    : status.loginState === 'loading'
      ? t('Muse 官网正在加载，可稍候完成登录，或展开手动填写 Cookie。')
      : status.loginState === 'blocked'
        ? t('Muse 登录页面被阻止，可重试登录或从浏览器手动填写 Cookie。')
        : status.loginState === 'timeout' || status.loginState === 'failed'
          ? t('Muse 登录页面未能正常加载，可重试登录或手动填写 Cookie。')
          : status.credentialStored && !status.loggedIn
            ? t('会话已保存在本机，在线登录状态尚未验证。')
            : status.loginOpen && !status.loggedIn ? t('正在等待官网登录完成…') : '';

  return (
    <div className="ui-card p-3 flex flex-col gap-2" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm text-canvas-text">
          {status.loggedIn ? t('Muse 账号已登录') : status.sessionState === 'invalid'
            ? t('Muse 会话已失效') : status.credentialStored ? t('Muse 会话已保存，待验证') : t('Muse 账号未登录')}
        </strong>
        <div className="flex flex-wrap gap-2">
          <AnimatedButton type="button" className="ui-btn ui-btn--primary" disabled={!desktop || busy || !!status.activeTaskId}
            onClick={() => void runAction('muse_login_open')}>
            {status.loginOpen ? t('返回登录窗口') : status.loggedIn ? t('重新登录') : t('登录 Muse')}
          </AnimatedButton>
          <AnimatedButton type="button" className="ui-btn" disabled={!desktop || busy || status.checking} onClick={() => void verifyStatus()}>
            {t('验证 / 刷新状态')}
          </AnimatedButton>
          {loginFailed && <AnimatedButton type="button" className="ui-btn" disabled={!desktop || busy || !!status.activeTaskId}
            onClick={() => void runAction('muse_login_open', undefined, true)}>{t('重试登录')}</AnimatedButton>}
          {(status.loggedIn || status.credentialStored) && <AnimatedButton type="button" className="ui-btn" disabled={busy || !!status.activeTaskId}
            onClick={() => void runAction('muse_logout')}>{t('退出登录')}</AnimatedButton>}
        </div>
      </div>
      <p className="ui-hint">{desktop
        ? t('在弹出的 Muse 官网窗口完成登录，应用会自动保存登录会话，无需复制 Cookie。')
        : t('Muse 网页登录和生成仅在 Tauri 桌面应用中可用。')}</p>
      <button type="button" className="ui-btn ui-btn--link self-start" onClick={() => void openExternal('https://muse.ai/')}>
        {t('在浏览器中打开 Muse 官网')} · https://muse.ai/
      </button>
      <button type="button" className="ui-btn ui-btn--link self-start" aria-expanded={manualOpen} aria-controls={manualId}
        onClick={() => {
          setManualOpen((current) => !current);
          setShowCookie(false);
          if (manualOpen) setCookie('');
        }}>{manualOpen ? t('收起手动 Cookie') : t('手动填写 Cookie')}</button>
      {manualOpen && <div id={manualId} className="ui-card p-2 flex flex-col gap-2">
        <label className="ui-field">
          <span className="ui-label">{t('Muse Cookie')}</span>
          <input className="ui-input w-full" type={showCookie ? 'text' : 'password'} value={cookie}
            onChange={(event) => setCookie(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false}
            maxLength={16 * 1024} disabled={!desktop || busy || !!status.activeTaskId}
            placeholder="hatch_sess=…; hatch_vml=…; hatch_gw=…" />
        </label>
        <p className="ui-hint">{t('最少需要 hatch_sess；hatch_vml 和 hatch_gw 可选。支持完整 Cookie 请求头、hatch_sess 裸值或 Cookie JSON 导出。')}</p>
        <p className="ui-hint">{t('在已登录 Muse 的浏览器按 F12 → Application（应用）→ Cookies → https://muse.ai，复制 hatch_sess 的值。')}</p>
        <p className="ui-hint">{t('仅在此处本机输入，请勿将 Cookie 发到对话。保存后会清空输入，凭据仅由本机原生存储保管。')}</p>
        <div className="flex flex-wrap gap-2">
          <AnimatedButton type="button" className="ui-btn ui-btn--sm" disabled={busy}
            aria-pressed={showCookie} onClick={() => setShowCookie((current) => !current)}>{showCookie ? t('隐藏 Cookie') : t('显示 Cookie')}</AnimatedButton>
          <AnimatedButton type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!desktop || busy || !!status.activeTaskId || !cookie.trim()}
            onClick={() => void importCookies()}>{t('保存 Cookie')}</AnimatedButton>
        </div>
      </div>}
      <p className="ui-hint">{t('生成时应用会操作 Muse 网页，请勿在任务窗口中手动聊天。比例和时长通过提示词请求，实际结果以 Muse 为准。')}</p>
      {status.activeTaskId && <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="ui-hint">{t('Muse 有任务占用，请先继续查询原任务或到官网核对状态。')}</span>
        <AnimatedButton type="button" className="ui-btn ui-btn--sm" disabled={busy}
          onClick={() => void runAction('muse_task_open', status.activeTaskId)}>{t('查看原任务')}</AnimatedButton>
        <AnimatedButton type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={() => void releaseTask()}>
          {t('已在 Muse 核对，解除占用')}
        </AnimatedButton>
      </div>}
      <span className="ui-hint" role="status" aria-live="polite">{status.loginState === 'waiting-login' ? statusMessage : message || statusMessage}</span>
      {navigationLines.length > 0 && <div className="ui-hint flex flex-wrap gap-x-3 gap-y-1" aria-label={t('Muse 原生导航诊断')}>
        {navigationLines.map((line) => <span key={line.label}>{t(line.label)}{line.code ? `：${line.code}` : ''}</span>)}
      </div>}
    </div>
  );
}
