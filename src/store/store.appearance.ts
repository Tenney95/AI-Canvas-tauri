import type { StateCreator } from 'zustand';
import type { AppConfig, AppearanceTheme } from '../types';
import type { AppState } from './useAppStore';
import { cloneAppearanceTheme, createBuiltinAppearanceThemes, getBuiltinAppearanceTheme, normalizeAppearanceTheme } from '../services/appearance/appearanceDefaults';
import { migrateLegacyAppearance } from '../services/appearance/appearanceMigration';
import { deleteAppearanceTheme, loadAppearanceThemes, persistAppearanceImages, saveAppearanceTheme } from '../services/appearance/appearanceThemeService';
import { applyAppearanceTheme } from '../services/appearance/appearanceRuntime';

function withLegacyConfig(theme: AppearanceTheme): Partial<AppConfig> {
  const canvasBackground = theme.canvas.kind === 'image'
    ? 'custom'
    : theme.canvas.kind === 'color'
      ? theme.mode === 'light' ? 'off-white' : 'default'
      : theme.canvas.kind;
  return {
    appearance: theme,
    theme: theme.mode,
    canvasBackground,
    customBackgroundUrl: theme.canvas.kind === 'image' ? theme.canvas.imageDataUrl : undefined,
    customBackgroundOpacity: theme.canvas.kind === 'image' ? theme.canvas.imageOpacity : undefined,
    offWhiteBackgroundColor: theme.canvas.kind === 'color' && theme.mode === 'light' ? theme.canvas.color : undefined,
  } as Partial<AppConfig>;
}
export interface AppearanceSlice {
  appearanceThemes: AppearanceTheme[];
  appearancePreview: AppearanceTheme | null;
  appearanceHydrated: boolean;
  loadAppearanceThemes: () => Promise<void>;
  previewAppearanceTheme: (theme: AppearanceTheme) => void;
  clearAppearancePreview: () => void;
  activateAppearanceTheme: (theme: AppearanceTheme) => Promise<void>;
  saveAppearanceTheme: (theme: AppearanceTheme) => Promise<void>;
  duplicateAppearanceTheme: (theme: AppearanceTheme, name?: string) => Promise<AppearanceTheme>;
  renameAppearanceTheme: (id: string, name: string) => Promise<void>;
  deleteAppearanceTheme: (id: string) => Promise<void>;
}

export const createAppearanceSlice: StateCreator<AppState, [], [], AppearanceSlice> = (set, get) => ({
  appearanceThemes: createBuiltinAppearanceThemes(),
  appearancePreview: null,
  appearanceHydrated: false,

  loadAppearanceThemes: async () => {
    const stored = await loadAppearanceThemes();
    const themes = [...createBuiltinAppearanceThemes(), ...stored.filter((theme) => !theme.builtin).map(normalizeAppearanceTheme)];
    let migrationFailed = false;
    for (let index = 0; index < themes.length; index += 1) {
      const theme = themes[index];
      try {
        const next = await persistAppearanceImages(theme);
        if (next !== theme && !theme.builtin) await saveAppearanceTheme(next);
        themes[index] = next;
      } catch {
        migrationFailed = true;
      }
    }
    set({ appearanceThemes: themes, appearanceHydrated: true });
    // 配置读取后再迁移当前外观；迁移期间的新编辑不能被旧快照覆盖。
    const source = get().config.appearance;
    const active = normalizeAppearanceTheme(source ?? migrateLegacyAppearance(get().config));
    try {
      const migrated = await persistAppearanceImages(active);
      if (get().config.appearance === source && !get().appearancePreview && (migrated !== active || !source)) {
        await get().activateAppearanceTheme(migrated);
      }
    } catch {
      migrationFailed = true;
    }
    if (migrationFailed) get().showToast('部分外观图片未能迁移到安装目录的 theme 文件夹，原配置已保留；请检查目录权限后重新加载', 'error');
  },

  previewAppearanceTheme: (theme) => {
    const next = normalizeAppearanceTheme(theme);
    set({ appearancePreview: next });
    applyAppearanceTheme(next);
  },

  clearAppearancePreview: () => set({ appearancePreview: null }),

  activateAppearanceTheme: async (theme) => {
    const next = await persistAppearanceImages(normalizeAppearanceTheme(theme));
    get().updateConfig(withLegacyConfig(next));
    set({ appearancePreview: null });
    await get().saveConfig({ silent: true });
  },

  saveAppearanceTheme: async (theme) => {
    // 先持久化预设，再发布到列表；写入失败不得留下看似已保存的预设。
    const next = await saveAppearanceTheme({ ...normalizeAppearanceTheme(theme), builtin: false, updatedAt: Date.now() });
    set({ appearanceThemes: get().appearanceThemes.some((item) => item.id === next.id)
      ? get().appearanceThemes.map((item) => item.id === next.id ? next : item)
      : [...get().appearanceThemes, next] });
    await get().activateAppearanceTheme(next);
  },

  duplicateAppearanceTheme: async (theme, name) => {
    const id = `theme-${crypto.randomUUID()}`;
    const next = await persistAppearanceImages(cloneAppearanceTheme(theme, id, name?.trim() || `${theme.name}（自定义）`));
    await get().saveAppearanceTheme(next);
    return next;
  },

  renameAppearanceTheme: async (id, name) => {
    const item = get().appearanceThemes.find((theme) => theme.id === id);
    const trimmed = name.trim();
    if (!item || item.builtin || !trimmed || trimmed === item.name) return;
    const next = await saveAppearanceTheme({ ...item, name: trimmed, updatedAt: Date.now(), builtin: false });
    set({ appearanceThemes: get().appearanceThemes.map((theme) => theme.id === id ? next : theme) });
    const current = get().config.appearance;
    if (current?.id === id) await get().activateAppearanceTheme({ ...current, name: trimmed });
  },

  deleteAppearanceTheme: async (id) => {
    const item = get().appearanceThemes.find((theme) => theme.id === id);
    if (!item || item.builtin) return;
    await deleteAppearanceTheme(id);
    const fallback = getBuiltinAppearanceTheme('standard-dark');
    set({ appearanceThemes: get().appearanceThemes.filter((theme) => theme.id !== id) });
    if (get().config.appearance?.id === id) await get().activateAppearanceTheme(fallback);
  },
});
