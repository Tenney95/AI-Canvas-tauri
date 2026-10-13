import type { AppearanceTheme } from '../../types';
import { normalizeAppearanceTheme } from './appearanceDefaults';
import {
  deleteAppearanceThemeFromDb,
  getAllAppearanceThemes,
  saveAppearanceThemeToDb,
} from '../indexedDb/catalogRepository';

export const MAX_APPEARANCE_THEME_BYTES = 8 * 1024 * 1024;

export async function loadAppearanceThemes(): Promise<AppearanceTheme[]> {
  return getAllAppearanceThemes();
}
export async function saveAppearanceTheme(theme: AppearanceTheme): Promise<void> {
  await saveAppearanceThemeToDb(theme);
}

export async function deleteAppearanceTheme(id: string): Promise<void> {
  await deleteAppearanceThemeFromDb(id);
}

export function exportAppearanceTheme(theme: AppearanceTheme): Blob {
  return new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
}

export async function importAppearanceTheme(file: File): Promise<AppearanceTheme> {
  if (file.size > MAX_APPEARANCE_THEME_BYTES) throw new Error('主题文件不能超过 8MB');
  const raw = JSON.parse(await file.text()) as Partial<AppearanceTheme>;
  if (raw.schemaVersion !== 1 || !raw.ui || !raw.canvas || !raw.node || !raw.edge || !raw.handle || !raw.motion) {
    throw new Error('主题文件格式不受支持');
  }
  const now = Date.now();
  const normalized = normalizeAppearanceTheme(raw);
  return {
    ...normalized,
    id: `imported-${now.toString(36)}`,
    name: `${raw.name || '导入主题'}（导入）`,
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
}
