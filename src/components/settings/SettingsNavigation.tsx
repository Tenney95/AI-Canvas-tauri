/**
 * settings/SettingsNavigation — 设置面板左侧导航。
 * 渲染常规、文件与应用、API Key、存储健康、ComfyUI、快捷键、MCP 控制等标签，
 * 高亮当前激活的子页并驱动 store.ui 的 SettingsTab 切换。
 */
import { Icon } from '@iconify/react';
import type { SettingsTab } from '../../store/store.ui';
import AnimatedButton from '../shared/AnimatedButton';
import { useT } from '../../i18n';
import { useAppVersion } from '../../hooks/useAppVersion';

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: '常规' },
  { id: 'appearance', label: '外观' },
  { id: 'files', label: '文件与应用' },
  { id: 'api', label: 'API Key' },
  { id: 'storage', label: '存储健康' },
  { id: 'comfyui', label: 'ComfyUI' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'plugins', label: '插件' },
  { id: 'external-agents', label: '外部 Agent' },
  { id: 'mcp', label: 'MCP 控制' },
];

function SettingsTabIcon({ tab }: { tab: SettingsTab }) {
  if (tab === 'external-agents') return <Icon icon="lucide:bot" width="18" height="18" />;
  if (tab === 'mcp') return <Icon icon="lucide:plug-zap" width="18" height="18" />;
  if (tab === 'plugins') return <Icon icon="lucide:blocks" width="18" height="18" />;
  if (tab === 'appearance') return <Icon icon="lucide:palette" width="18" height="18" />;
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      {tab === 'storage' && (
        <>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </>
      )}
      {tab === 'api' && (
        <>
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </>
      )}
      {tab === 'files' && (
        <>
          <path d="M3 7a2 2 0 012-2h4l2 3h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
          <path d="M8 13h8" />
        </>
      )}
      {tab === 'comfyui' && (
        <>
          <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
        </>
      )}
      {tab === 'general' && (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
        </>
      )}
      {tab === 'shortcuts' && (
        <>
          <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
          <line x1="6" y1="8" x2="6.01" y2="8" /><line x1="10" y1="8" x2="10.01" y2="8" />
          <line x1="14" y1="8" x2="14.01" y2="8" /><line x1="18" y1="8" x2="18.01" y2="8" />
          <line x1="8" y1="12" x2="8.01" y2="12" /><line x1="12" y1="12" x2="12.01" y2="12" />
          <line x1="16" y1="12" x2="16.01" y2="12" /><line x1="7" y1="16" x2="17" y2="16" />
        </>
      )}
    </svg>
  );
}

export default function SettingsNavigation({
  activeTab,
  onSelect,
}: {
  activeTab: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
}) {
  const t = useT();
  const appVersion = useAppVersion();
  return (
    <aside className="w-60 settings-sidebar p-2.5 pb-0 flex flex-col justify-between shrink-0 select-none">
      <nav aria-label={t('设置菜单')} className="space-y-1">
        {SETTINGS_TABS.map(({ id, label }) => {
          const isActive = activeTab === id;
          return (
            <AnimatedButton
              key={id}
              onClick={() => onSelect(id)}
              className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-[14px] font-medium transition-all group ${
                isActive ? 'settings-sidebar-btn--active' : 'settings-sidebar-btn'
              }`}
            >
              <span className="w-[18px] h-[18px] flex items-center justify-center shrink-0 settings-sidebar-icon">
                <SettingsTabIcon tab={id} />
              </span>
              <span>{t(label)}</span>
            </AnimatedButton>
          );
        })}
      </nav>

      <div className="settings-sidebar-footer px-3 py-2 text-[11px] flex items-center justify-between">
        <span>v{appVersion} Pro</span>
        <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          {t('运行正常')}
        </span>
      </div>
    </aside>
  );
}
