import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';

const providers = [
  { key: 'openai', label: 'OpenAI 兼容接口', placeholder: 'sk-...', hasUrl: true },
  { key: 'apimart', label: 'APIMart', placeholder: 'sk-...' },
  { key: 'runninghub', label: 'RunningHub', placeholder: 'Bearer Token...' },
  { key: 'grsai', label: 'GRSAI', placeholder: 'sk-...' },
  { key: 'dreamina', label: '即梦 Dreamina', placeholder: 'API Key...' },
  { key: 'volcengine', label: '火山方舟', placeholder: 'ARK API Key...' },
];

export default function SettingsPanel() {
  const { settingsOpen, setSettingsOpen, config, setProviderKey, updateConfig, saveConfig } = useAppStore();
  const [activeTab, setActiveTab] = useState<'general' | 'api' | 'shortcuts'>('api');

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
              { id: 'general', label: '常规', icon: 'M4 4h7V11H4zM13 4h7v9h-7zM4 16h7v5H4zM13 16h7v5h-7z' },
              { id: 'api', label: 'API Key', icon: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z' },
              { id: 'shortcuts', label: '快捷键', icon: 'M2 8l4 4-4 4M22 10H12M22 14H12M8 8H2M8 16H2' },
            ].map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id as typeof activeTab)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                  activeTab === id ? 'bg-indigo-500/15 text-indigo-400' : 'text-canvas-text-secondary hover:bg-canvas-hover'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {id === 'general' && (
                    <>
                      <rect x="3" y="3" width="7" height="7" rx="1" />
                      <rect x="14" y="3" width="7" height="7" rx="1" />
                      <rect x="14" y="14" width="7" height="7" rx="1" />
                      <rect x="3" y="14" width="7" height="7" rx="1" />
                    </>
                  )}
                  {id === 'api' && (
                    <>
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
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
          <div className="flex-1 overflow-y-auto p-5">
            {activeTab === 'api' && (
              <div className="space-y-4">
                <p className="text-sm text-canvas-text-muted leading-relaxed">
                  为每个厂商单独配置 API 密钥，节点会根据所选模型自动路由。
                </p>
                {providers.map((provider) => {
                  const savedConfig = config.providers[provider.key];
                  return (
                    <div key={provider.key} className="bg-canvas-card rounded-xl border border-canvas-border p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <span className="w-8 h-8 rounded-lg bg-indigo-500/15 flex items-center justify-center text-xs font-bold text-indigo-400">
                          {provider.label.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="text-sm font-medium text-canvas-text">{provider.label}</span>
                      </div>
                      {provider.hasUrl && (
                        <div>
                          <label className="block text-xs text-canvas-text-secondary mb-1">接口地址</label>
                          <input
                            type="text"
                            defaultValue={savedConfig?.baseUrl || ''}
                            placeholder="https://api.openai.com"
                            className="w-full px-3 py-2 bg-canvas-bg border border-canvas-border rounded-lg text-sm text-canvas-text placeholder:text-canvas-text-muted outline-none focus:border-indigo-500 transition-colors"
                          />
                        </div>
                      )}
                      <div>
                        <label className="block text-xs text-canvas-text-secondary mb-1">API 密钥</label>
                        <input
                          type="password"
                          defaultValue={savedConfig?.apiKey || ''}
                          onChange={(e) => setProviderKey(provider.key, e.target.value)}
                          placeholder={provider.placeholder}
                          className="w-full px-3 py-2 bg-canvas-bg border border-canvas-border rounded-lg text-sm text-canvas-text placeholder:text-canvas-text-muted outline-none focus:border-indigo-500 transition-colors"
                        />
                      </div>
                    </div>
                  );
                })}

                {/* 服务地址 */}
                <div className="bg-canvas-card rounded-xl border border-canvas-border p-4 space-y-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-8 h-8 rounded-lg bg-emerald-500/15 flex items-center justify-center text-xs font-bold text-emerald-400">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <ellipse cx="12" cy="5" rx="9" ry="3" />
                        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                      </svg>
                    </span>
                    <span className="text-sm font-medium text-canvas-text">服务地址</span>
                  </div>
                  <div>
                    <label className="block text-xs text-canvas-text-secondary mb-1">本地大模型调用地址</label>
                    <input
                      type="text"
                      defaultValue={config.localLLMUrl || ''}
                      onChange={(e) => updateConfig({ localLLMUrl: e.target.value })}
                      placeholder="http://localhost:11434/v1"
                      className="w-full px-3 py-2 bg-canvas-bg border border-canvas-border rounded-lg text-sm text-canvas-text placeholder:text-canvas-text-muted outline-none focus:border-indigo-500 transition-colors"
                    />
                    <p className="text-[11px] text-canvas-text-muted mt-1">Ollama、vLLM 等本地大模型的 API 端点地址</p>
                  </div>
                  <div>
                    <label className="block text-xs text-canvas-text-secondary mb-1">ComfyUI 服务地址</label>
                    <input
                      type="text"
                      defaultValue={config.comfyUIUrl || ''}
                      onChange={(e) => updateConfig({ comfyUIUrl: e.target.value })}
                      placeholder="http://127.0.0.1:8188"
                      className="w-full px-3 py-2 bg-canvas-bg border border-canvas-border rounded-lg text-sm text-canvas-text placeholder:text-canvas-text-muted outline-none focus:border-indigo-500 transition-colors"
                    />
                    <p className="text-[11px] text-canvas-text-muted mt-1">ComfyUI 后端服务的地址，用于执行导入的工作流</p>
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    onClick={async () => {
                      await saveConfig();
                      setSettingsOpen(false);
                    }}
                    className="px-5 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    保存配置
                  </button>
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
