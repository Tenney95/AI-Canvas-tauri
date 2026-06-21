/**
 * ApiKeySettings — API Key 配置面板，管理各 AI 厂商密钥、连接测试、通用模型、服务地址
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { TestResult } from '../../services/testConnection';
import { testProviderConnection, type ProviderTestKey } from '../../services/testConnection';
import AnimatedButton from '../shared/AnimatedButton';
import DreaminaLoginModal from './DreaminaLoginModal';
import {
  GENERAL_MODEL_CATEGORY_LABELS,
  GENERAL_MODEL_CATEGORY_COLORS,
  type GeneralModelCategory,
  type DreaminaRuntime,
} from '../../types';

/* ── External URLs ── */
const PROVIDER_URLS: Record<string, string> = {
  apimart: 'https://apib.ai/zh/register',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  runninghub: 'https://www.runninghub.cn/',
  grsai: 'https://grsai.com/zh/dashboard/user-info',
  dreamina: 'https://www.dreamina.com',
};

type TestState = { status: 'idle' | 'testing' | 'done'; result?: TestResult };

/* ── Link Icon SVG ── */
function LinkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

/* ── Test Icon SVG ── */
function TestIcon() {
  return (
    <svg className="settings-btn-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

/* ── Spinner SVG ── */
function SpinnerIcon() {
  return (
    <svg className="settings-btn-icon settings-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

/* ── Test Button ── */
function TestButton({
  label,
  state,
  onTest,
}: {
  label: string;
  state: TestState;
  onTest: () => void;
}) {
  const testing = state.status === 'testing';
  return (
    <AnimatedButton
      type="button"
      className="settings-provider-test-btn"
      aria-label={`测试 ${label} 连接`}
      data-tooltip={`测试 ${label} 连接`}
      disabled={testing}
      onClick={onTest}
    >
      {testing ? <SpinnerIcon /> : <TestIcon />}
      <span className="settings-btn-label">{testing ? '测试中…' : '测试连接'}</span>
    </AnimatedButton>
  );
}

/* ── Provider Status Badge ── */
function ProviderStatusBadge({ result }: { result?: TestResult }) {
  if (!result) return null;
  if (result.success) {
    return (
      <span className="settings-provider-status settings-provider-status--success">通过</span>
    );
  }
  return (
    <span className="settings-provider-status settings-provider-status--danger">
      {result.error ? (
        <span className="settings-status-with-tip">
          失败
          <span className="settings-error-tip">{result.error}</span>
        </span>
      ) : (
        '失败'
      )}
    </span>
  );
}

/* ── Provider Balance Badge ── */
function ProviderBalanceBadge({ balance }: { balance?: string }) {
  if (!balance) return null;
  return (
    <span className="settings-provider-balance" data-tooltip={`账户余额：${balance}`}>
      {balance}
    </span>
  );
}

/* ── GetKey Button ── */
function GetKeyButton({ provider, label }: { provider: string; label: string }) {
  const url = PROVIDER_URLS[provider];
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="settings-getkey"
      aria-label={`前往 ${label} 获取 API Key`}
      data-tooltip={`前往 ${label} 获取 API Key`}
      onClick={(e) => {
        e.preventDefault();
        import('@tauri-apps/plugin-shell')
          .then(({ open }) => open(url))
          .catch(() => {
            window.open(url, '_blank', 'noopener,noreferrer');
          });
      }}
    >
      <LinkIcon />
      获取 Key
    </a>
  );
}

/* ── Config Input with save-on-blur ── */
function ConfigInput({
  id,
  type = 'text',
  defaultValue,
  placeholder,
  onSave,
  className = '',
}: {
  id: string;
  type?: string;
  defaultValue: string;
  placeholder: string;
  onSave: (value: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);

  return (
    <input
      type={type}
      id={id}
      className={`settings-input${className ? ` ${className}` : ''}`}
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value !== defaultValue) onSave(value);
      }}
    />
  );
}

export default function ApiKeySettings({ onClose }: { onClose: () => void }) {
  const {
    config,
    setProviderKey,
    updateConfig,
    saveConfig,
    addGeneralModel,
    updateGeneralModel,
    removeGeneralModel,
  } = useAppStore();

  const [testStates, setTestStates] = useState<Record<string, TestState>>({});

  // ── 通用模型表单状态 ──
  const [newModelName, setNewModelName] = useState('');
  const [newModelOpenaiUrl, setNewModelOpenaiUrl] = useState('');
  const [newModelAnthropicUrl, setNewModelAnthropicUrl] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [newModelApiKey, setNewModelApiKey] = useState('');
  const [newModelCategory, setNewModelCategory] = useState<GeneralModelCategory>('text');
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const generalModels = config.generalModels || [];

  // ── 即梦 Dreamina OAuth 登录 ──
  const [dreaminaLoading, setDreaminaLoading] = useState(false);
  const [dreaminaStatusMsg, setDreaminaStatusMsg] = useState('首次登录时会自动准备即梦组件');
  const [dreaminaModalOpen, setDreaminaModalOpen] = useState(false);
  const [dreaminaRuntime, setDreaminaRuntime] = useState<DreaminaRuntime | null>(null);
  const dreaminaDoneRef = useRef(false);
  const dreaminaAuth = config.dreaminaAuth;

  /** 打开外部链接 */
  const openExternalUrl = async (url: string) => {
    try {
      await import('@tauri-apps/plugin-shell').then(({ open }) => open(url));
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  /** 判断是否运行在 Tauri 环境中 */
  const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;

  const tauriInvoke = useCallback(
    async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<T>(cmd, args);
    },
    [],
  );

  /** 应用 Rust 推送的登录运行态；成功时镜像到配置 */
  const applyDreaminaRuntime = useCallback(
    (rt: DreaminaRuntime) => {
      setDreaminaRuntime(rt);
      if (rt.message) setDreaminaStatusMsg(rt.message);
      if (rt.phase === 'success' || rt.loggedIn) {
        updateConfig({
          dreaminaAuth: {
            loggedIn: true,
            username: rt.username || '即梦用户',
            credit: rt.credit || undefined,
            loginTs: Date.now(),
          },
        });
        if (!dreaminaDoneRef.current) {
          dreaminaDoneRef.current = true;
          useAppStore.getState().showToast('即梦登录成功');
          setTimeout(() => setDreaminaModalOpen(false), 800);
        }
      }
    },
    [updateConfig],
  );

  /** 启动即梦 OAuth 登录（force=true 为重新登录） */
  const handleDreaminaLogin = useCallback(
    async (force = false) => {
      if (!isTauri()) {
        setDreaminaStatusMsg('OAuth 登录仅在桌面应用中可用');
        return;
      }
      dreaminaDoneRef.current = false;
      setDreaminaLoading(true);
      setDreaminaRuntime(null);
      setDreaminaModalOpen(true);
      try {
        const rt = await tauriInvoke<DreaminaRuntime>('dreamina_login_start', { force });
        setDreaminaRuntime(rt);
      } catch (err: unknown) {
        const msg = typeof err === 'string' ? err : (err as Error)?.message || '启动登录失败';
        setDreaminaStatusMsg(msg);
      } finally {
        setDreaminaLoading(false);
      }
    },
    [tauriInvoke],
  );

  /** 即梦退出登录 */
  const handleDreaminaLogout = useCallback(async () => {
    setDreaminaLoading(true);
    try {
      if (isTauri()) await tauriInvoke('dreamina_logout');
    } catch {
      /* 忽略，本地仍清除登录态 */
    }
    updateConfig({ dreaminaAuth: undefined });
    setDreaminaRuntime(null);
    setDreaminaStatusMsg('已退出登录');
    setDreaminaLoading(false);
  }, [tauriInvoke, updateConfig]);

  const handleDreaminaCopy = useCallback((text: string, label: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    useAppStore.getState().showToast(`已复制${label}`);
  }, []);

  // 登录弹窗打开时：监听 Rust 事件 + 轮询兜底
  useEffect(() => {
    if (!dreaminaModalOpen || !isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const un = await listen<DreaminaRuntime>('dreamina-login-runtime', (e) => applyDreaminaRuntime(e.payload));
        if (cancelled) un();
        else unlisten = un;
      } catch {
        /* 事件不可用时仅靠轮询 */
      }
    })();
    const timer = setInterval(async () => {
      try {
        applyDreaminaRuntime(await tauriInvoke<DreaminaRuntime>('dreamina_login_runtime'));
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => {
      cancelled = true;
      unlisten?.();
      clearInterval(timer);
    };
  }, [dreaminaModalOpen, applyDreaminaRuntime, tauriInvoke]);

  // 打开设置时刷新一次即梦登录态（仅在已登录时校验/刷新额度，避免空跑 CLI）
  useEffect(() => {
    if (!isTauri() || !dreaminaAuth?.loggedIn) return;
    tauriInvoke<DreaminaRuntime>('dreamina_status')
      .then((rt) => {
        if (!rt.loggedIn) return;
        setDreaminaRuntime(rt);
        setDreaminaStatusMsg('即梦已登录');
        updateConfig({
          dreaminaAuth: {
            loggedIn: true,
            username: rt.username || '即梦用户',
            credit: rt.credit || undefined,
            loginTs: dreaminaAuth?.loginTs || Date.now(),
          },
        });
      })
      .catch(() => {});
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTest = async (provider: ProviderTestKey, apiKey: string, baseUrl?: string) => {
    setTestStates((prev) => ({ ...prev, [provider]: { status: 'testing' } }));
    const result = await testProviderConnection(provider, apiKey, baseUrl);
    setTestStates((prev) => ({ ...prev, [provider]: { status: 'done', result } }));
  };

  return (
    <div className="settings-pane">
      <h2 className="settings-pane-title">API Key</h2>
      <div className="settings-pane-body">
        <p className="settings-desc settings-desc-lead">
          为每个厂商单独配置接口地址和密钥，节点会根据所选模型自动路由。
        </p>

        {/* ── APIMart ── */}
        <div className="settings-section settings-card">
          <div className="settings-card-head">
            <div className="settings-card-badge">AM</div>
            <span className="settings-card-title">APIMart</span>
            <ProviderStatusBadge result={testStates.apimart?.result} />
            <ProviderBalanceBadge balance={testStates.apimart?.result?.balance} />
            <span className="settings-card-head-spacer" style={{ flex: 1 }} />
            <TestButton
              label="APIMart"
              state={testStates.apimart || { status: 'idle' }}
              onTest={() => handleTest('apimart', config.providers.apimart?.apiKey || '', config.providers.apimart?.baseUrl)}
            />
            <GetKeyButton provider="apimart" label="APIMart" />
          </div>
          <div className="settings-label">API 密钥</div>
          <ConfigInput type="password"
            id="providerKey-apimart"
            defaultValue={config.providers.apimart?.apiKey || ''}
            placeholder="sk-..."
            onSave={(v) => setProviderKey('apimart', v)}
          />
        </div>

        {/* ── 火山方舟 ── */}
        <div className="settings-section settings-card">
          <div className="settings-card-head">
            <div className="settings-card-badge settings-card-badge--volcengine">火</div>
            <span className="settings-card-title">火山方舟</span>
            <ProviderStatusBadge result={testStates.volcengine?.result} />
            <ProviderBalanceBadge balance={testStates.volcengine?.result?.balance} />
            <span className="settings-card-head-spacer" style={{ flex: 1 }} />
            <TestButton
              label="火山方舟"
              state={testStates.volcengine || { status: 'idle' }}
              onTest={() => handleTest('volcengine', config.providers.volcengine?.apiKey || '')}
            />
            <GetKeyButton provider="volcengine" label="火山方舟" />
          </div>
          <div className="settings-label">API 密钥</div>
          <ConfigInput type="password"
            id="providerKey-volcengine"
            defaultValue={config.providers.volcengine?.apiKey || ''}
            placeholder="ARK API Key..."
            onSave={(v) => setProviderKey('volcengine', v)}
          />
        </div>

        {/* ── RunningHUB ── */}
        <div className="settings-section settings-card">
          <div className="settings-card-head">
            <div className="settings-card-badge settings-card-badge--runninghub">RH</div>
            <span className="settings-card-title">RunningHUB</span>
            <ProviderStatusBadge result={testStates['runninghub-model']?.result} />
            <ProviderBalanceBadge balance={testStates['runninghub-model']?.result?.balance} />
            <span className="settings-card-head-spacer" style={{ flex: 1 }} />
            <TestButton
              label="RunningHUB"
              state={testStates['runninghub-model'] || { status: 'idle' }}
              onTest={() => handleTest('runninghub-model', config.providers['runninghub-model']?.apiKey || '')}
            />
            <GetKeyButton provider="runninghub" label="RunningHUB" />
          </div>
          <div className="settings-label">工作流 API 密钥 （消费级-会员）</div>
          <ConfigInput type="password"
            id="providerKey-runninghub"
            defaultValue={config.providers.runninghub?.apiKey || ''}
            placeholder="Bearer Token..."
            onSave={(v) => setProviderKey('runninghub', v)}
            className="settings-input--mb10"
          />
          <div className="settings-label">模型 API 密钥 （企业级-共享）</div>
          <ConfigInput type="password"
            id="providerKey-runninghub-model"
            defaultValue={config.providers['runninghub-model']?.apiKey || ''}
            placeholder="模型 API Key..."
            onSave={(v) => setProviderKey('runninghub-model', v)}
          />
        </div>

        {/* ── GRSAI ── */}
        <div className="settings-section settings-card">
          <div className="settings-card-head">
            <div className="settings-card-badge settings-card-badge--grsai">GR</div>
            <span className="settings-card-title">GRSAI</span>
            <ProviderStatusBadge result={testStates.grsai?.result} />
            <ProviderBalanceBadge balance={testStates.grsai?.result?.balance} />
            <span className="settings-card-head-spacer" style={{ flex: 1 }} />
            <TestButton
              label="GRSAI"
              state={testStates.grsai || { status: 'idle' }}
              onTest={() => handleTest('grsai', config.providers.grsai?.apiKey || '', config.providers.grsai?.baseUrl)}
            />
            <GetKeyButton provider="grsai" label="GRSAI" />
          </div>
          <div className="settings-label">API 密钥</div>
          <ConfigInput type="password"
            id="providerKey-grsai"
            defaultValue={config.providers.grsai?.apiKey || ''}
            placeholder="sk-..."
            onSave={(v) => setProviderKey('grsai', v)}
          />
        </div>

        {/* ── 即梦 Dreamina ── */}
        <div className="settings-section settings-card">
          <div className="settings-card-head">
            <div className="settings-card-badge settings-card-badge--dreamina">即</div>
            <span className="settings-card-title">即梦</span>
            {dreaminaAuth?.loggedIn && (
              <span className="settings-provider-status settings-provider-status--success">已登录</span>
            )}
            <span className="settings-card-head-spacer" style={{ flex: 1 }} />
            <GetKeyButton provider="dreamina" label="即梦" />
          </div>

          <div className="settings-label">登录状态</div>
          <div
            className={`dreamina-settings-status${dreaminaAuth?.loggedIn ? ' dreamina-settings-status--logged-in' : ''}`}
          >
            {dreaminaLoading ? '处理中…' : dreaminaAuth?.loggedIn ? `已登录${dreaminaAuth.username ? ` — ${dreaminaAuth.username}` : ''}` : '未登录'}
          </div>
          <div className="dreamina-settings-desc">{dreaminaStatusMsg}</div>

          <div className="settings-label">账户额度</div>
          <div className="dreamina-settings-inline">
            {dreaminaAuth?.loggedIn ? (dreaminaAuth.credit || '未获取到余额信息') : '登录后显示余额'}
          </div>

          <div className="dreamina-settings-actions">
            {!dreaminaAuth?.loggedIn ? (
              <AnimatedButton
                type="button"
                className="settings-save-btn"
                disabled={dreaminaLoading}
                onClick={() => handleDreaminaLogin(false)}
              >
                OAuth 登录
              </AnimatedButton>
            ) : (
              <>
                <AnimatedButton
                  type="button"
                  className="settings-save-btn"
                  disabled={dreaminaLoading}
                  onClick={() => handleDreaminaLogin(true)}
                >
                  重新登录
                </AnimatedButton>
                <AnimatedButton
                  type="button"
                  className="settings-save-btn settings-btn-ghost"
                  disabled={dreaminaLoading}
                  onClick={handleDreaminaLogout}
                >
                  退出登录
                </AnimatedButton>
              </>
            )}
          </div>
          <div className="dreamina-settings-desc" style={{ marginBottom: 0, marginTop: 10 }}>
            使用即梦官方 OAuth 授权链接登录；打开链接后输入验证码，系统会自动同步登录状态。
          </div>
        </div>

        <DreaminaLoginModal
          isOpen={dreaminaModalOpen}
          runtime={dreaminaRuntime}
          onClose={() => setDreaminaModalOpen(false)}
          onOpenUrl={openExternalUrl}
          onCopy={handleDreaminaCopy}
        />

        {/* ── 通用模型 ── */}
        <div className="settings-section settings-card">
          <div className="settings-card-head">
            <svg className="settings-icon--comfyui" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            <span className="settings-card-title">通用模型</span>
            <span className="text-[10px] text-canvas-text-muted">自定义兼容接口</span>
            <span className="settings-card-head-spacer" style={{ flex: 1 }} />
            <AnimatedButton
              type="button"
              className="settings-getkey"
              onClick={async () => {
                if (!newModelName.trim() || !newModelOpenaiUrl.trim() || !newModelId.trim()) return;
                addGeneralModel({
                  name: newModelName.trim(),
                  openaiUrl: newModelOpenaiUrl.trim(),
                  anthropicUrl: newModelAnthropicUrl.trim(),
                  modelId: newModelId.trim(),
                  apiKey: newModelApiKey.trim(),
                  category: newModelCategory,
                });
                setNewModelName('');
                setNewModelOpenaiUrl('');
                setNewModelAnthropicUrl('');
                setNewModelId('');
                setNewModelApiKey('');
                setNewModelCategory('text');
                await saveConfig();
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加模型
            </AnimatedButton>
          </div>

          {/* ── 新模型输入表单 ── */}
          <div className="general-model-form">
            <div className="general-model-form-row">
              <div className="general-model-form-col general-model-form-col--name">
                <div className="settings-label">名称</div>
                <input type="text" className="settings-input"
                  placeholder="如 DeepSeek"
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                />
              </div>
              <div className="general-model-form-col general-model-form-col--model">
                <div className="settings-label">模型 ID</div>
                <input type="text" className="settings-input"
                  placeholder="如 deepseek-v4-pro"
                  value={newModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                />
              </div>
            </div>
            <div className="general-model-form-row">
              <div className="general-model-form-col">
                <div className="settings-label">OpenAI 地址</div>
                <input type="text" className="settings-input"
                  placeholder="https://api.deepseek.com"
                  value={newModelOpenaiUrl}
                  onChange={(e) => setNewModelOpenaiUrl(e.target.value)}
                />
              </div>
            </div>
            <div className="general-model-form-row">
              <div className="general-model-form-col">
                <div className="settings-label">Anthropic 地址</div>
                <input type="text" className="settings-input"
                  placeholder="https://api.deepseek.com/anthropic"
                  value={newModelAnthropicUrl}
                  onChange={(e) => setNewModelAnthropicUrl(e.target.value)}
                />
              </div>
            </div>
            <div className="general-model-form-row">
              <div className="general-model-form-col">
                <div className="settings-label">API 密钥</div>
                <input type="password" className="settings-input"
                  placeholder="sk-..."
                  value={newModelApiKey}
                  onChange={(e) => setNewModelApiKey(e.target.value)}
                />
              </div>
            </div>
            <div className="general-model-form-row">
              <div className="general-model-form-col general-model-form-col--category">
                <div className="settings-label">模型种类</div>
                <div className="general-model-category-select">
                  {(['text', 'image', 'video', 'audio'] as GeneralModelCategory[]).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className={`general-model-category-btn${newModelCategory === cat ? ' active' : ''}`}
                      style={newModelCategory === cat ? { '--cat-color': GENERAL_MODEL_CATEGORY_COLORS[cat] } as React.CSSProperties : undefined}
                      onClick={() => setNewModelCategory(cat)}
                    >
                      {GENERAL_MODEL_CATEGORY_LABELS[cat]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

          </div>

          {/* ── 已添加的模型列表 ── */}
          {generalModels.length > 0 && (
            <div className="general-model-list">
              <div className="settings-label" style={{ marginTop: 12 }}>已添加的模型</div>
              {generalModels.map((m) => (
                <div key={m.id} className="general-model-item">
                  <div className="general-model-item-header">
                    <span className="general-model-item-name">{m.name}</span>
                    <span
                      className="general-model-item-category"
                      style={{ color: GENERAL_MODEL_CATEGORY_COLORS[m.category], background: `${GENERAL_MODEL_CATEGORY_COLORS[m.category]}1a` }}
                    >
                      {GENERAL_MODEL_CATEGORY_LABELS[m.category]}
                    </span>
                    <span className="general-model-item-id">{m.modelId}</span>
                    <span className="general-model-item-head-spacer" style={{ flex: 1 }} />
                    <AnimatedButton
                      type="button"
                      className="settings-provider-test-btn"
                      onClick={() => setEditingModelId(m.id)}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </AnimatedButton>
                    <AnimatedButton
                      type="button"
                      className="general-model-item-remove"
                      onClick={() => removeGeneralModel(m.id)}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </AnimatedButton>
                  </div>
                  {editingModelId === m.id ? (
                    <div className="general-model-form general-model-edit-form">
                      <div className="general-model-form-row">
                        <div className="general-model-form-col general-model-form-col--name">
                          <div className="settings-label">名称</div>
                          <input type="text" className="settings-input"
                            defaultValue={m.name}
                            onBlur={(e) => updateGeneralModel(m.id, { name: e.target.value })}
                          />
                        </div>
                        <div className="general-model-form-col general-model-form-col--model">
                          <div className="settings-label">模型 ID</div>
                          <input type="text" className="settings-input"
                            defaultValue={m.modelId}
                            onBlur={(e) => updateGeneralModel(m.id, { modelId: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="general-model-form-row">
                        <div className="general-model-form-col">
                          <div className="settings-label">OpenAI 地址</div>
                          <input type="text" className="settings-input"
                            defaultValue={m.openaiUrl}
                            onBlur={(e) => updateGeneralModel(m.id, { openaiUrl: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="general-model-form-row">
                        <div className="general-model-form-col">
                          <div className="settings-label">Anthropic 地址</div>
                          <input type="text" className="settings-input"
                            defaultValue={m.anthropicUrl}
                            onBlur={(e) => updateGeneralModel(m.id, { anthropicUrl: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="general-model-form-row">
                        <div className="general-model-form-col">
                          <div className="settings-label">API 密钥</div>
                          <input type="password" className="settings-input"
                            defaultValue={m.apiKey}
                            onBlur={(e) => updateGeneralModel(m.id, { apiKey: e.target.value })}
                          />
                        </div>
                        <div className="general-model-form-col general-model-form-col--category">
                          <div className="settings-label">模型种类</div>
                          <div className="general-model-category-select">
                            {(['text', 'image', 'video', 'audio'] as GeneralModelCategory[]).map((cat) => (
                              <button
                                key={cat}
                                type="button"
                                className={`general-model-category-btn${m.category === cat ? ' active' : ''}`}
                                style={m.category === cat ? { '--cat-color': GENERAL_MODEL_CATEGORY_COLORS[cat] } as React.CSSProperties : undefined}
                                onClick={() => updateGeneralModel(m.id, { category: cat })}
                              >
                                {GENERAL_MODEL_CATEGORY_LABELS[cat]}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <AnimatedButton
                        type="button"
                        className="settings-save-btn"
                        style={{ marginTop: 8 }}
                        onClick={() => setEditingModelId(null)}
                      >
                        收起
                      </AnimatedButton>
                    </div>
                  ) : (<div></div>)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="settings-pane-footer">
        <div className="settings-save-row">
          <AnimatedButton
            type="button"
            className="settings-save-btn settings-btn-ghost settings-api-test-btn"
            onClick={() => console.log('Test all connections')}
          >
            <TestIcon />
            <span className="settings-btn-label">测试连接</span>
          </AnimatedButton>
          <AnimatedButton
            type="button"
            className="settings-save-btn"
            onClick={async () => {
              await saveConfig();
              onClose();
            }}
          >
            保存
          </AnimatedButton>
        </div>
      </div>
    </div>
  );
}
