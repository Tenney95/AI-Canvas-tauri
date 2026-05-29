import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { TestResult } from '../services/testConnection';
import { testProviderConnection, type ProviderTestKey } from '../services/testConnection';

/* ── External URLs ── */
const PROVIDER_URLS: Record<string, string> = {
  apimart: 'https://apimart.ai/zh/register?aff=ashuoai',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  runninghub: 'https://www.runninghub.cn/?inviteCode=rh-v1312',
  grsai: 'https://grsai.com/zh/dashboard/user-info',
  ppio: 'https://ppio.com/user/register?invited_by=SF4VL3',
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
    <button
      type="button"
      className="settings-provider-test-btn"
      aria-label={`测试 ${label} 连接`}
      title={`测试 ${label} 连接`}
      disabled={testing}
      onClick={onTest}
    >
      {testing ? <SpinnerIcon /> : <TestIcon />}
      <span className="settings-btn-label">{testing ? '测试中…' : '测试连接'}</span>
    </button>
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
    <span className="settings-provider-status settings-provider-status--danger" title={result.error}>
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
    <span className="settings-provider-balance" title={`账户余额：${balance}`}>
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
      title={`前往 ${label} 获取 API Key`}
      onClick={(e) => {
        e.preventDefault();
        import('@tauri-apps/plugin-shell')
          .then(({ open }) => open(url))
          .catch(() => {
            // Tauri shell unavailable or failed → fallback to window.open
            window.open(url, '_blank', 'noopener,noreferrer');
          });
      }}
    >
      <LinkIcon />
      获取 Key
    </a>
  );
}

/* ── Password Input with save-on-blur ── */
function ApiKeyInput({
  id,
  defaultValue,
  placeholder,
  onSave,
  className = '',
}: {
  id: string;
  defaultValue: string;
  placeholder: string;
  onSave: (value: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);

  return (
    <input
      type="password"
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

function UrlInput({
  id,
  defaultValue,
  placeholder,
  onSave,
  className = '',
}: {
  id: string;
  defaultValue: string;
  placeholder: string;
  onSave: (value: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);

  return (
    <input
      type="text"
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

export default function SettingsPanel() {
  const { settingsOpen, setSettingsOpen, config, setProviderKey, setProviderUrl, updateConfig, saveConfig } =
    useAppStore();
  const [activeTab, setActiveTab] = useState<'general' | 'api' | 'shortcuts'>('api');
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});

  const handleTest = async (provider: ProviderTestKey, apiKey: string, baseUrl?: string) => {
    setTestStates((prev) => ({ ...prev, [provider]: { status: 'testing' } }));
    const result = await testProviderConnection(provider, apiKey, baseUrl);
    setTestStates((prev) => ({ ...prev, [provider]: { status: 'done', result } }));
  };

  if (!settingsOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setSettingsOpen(false)}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative w-[640px] max-h-[80vh] bg-canvas-surface border border-canvas-border rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-canvas-border">
          <h2 className="text-base font-semibold text-canvas-text">设置</h2>
          <button
            onClick={() => setSettingsOpen(false)}
            className="w-8 h-8 rounded-lg hover:bg-canvas-hover flex items-center justify-center text-canvas-text-secondary hover:text-canvas-text transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Sidebar Nav */}
          <nav className="w-44 border-r border-canvas-border p-3 space-y-0.5 shrink-0">
            {[
              { id: 'api', label: 'API Key' },
              { id: 'general', label: '常规' },
              { id: 'shortcuts', label: '快捷键' },
            ].map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id as typeof activeTab)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                  activeTab === id ? 'bg-indigo-500/15 text-indigo-400' : 'text-canvas-text-secondary hover:bg-canvas-hover'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {id === 'api' && (
                    <>
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                    </>
                  )}
                  {id === 'general' && (
                    <>
                      <rect x="3" y="3" width="7" height="7" rx="1" />
                      <rect x="14" y="3" width="7" height="7" rx="1" />
                      <rect x="14" y="14" width="7" height="7" rx="1" />
                      <rect x="3" y="14" width="7" height="7" rx="1" />
                    </>
                  )}
                  {id === 'shortcuts' && (
                    <>
                      <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
                      <line x1="6" y1="8" x2="6.01" y2="8" /><line x1="10" y1="8" x2="10.01" y2="8" />
                      <line x1="14" y1="8" x2="14.01" y2="8" /><line x1="18" y1="8" x2="18.01" y2="8" />
                      <line x1="8" y1="12" x2="8.01" y2="12" /><line x1="12" y1="12" x2="12.01" y2="12" />
                      <line x1="16" y1="12" x2="16.01" y2="12" /><line x1="7" y1="16" x2="17" y2="16" />
                    </>
                  )}
                </svg>
                {label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="settings-content flex-1 overflow-y-auto p-5">
            {activeTab === 'api' && (
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
                    <ApiKeyInput
                      id="providerKey-apimart"
                      defaultValue={config.providers.apimart?.apiKey || ''}
                      placeholder="sk-..."
                      onSave={(v) => setProviderKey('apimart', v)}
                    />
                  </div>

                  {/* ── 火山方舟 ── */}
                  <div className="settings-section settings-card">
                    <div className="settings-card-head">
                      {/* Volcano engine icon — place-initial */}
                      <div className="settings-card-badge" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa' }}>火</div>
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
                    <ApiKeyInput
                      id="providerKey-volcengine"
                      defaultValue={config.providers.volcengine?.apiKey || ''}
                      placeholder="ARK API Key..."
                      onSave={(v) => setProviderKey('volcengine', v)}
                    />
                  </div>

                  {/* ── RunningHUB ── */}
                  <div className="settings-section settings-card">
                    <div className="settings-card-head">
                      <div className="settings-card-badge" style={{ background: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6' }}>RH</div>
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
                    <ApiKeyInput
                      id="providerKey-runninghub"
                      defaultValue={config.providers.runninghub?.apiKey || ''}
                      placeholder="Bearer Token..."
                      onSave={(v) => setProviderKey('runninghub', v)}
                      className="settings-input--mb10"
                    />
                    <div className="settings-label">模型 API 密钥 （企业级-共享）</div>
                    <ApiKeyInput
                      id="providerKey-runninghub-model"
                      defaultValue={config.providers['runninghub-model']?.apiKey || ''}
                      placeholder="模型 API Key..."
                      onSave={(v) => setProviderKey('runninghub-model', v)}
                    />
                  </div>

                  {/* ── GRSAI ── */}
                  <div className="settings-section settings-card">
                    <div className="settings-card-head">
                      <div className="settings-card-badge" style={{ background: 'rgba(244, 114, 182, 0.15)', color: '#f472b6' }}>GR</div>
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
                    <ApiKeyInput
                      id="providerKey-grsai"
                      defaultValue={config.providers.grsai?.apiKey || ''}
                      placeholder="sk-..."
                      onSave={(v) => setProviderKey('grsai', v)}
                    />
                  </div>

                  {/* ── OpenAI兼容的API格式 ── */}
                  <div className="settings-section settings-card">
                    <div className="settings-card-head">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary, #8888a0)" strokeWidth="1.5">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 8v4l3 3" />
                      </svg>
                      <span className="settings-card-title">OpenAI兼容的API格式</span>
                      <ProviderStatusBadge result={testStates.openai?.result} />
                      <ProviderBalanceBadge balance={testStates.openai?.result?.balance} />
                      <span className="settings-hint-icon settings-hint-icon--inline" id="openai-format-hint">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="12" y1="8" x2="12" y2="13" />
                          <circle cx="12" cy="16" r="0.8" fill="currentColor" stroke="none" />
                        </svg>
                        <div className="settings-hint-tooltip">
                          <div className="settings-hint-tooltip-content">
                            正确的 OpenAI 通用接口格式 是在 <span className="curl-highlight">curl</span> 后面 例如：<br /><br />
                            <span className="curl-highlight">curl</span> <code>http://api.deepseek.com/chat/completions</code>
                          </div>
                          <div className="settings-hint-tooltip-arrow" />
                        </div>
                      </span>
                      <span className="settings-card-head-spacer" style={{ flex: 1 }} />
                      <TestButton
                        label="OpenAI 兼容"
                        state={testStates.openai || { status: 'idle' }}
                        onTest={() => handleTest('openai', config.providers.openai?.apiKey || '', config.providers.openai?.baseUrl)}
                      />
                    </div>
                    <div className="settings-label">接口地址</div>
                    <UrlInput
                      id="providerUrl-openai"
                      defaultValue={config.providers.openai?.baseUrl || ''}
                      placeholder="https://api.openai.com"
                      onSave={(v) => setProviderUrl('openai', v)}
                      className="settings-input--mb10"
                    />
                    <div className="settings-label">API 密钥</div>
                    <ApiKeyInput
                      id="providerKey-openai"
                      defaultValue={config.providers.openai?.apiKey || ''}
                      placeholder="sk-..."
                      onSave={(v) => setProviderKey('openai', v)}
                    />
                  </div>

                  {/* ── 即梦 Dreamina ── */}
                  <div className="settings-section settings-card" id="dreaminaSettingsCard">
                    <div className="settings-card-head">
                      <div className="settings-card-badge" style={{ background: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' }}>即</div>
                      <span className="settings-card-title">即梦</span>
                      <span className="settings-card-head-spacer" style={{ flex: 1 }} />
                      <span className="settings-getkey settings-getkey--muted">网页登录 / 扫码登录</span>
                    </div>
                    <div className="settings-label">登录状态</div>
                    <div className="dreamina-settings-status" id="dreaminaStatusText">未登录</div>
                    <div className="dreamina-settings-desc" id="dreaminaStatusMessage">首次登录时会自动准备即梦组件</div>
                    <div className="settings-label">账户额度</div>
                    <div className="dreamina-settings-inline" id="dreaminaCreditText">登录后显示余额</div>
                    <div className="dreamina-settings-actions">
                      <button type="button" className="settings-save-btn" id="btnDreaminaAuth">
                        网页登录
                      </button>
                      <button type="button" className="settings-save-btn settings-btn-ghost" id="btnDreaminaQrAuth">
                        扫码登录
                      </button>
                      <button type="button" className="settings-save-btn settings-btn-ghost" id="btnDreaminaLogout" disabled>
                        退出登录
                      </button>
                    </div>
                    <div className="dreamina-settings-desc" style={{ marginBottom: 0, marginTop: 10 }}>
                      推荐使用网页登录完成授权；扫码登录保留为备用，二维码可能受浏览器或网络环境影响。
                    </div>
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
                    <div className="settings-label">本地大模型调用地址</div>
                    <input
                      type="text"
                      className="settings-input settings-input--mb10"
                      placeholder="http://localhost:11434/v1"
                      defaultValue={config.localLLMUrl || ''}
                      onBlur={(e) => updateConfig({ localLLMUrl: e.target.value })}
                    />
                    <p className="text-[11px] text-canvas-text-muted" style={{ marginTop: -4, marginBottom: 8 }}>
                      Ollama、vLLM 等本地大模型的 API 端点地址
                    </p>
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
                    <button
                      type="button"
                      className="settings-save-btn settings-btn-ghost settings-api-test-btn"
                      onClick={() => console.log('Test all connections')}
                    >
                      <TestIcon />
                      <span className="settings-btn-label">测试连接</span>
                    </button>
                    <button
                      type="button"
                      className="settings-save-btn"
                      onClick={async () => {
                        await saveConfig();
                        setSettingsOpen(false);
                      }}
                    >
                      保存
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'general' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">输入偏好</h3>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-canvas-text">鼠标大小</div>
                        <div className="text-xs text-canvas-text-muted mt-0.5">选择光标显示大小</div>
                      </div>
                      <div className="flex gap-1">
                        {['小', '中', '大'].map((size, i) => (
                          <button
                            key={size}
                            className={`px-3 py-1.5 rounded-md text-xs ${i === 1 ? 'bg-indigo-500/20 text-indigo-400' : 'bg-canvas-card text-canvas-text-secondary hover:bg-canvas-hover'}`}
                          >
                            {size}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <div className="space-y-2">
                <p className="text-sm text-canvas-text-muted mb-4">键盘快捷键配置</p>
                {[
                  { action: '保存画布', key: 'Ctrl + S' },
                  { action: '撤销', key: 'Ctrl + Z' },
                  { action: '重做', key: 'Ctrl + Shift + Z' },
                  { action: '删除节点', key: 'Delete / D' },
                  { action: '适应画布', key: 'F' },
                  { action: '小地图', key: 'M' },
                  { action: '网格吸附', key: 'L' },
                  { action: '添加节点', key: '双击画布' },
                ].map(({ action, key }) => (
                  <div key={action} className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-canvas-hover">
                    <span className="text-sm text-canvas-text">{action}</span>
                    <kbd className="px-2 py-0.5 bg-canvas-card border border-canvas-border rounded text-[11px] text-canvas-text-secondary font-mono">
                      {key}
                    </kbd>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
