/**
 * StyleGuideWindow — 独立「样式预览 / UI Kit」窗口
 *
 * 由「关于」弹窗里连点 4 次 logo 唤起，展示全应用公用控件的外观与类名，
 * 同时作为写新界面时的样式模板（配套样式见 src/styles/ui-kit.css）。
 *
 * 运行在独立 Tauri WebviewWindow 中，不依赖主窗口的 zustand store：
 * 独立窗口需自行应用 data-theme，见下方 useEffect。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfig } from '../../types';
import { loadConfigWithoutSecrets } from '../../services/fileService';
import { setLocale, useT } from '../../i18n';
import { StyleGuideContent } from './StyleGuideSections';

type GuideTheme = AppConfig['theme'];

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
  { id: 'sg-cards', title: '卡片' },
  { id: 'sg-badges', title: '徽标与表格' },
  { id: 'sg-feedback', title: '反馈与状态' },
  { id: 'sg-layout', title: '布局辅助' },
];

/** 主题切换只在当前窗口生效，不写回配置，避免影响主窗口 */
function resolveTheme(config: AppConfig | null): GuideTheme {
  if (!config) return 'dark';
  if (config.canvasBackground === 'off-white') return 'light';
  return config.theme === 'light' ? 'light' : 'dark';
}

export default function StyleGuideWindow() {
  const t = useT();
  const [theme, setTheme] = useState<GuideTheme>('dark');
  const [activeId, setActiveId] = useState(SECTIONS[0]?.id ?? '');
  const mainRef = useRef<HTMLElement>(null);

  // 独立窗口自行应用主题与语言（主窗口的 Store 在这里不可用）
  useEffect(() => {
    document.title = '样式预览 · UI Kit';
    let cancelled = false;
    (async () => {
      try {
        // 只读主题/语言这类非凭据字段，不触碰 Rust 凭据存储（同 main.tsx 的独立聊天窗口）
        const cfg = (await loadConfigWithoutSecrets()) as AppConfig | null;
        if (cancelled) return;
        const nextTheme = resolveTheme(cfg);
        setTheme(nextTheme);
        document.documentElement.setAttribute('data-theme', nextTheme);
        document.documentElement.toggleAttribute('data-native-cursor', cfg?.customCursor === false);
        setLocale(cfg?.language);
      } catch (error) {
        console.warn('[StyleGuideWindow] 读取配置失败，回退暗色主题:', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const applyTheme = useCallback((next: GuideTheme) => {
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
  }, []);

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
        <span className="text-[11px] text-canvas-text-muted">
          公用控件与类名模板 · 点击代码块可复制
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="ui-btn ui-btn--ghost ui-btn--sm"
            onClick={() => applyTheme(theme === 'dark' ? 'light' : 'dark')}
            data-tooltip={t('切换明暗主题，仅在本窗口生效')}
          >
            {theme === 'dark' ? '暗色' : '浅色'}
          </button>
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
            <StyleGuideContent />
          </div>
        </main>
      </div>
    </div>
  );
}
