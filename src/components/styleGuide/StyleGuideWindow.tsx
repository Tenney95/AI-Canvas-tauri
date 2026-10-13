/**
 * StyleGuideWindow — 独立「样式预览 / UI Kit」窗口
 *
 * 由「关于」弹窗里连点 4 次 logo 唤起，展示全应用公用控件的外观与类名，
 * 同时作为写新界面时的样式模板（配套样式见 src/styles/ui-kit.css）。
 *
 * 运行在独立 Tauri WebviewWindow 中，不依赖主窗口的 zustand store：
 * 通过只读 UI 快照跟随主窗口外观，不接收完整配置或凭据。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AppConfig, AppearanceUiSnapshot } from '../../types';
import { loadConfigWithoutSecrets } from '../../services/fileService';
import { setLocale, useT } from '../../i18n';
import { StyleGuideContent } from './StyleGuideSections';
import { applyAppearanceTheme, installSystemAppearanceListener, resolveAppearanceMode, resolveAppearanceTheme } from '../../services/appearance/appearanceRuntime';
import { getBuiltinAppearanceTheme, normalizeAppearanceTheme } from '../../services/appearance/appearanceDefaults';
import { getAppearanceForConfig } from '../../services/appearance/appearanceMigration';
import { createAppearanceUiSnapshot, listenForStyleGuideAppearance, requestStyleGuideAppearance } from '../../services/appearance/appearanceWindowSync';

type GuideTheme = 'dark' | 'light';
type GuidePreviewMode = 'follow' | GuideTheme;

interface GuideSection {
  id: string;
  title: string;
}

/** 左侧目录；id 必须与 StyleGuideSections.tsx 里各 <Section> 的 id 一致 */
const SECTIONS: GuideSection[] = [
  { id: 'sg-colors', title: '颜色令牌' },
  { id: 'sg-typography', title: '排版' },
  { id: 'sg-buttons', title: '按钮' },
  { id: 'sg-chips', title: '分类胶囊' },
  { id: 'sg-inputs', title: '输入框' },
  { id: 'sg-selects', title: '下拉选择' },
  { id: 'sg-dropzones', title: '上传区' },
  { id: 'sg-selection', title: '选择控件' },
  { id: 'sg-tabs', title: 'Tabs · 滚动页签' },
  { id: 'sg-scrollbars', title: '覆盖式滚动条' },
  { id: 'sg-cards', title: '卡片' },
  { id: 'sg-badges', title: '徽标与表格' },
  { id: 'sg-feedback', title: '反馈与状态' },
  { id: 'sg-toast', title: '吐司提示' },
  { id: 'sg-dialogs', title: '弹窗' },
  { id: 'sg-generation-effects', title: '生成特效' },
  { id: 'sg-video-player', title: '视频播放器' },
  { id: 'sg-markdown-editor', title: 'Markdown 编辑器' },
  { id: 'sg-mascot', title: '吉祥物' },
  { id: 'sg-layout', title: '布局辅助' },
];

const getSystemMode = () => resolveAppearanceMode('system');
const getServerMode = (): GuideTheme => 'dark';

export default function StyleGuideWindow() {
  const t = useT();
  const systemMode = useSyncExternalStore(installSystemAppearanceListener, getSystemMode, getServerMode);
  const [appearance, setAppearance] = useState<AppearanceUiSnapshot>(() => createAppearanceUiSnapshot(getBuiltinAppearanceTheme('standard-dark')));
  const [previewMode, setPreviewMode] = useState<GuidePreviewMode>('follow');
  const [activeId, setActiveId] = useState(SECTIONS[0]?.id ?? '');
  const mainRef = useRef<HTMLElement>(null);

  // 持久化配置用于首次加载和 Web 回退；实时快照优先，避免慢读取覆盖最新草稿。
  useEffect(() => {
    document.title = '样式预览 · UI Kit';
    let disposed = false;
    let receivedLiveTheme = false;
    let readVersion = 0;
    let unlisten = () => {};
    const syncConfig = async () => {
      const version = ++readVersion;
      try {
        // 只读主题/语言这类非凭据字段，不触碰 Rust 凭据存储（同 main.tsx 的独立聊天窗口）
        const cfg = (await loadConfigWithoutSecrets()) as AppConfig | null;
        if (disposed || version !== readVersion) return;
        if (!receivedLiveTheme) setAppearance(createAppearanceUiSnapshot(getAppearanceForConfig(cfg)));
        document.documentElement.toggleAttribute('data-native-cursor', cfg?.customCursor === false);
        setLocale(cfg?.language);
      } catch {
        if (!disposed) console.warn('[StyleGuideWindow] 配置读取失败，已保留当前外观');
      }
    };
    void listenForStyleGuideAppearance((next) => {
      if (disposed) return;
      receivedLiveTheme = true;
      setAppearance(createAppearanceUiSnapshot(normalizeAppearanceTheme(next)));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => console.warn('[StyleGuideWindow] 实时外观同步不可用，将在聚焦时读取配置'));

    const syncOnFocus = () => {
      void syncConfig();
      void requestStyleGuideAppearance().catch(() => {});
    };
    void syncConfig();
    window.addEventListener('focus', syncOnFocus);
    return () => {
      disposed = true;
      unlisten();
      window.removeEventListener('focus', syncOnFocus);
    };
  }, []);

  const preview = useMemo(() => {
    const current = normalizeAppearanceTheme(appearance);
    // 系统偏好更新时重新解析完整预设；本窗口没有独立的持久化外观状态。
    const resolved = resolveAppearanceTheme(current);
    if (previewMode === 'follow') return { ...resolved, mode: current.mode === 'system' ? systemMode : current.mode };
    const base = getBuiltinAppearanceTheme(`standard-${previewMode}`);
    // 明暗预览只调整本窗口的基础层次，继续展示当前自定义主题色和状态色。
    return {
      ...base,
      ui: {
        ...base.ui,
        accent: resolved.ui.accent,
        accentStrong: resolved.ui.accentStrong,
        accentSoft: resolved.ui.accentSoft,
        focus: resolved.ui.focus,
        success: resolved.ui.success,
        warning: resolved.ui.warning,
        danger: resolved.ui.danger,
        info: resolved.ui.info,
        button: resolved.ui.button,
        surfaceImage: resolved.ui.surfaceImage,
      },
    };
  }, [appearance, previewMode, systemMode]);
  const theme: GuideTheme = preview.mode === 'system' ? systemMode : preview.mode;

  useEffect(() => applyAppearanceTheme(preview), [preview]);

  const scrollToSection = useCallback((id: string) => {
    const container = mainRef.current;
    const target = document.getElementById(id);
    if (!container || !target) return;
    container.scrollTo({ top: target.offsetTop - 12, behavior: 'smooth' });
    setActiveId(id);
  }, []);

  // 目录高亮跟随滚动位置：取最后一个已滚过视口上沿的分区
  const handleScroll = useCallback(() => {
    const container = mainRef.current;
    if (!container) return;
    const scrollTop = container.scrollTop;
    let current = SECTIONS[0]?.id ?? '';
    for (const section of SECTIONS) {
      const el = document.getElementById(section.id);
      if (el && el.offsetTop <= scrollTop + 96) current = section.id;
    }
    setActiveId(current);
  }, []);

  const minimizeWin = useCallback(() => {
    import('@tauri-apps/api/window').then((m) => m.getCurrentWindow().minimize()).catch(() => {});
  }, []);
  const closeWin = useCallback(() => {
    import('@tauri-apps/api/window').then((m) => m.getCurrentWindow().close()).catch(() => {});
  }, []);

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden rounded-[10px] border border-canvas-border bg-canvas-bg text-canvas-text">
      {/* 自绘标题栏（无系统边框窗口） */}
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-3 px-3 select-none"
      >
        <h1 className="m-0 text-[15px] font-semibold text-canvas-text">样式预览 · UI Kit</h1>
        <span className="hidden text-[11px] text-canvas-text-muted lg:inline">
          公用控件与类名模板 · 点击代码块可复制
        </span>

        <div className="ml-auto flex items-center gap-1">
          <div className="ui-segmented" role="group" aria-label={t('预览主题')}>
            {([
              { mode: 'follow', label: '跟随外观', hint: '实时同步外观设置的全部界面颜色' },
              { mode: 'dark', label: '暗色', hint: '暗色预览，仅在本窗口生效，保留自定义主题色' },
              { mode: 'light', label: '浅色', hint: '浅色预览，仅在本窗口生效，保留自定义主题色' },
            ] as const).map(({ mode, label, hint }) => (
              <button
                key={mode}
                type="button"
                className={`ui-segmented__item ${previewMode === mode ? 'is-active' : ''}`}
                onClick={() => setPreviewMode(mode)}
                aria-pressed={previewMode === mode}
                data-tooltip={t(hint)}
              >
                {t(label)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="ui-icon-btn"
            onClick={minimizeWin}
            aria-label={t('最小化')}
            data-tooltip={t('最小化')}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0" y="5" width="10" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="ui-icon-btn ui-icon-btn--danger"
            onClick={closeWin}
            aria-label={t('关闭')}
            data-tooltip={t('关闭')}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
              <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 目录 */}
        <nav
          className="ui-scroll w-44 shrink-0 border-r border-canvas-border p-2"
          aria-label={t('样式分区目录')}
        >
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => scrollToSection(section.id)}
              className={`w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                activeId === section.id
                  ? 'bg-brand/15 text-brand-light'
                  : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text'
              }`}
            >
              {section.title}
            </button>
          ))}
        </nav>

        {/* 内容区 */}
        <main ref={mainRef} onScroll={handleScroll} className="ui-scroll relative flex-1 px-6 py-5">
          <div className="mx-auto max-w-[860px]">
            <StyleGuideContent theme={theme} />
          </div>
        </main>
      </div>
    </div>
  );
}
