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
import { STYLE_GUIDE_GROUPS, StyleGuideContent } from './StyleGuideSections';
import { applyAppearanceTheme, installSystemAppearanceListener, resolveAppearanceMode, resolveAppearanceTheme } from '../../services/appearance/appearanceRuntime';
import { getBuiltinAppearanceTheme, normalizeAppearanceTheme } from '../../services/appearance/appearanceDefaults';
import { getAppearanceForConfig } from '../../services/appearance/appearanceMigration';
import { createAppearanceUiSnapshot, listenForStyleGuideAppearance, requestStyleGuideAppearance } from '../../services/appearance/appearanceWindowSync';

type GuideTheme = 'dark' | 'light';
type GuidePreviewMode = 'follow' | GuideTheme;

/** 目录与内容共用同一份分类元数据，搜索不改变内容的挂载和排列。 */
const SECTION_IDS = STYLE_GUIDE_GROUPS.flatMap<string>(({ sections }) => sections.map(({ id }) => id));

const getSystemMode = () => resolveAppearanceMode('system');
const getServerMode = (): GuideTheme => 'dark';

export default function StyleGuideWindow() {
  const t = useT();
  const systemMode = useSyncExternalStore(installSystemAppearanceListener, getSystemMode, getServerMode);
  const [appearance, setAppearance] = useState<AppearanceUiSnapshot>(() => createAppearanceUiSnapshot(getBuiltinAppearanceTheme('standard-dark')));
  const [previewMode, setPreviewMode] = useState<GuidePreviewMode>('follow');
  const [activeId, setActiveId] = useState<string>(SECTION_IDS[0] ?? '');
  const [search, setSearch] = useState('');
  const mainRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const query = search.trim().toLocaleLowerCase();
  const filteredGroups = useMemo(() => STYLE_GUIDE_GROUPS.map((group) => {
    const groupMatches = `${group.title} ${group.description}`.toLocaleLowerCase().includes(query);
    return {
      ...group,
      sections: group.sections.filter((section) => groupMatches
        || `${section.title} ${section.id} ${section.keywords.join(' ')}`.toLocaleLowerCase().includes(query)),
    };
  }).filter((group) => group.sections.length > 0), [query]);
  const resultCount = filteredGroups.reduce((count, group) => count + group.sections.length, 0);
  const firstResultId = filteredGroups[0]?.sections[0]?.id;

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
    if (!container || !target || !container.contains(target)) return;
    const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 12;
    container.scrollTo({
      top: Math.max(0, top),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    setActiveId(id);
  }, []);

  // 使用实际可见位置跟随滚动；页面到底时也能选中高度不足一屏的最后一项。
  const handleScroll = useCallback(() => {
    const container = mainRef.current;
    if (!container) return;
    const maxScroll = container.scrollHeight - container.clientHeight;
    if (maxScroll > 0 && maxScroll - container.scrollTop <= 1) {
      setActiveId(SECTION_IDS[SECTION_IDS.length - 1] ?? '');
      return;
    }
    const threshold = container.getBoundingClientRect().top + 96;
    let current: string = SECTION_IDS[0] ?? '';
    for (const id of SECTION_IDS) {
      const target = document.getElementById(id);
      if (target && target.getBoundingClientRect().top <= threshold) current = id;
    }
    setActiveId(current);
  }, []);

  useEffect(() => {
    const container = navRef.current;
    const current = container?.querySelector<HTMLButtonElement>('[aria-current="location"]');
    if (!container || !current) return;
    const bounds = container.getBoundingClientRect();
    const item = current.getBoundingClientRect();
    if (item.top < bounds.top) container.scrollTop += item.top - bounds.top - 8;
    else if (item.bottom > bounds.bottom) container.scrollTop += item.bottom - bounds.bottom + 8;
  }, [activeId, filteredGroups]);

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
        className="flex min-h-11 shrink-0 items-center gap-2 px-3 py-1.5 select-none"
      >
        <h1 className="m-0 min-w-0 truncate text-sm font-semibold text-canvas-text sm:text-[15px]">样式预览 · UI Kit</h1>
        <span className="hidden text-[11px] text-canvas-text-muted lg:inline">
          公用控件与类名模板 · 点击代码块可复制
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
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
        <aside className="flex min-h-0 w-44 shrink-0 flex-col border-r border-canvas-border lg:w-52" aria-label={t('组件目录')}>
          <div className="shrink-0 border-b border-canvas-border p-2">
            <label htmlFor="sg-directory-search" className="sr-only">搜索组件目录</label>
            <div className="ui-input-group">
              <input
                ref={searchRef}
                id="sg-directory-search"
                className="ui-input"
                placeholder="搜索组件或类名…"
                value={search}
                aria-controls="sg-directory"
                aria-describedby="sg-directory-hint"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Escape' && search) {
                    event.preventDefault();
                    setSearch('');
                  } else if (event.key === 'Enter' && firstResultId) {
                    event.preventDefault();
                    scrollToSection(firstResultId);
                  }
                }}
              />
              {search ? <button
                type="button"
                className="ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm self-center"
                aria-label="清空目录搜索"
                onClick={() => { setSearch(''); searchRef.current?.focus(); }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button> : null}
            </div>
            <p className="m-0 mt-2 text-[11px] text-canvas-text-secondary" role="status" aria-live="polite">
              {query ? `${resultCount} / ${SECTION_IDS.length} 个分区` : `${STYLE_GUIDE_GROUPS.length} 类 · ${SECTION_IDS.length} 个分区`}
            </p>
            <p id="sg-directory-hint" className="m-0 mt-1 text-[10px] leading-relaxed text-canvas-text-muted">
              仅筛选目录，全部样例保持展示。Enter 跳转首项，Esc 清空。
            </p>
          </div>
          <nav ref={navRef} id="sg-directory" className="ui-scroll min-h-0 flex-1 p-2" aria-label={t('样式分区目录')}>
            {filteredGroups.length > 0 ? filteredGroups.map((group) => (
              <div key={group.id} className="mb-3 last:mb-0">
                <h2 className="m-0 mb-1 flex items-center justify-between gap-2 px-2 py-1 text-[11px] font-medium text-canvas-text-muted" title={group.description}>
                  <span>{group.title}</span>
                  <span className="tabular-nums">{group.sections.length}</span>
                </h2>
                {group.sections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => scrollToSection(section.id)}
                    aria-current={activeId === section.id ? 'location' : undefined}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-xs leading-relaxed transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand ${
                      activeId === section.id
                        ? 'bg-[var(--brand-alpha-15)] text-brand-light'
                        : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text'
                    }`}
                  >
                    {section.title}
                  </button>
                ))}
              </div>
            )) : (
              <div className="p-2">
                <p className="m-0 text-xs text-canvas-text-secondary">没有匹配的组件</p>
                <p className="m-0 mt-1 text-[11px] leading-relaxed text-canvas-text-muted">尝试组件名称、用途或类名。</p>
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm mt-2" onClick={() => { setSearch(''); searchRef.current?.focus(); }}>清空搜索</button>
              </div>
            )}
          </nav>
        </aside>

        {/* 内容区 */}
        <main ref={mainRef} onScroll={handleScroll} className="ui-scroll relative min-w-0 flex-1 p-3 lg:p-5">
          <div className="mx-auto min-w-0 max-w-[860px]">
            <StyleGuideContent theme={theme} />
          </div>
        </main>
      </div>
    </div>
  );
}
