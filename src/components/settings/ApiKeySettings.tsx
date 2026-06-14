/**
 * ApiKeySettings — API Key 配置面板，管理各 AI 厂商密钥、连接测试、通用模型、服务地址
 */
import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { TestResult } from '../../services/testConnection';
import { testProviderConnection, type ProviderTestKey } from '../../services/testConnection';
import AnimatedButton from '../shared/AnimatedButton';
import {
  GENERAL_MODEL_CATEGORY_LABELS,
  GENERAL_MODEL_CATEGORY_COLORS,
  type GeneralModelCategory,
} from '../../types';

/* ── External URLs ── */
const PROVIDER_URLS: Record<string, string> = {
  apimart: 'https://apib.ai/zh/register?aff=ashuoai',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  runninghub: 'https://www.runninghub.cn/?inviteCode=rh-v1312',
  grsai: 'https://grsai.com/zh/dashboard/user-info',
  ppio: 'https://ppio.com/user/register?invited_by=SF4VL3',
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
  const [newModelCategory, setNewModelCategory] = useState<GeneralModelCategory>('mixed');
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const generalModels = config.generalModels || [];

  // ── 即梦 Dreamina 登录状态 ──
  const [dreaminaLoading, setDreaminaLoading] = useState(false);
  const [dreaminaCookieInput, setDreaminaCookieInput] = useState('');
  const [dreaminaStatusMsg, setDreaminaStatusMsg] = useState('首次登录时会自动准备即梦组件');
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
  const isTauri = (): boolean => {
    return '__TAURI_INTERNALS__' in window;
  };

  /** 即梦网页登录 */
  const handleDreaminaWebLogin = async () => {
    if (isTauri()) {
      setDreaminaLoading(true);
      setDreaminaStatusMsg('正在打开即梦登录窗口…');
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const result = await invoke<{ cookie: string }>('dreamina_login');
        if (result.cookie) {
          updateConfig({
            dreaminaAuth: {
              loggedIn: true,
              username: '即梦用户',
              cookie: result.cookie,
              loginTs: Date.now(),
            },
          });
          setDreaminaStatusMsg('登录成功！已自动获取凭证');
          setDreaminaCookieInput('');
        }
      } catch (err: unknown) {
        const msg = typeof err === 'string' ? err : (err as Error)?.message || '未知错误';
        setDreaminaStatusMsg(`登录失败: ${msg}`);
      } finally {
        setDreaminaLoading(false);
      }
      return;
    }
    setDreaminaLoading(true);
    setDreaminaStatusMsg('请在浏览器中完成即梦登录…');
    try {
      await openExternalUrl('https://jimeng.jianying.com/');
      setDreaminaStatusMsg('请在浏览器中登录即梦后，将 Cookie 粘贴到下方输入框并保存');
    } catch {
      setDreaminaStatusMsg('打开浏览器失败，请手动访问 dreamina.com 登录');
    } finally {
      setDreaminaLoading(false);
    }
  };

  /** 保存即梦 Cookie/Token */
  const handleDreaminaCookieSave = async () => {
    const cookie = dreaminaCookieInput.trim();
    if (!cookie) {
      setDreaminaStatusMsg('请输入 Cookie/Token');
      return;
    }
    setDreaminaLoading(true);
    setDreaminaStatusMsg('正在验证登录状态…');
    try {
      const resp = await fetch('https://api.dreamina.com/v1/user/info', {
        headers: { 'Cookie': cookie },
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        updateConfig({
          dreaminaAuth: {
            loggedIn: true,
            username: data.username || data.nickname || '即梦用户',
            credit: data.credit || data.balance || undefined,
            cookie,
            loginTs: Date.now(),
          },
        });
        setDreaminaStatusMsg('已连接到即梦账户');
        setDreaminaCookieInput('');
      } else {
        setDreaminaStatusMsg(`验证失败 (${resp.status})，请检查 Cookie 是否有效`);
      }
    } catch {
      updateConfig({
        dreaminaAuth: {
          loggedIn: true,
          username: '即梦用户',
          cookie,
          loginTs: Date.now(),
        },
      });
      setDreaminaStatusMsg('已保存登录信息（离线模式），下次调用 API 时将自动验证');
      setDreaminaCookieInput('');
    } finally {
      setDreaminaLoading(false);
    }
  };

  /** 即梦退出登录 */
  const handleDreaminaLogout = () => {
    updateConfig({ dreaminaAuth: undefined });
    setDreaminaCookieInput('');
    setDreaminaStatusMsg('已退出登录');
  };

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
        <div className="settings-section settings-card" style={{ display: 'none' }}>
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

          <div className="settings-label">
            Cookie / Token
            <span className="dreamina-settings-desc" style={{ marginLeft: 6, fontSize: 10 }}>
              {dreaminaAuth?.loggedIn ? '（已保存，可留空）' : '（登录后在此粘贴浏览器 Cookie）'}
            </span>
          </div>
          <input
            type="password"
            className="settings-input settings-input--mb10"
            placeholder={dreaminaAuth?.loggedIn ? '留空则保持当前登录…' : '粘贴浏览器中的 Cookie…'}
            value={dreaminaCookieInput}
            onChange={(e) => setDreaminaCookieInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleDreaminaCookieSave(); }}
          />

          <div className="dreamina-settings-actions">
            {!dreaminaAuth?.loggedIn ? (
              <>
                <AnimatedButton
                  type="button"
                  className="settings-save-btn"
                  disabled={dreaminaLoading}
                  onClick={handleDreaminaWebLogin}
                >
                  网页登录
                </AnimatedButton>
                <AnimatedButton
                  type="button"
                  className="settings-save-btn"
                  disabled={!dreaminaCookieInput.trim() || dreaminaLoading}
                  onClick={handleDreaminaCookieSave}
                >
                  保存登录
                </AnimatedButton>
              </>
            ) : (
              <>
                <AnimatedButton
                  type="button"
                  className="settings-save-btn"
                  disabled={!dreaminaCookieInput.trim() || dreaminaLoading}
                  onClick={handleDreaminaCookieSave}
                >
                  更新登录
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
            点击网页登录完成授权，支持手机号、扫码等多种方式。登录成功后 Cookie 将自动填充，也可手动粘贴到上方输入框保存。
          </div>
        </div>

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
                setNewModelCategory('mixed');
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
                  {(['mixed', 'text', 'image', 'video', 'audio'] as GeneralModelCategory[]).map((cat) => (
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
                            {(['mixed', 'text', 'image', 'video', 'audio'] as GeneralModelCategory[]).map((cat) => (
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

        {/* ── 服务地址 ── */}
        <div className="settings-section settings-card settings-service-card">
          <div className="settings-card-head">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary, #8888a0)" strokeWidth="1.5">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
              <circle cx="6" cy="6" r="1" fill="currentColor" />
              <circle cx="10" cy="6" r="1" fill="currentColor" />
            </svg>
            <span className="settings-card-title">服务地址</span>
          </div>
          <div className="settings-label">ComfyUI 服务地址</div>
          <input
            type="text"
            className="settings-input"
            placeholder="http://127.0.0.1:8188"
            defaultValue={config.comfyUIUrl || ''}
            onBlur={(e) => updateConfig({ comfyUIUrl: e.target.value })}
          />
          <p className="text-[11px] text-canvas-text-muted" style={{ marginTop: 4 }}>
            ComfyUI 后端服务的地址，用于执行导入的工作流
          </p>
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
