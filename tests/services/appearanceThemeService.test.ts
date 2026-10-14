import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAppearanceTheme } from '../../src/services/appearance/appearanceDefaults';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';

const driver = vi.hoisted(() => ({ desktop: true, read: vi.fn(), store: vi.fn(), validate: vi.fn() }));
vi.mock('../../src/services/indexedDb/catalogRepository', () => ({
  deleteAppearanceThemeFromDb: vi.fn(), getAllAppearanceThemes: vi.fn(), saveAppearanceThemeToDb: vi.fn(),
}));
vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: () => driver.desktop,
  bytePartsToBase64Async: async (parts: Uint8Array[]) => Buffer.concat(parts).toString('base64'),
}));
vi.mock('../../src/services/fs/themeAssets', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/themeAssets')>(),
  readThemeImage: driver.read,
  storeThemeImage: driver.store,
  validateThemeImage: driver.validate,
}));

import { exportAppearanceTheme, importAppearanceTheme, persistAppearanceImages } from '../../src/services/appearance/appearanceThemeService';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="white"/></svg>';
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const blob = new Blob([svg], { type: 'image/svg+xml' });
const themeFile = (content: unknown) => new File([JSON.stringify(content)], '外观.aicanvas-theme', { type: 'application/json' });
const makeTheme = (source: string) => normalizeAppearanceTheme({
  id: 'my-theme', mode: 'light', name: '机甲浅色', builtin: false,
  node: { backgroundImage: { kind: 'image', imageDataUrl: source, imageFit: 'fill' } },
  ui: { button: { radius: 9, primary: { backgroundImage: { kind: 'image', imageDataUrl: source, imageFit: 'contain' } } } },
});

describe('appearance theme image persistence and transfer', () => {
  let reference: string;
  beforeEach(async () => {
    reference = `theme-asset:${await sha256BytesHex(new TextEncoder().encode(svg))}.svg`;
    driver.desktop = true;
    driver.read.mockReset().mockResolvedValue(blob);
    driver.store.mockReset().mockResolvedValue(reference);
    driver.validate.mockReset().mockResolvedValue(undefined);
  });

  it('migrates shared embedded images once without modifying the old snapshot', async () => {
    const original = makeTheme(dataUrl);
    const migrated = await persistAppearanceImages(original);
    expect(driver.store).toHaveBeenCalledTimes(1);
    expect(migrated.node.backgroundImage?.imageDataUrl).toBe(reference);
    expect(migrated.ui.button.primary.backgroundImage?.imageDataUrl).toBe(reference);
    expect(JSON.stringify(migrated)).not.toContain('base64,');
    expect(original.node.backgroundImage?.imageDataUrl).toBe(dataUrl);
    await persistAppearanceImages(migrated);
    expect(driver.store).toHaveBeenCalledTimes(1);
  });

  it('keeps the original snapshot when writing an image fails', async () => {
    driver.store.mockRejectedValueOnce(new Error('目录不可写'));
    const original = makeTheme(dataUrl);
    await expect(persistAppearanceImages(original)).rejects.toThrow('目录不可写');
    expect(original.node.backgroundImage?.imageDataUrl).toBe(dataUrl);
  });

  it('exports each image once and restores all settings with local references', async () => {
    const original = makeTheme(reference);
    const exported = await exportAppearanceTheme(original);
    const document = JSON.parse(await exported.text());
    expect(document.version).toBe(2);
    expect(Object.keys(document.images)).toEqual([reference]);
    expect(driver.read).toHaveBeenCalledTimes(1);
    const imported = await importAppearanceTheme(new File([exported], '外观.aicanvas-theme'));
    expect(imported.node.backgroundImage).toEqual(original.node.backgroundImage);
    expect(imported.ui.button).toEqual(original.ui.button);
    expect(imported.id).not.toBe(original.id);
    expect(imported.builtin).toBe(false);
    expect(driver.store).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(imported)).not.toContain('base64,');
  });

  it('rejects missing or mismatched resources before writing any images', async () => {
    const document = JSON.parse(await (await exportAppearanceTheme(makeTheme(reference))).text());
    await expect(importAppearanceTheme(themeFile({ ...document, images: {} }))).rejects.toThrow('缺少背景图片');
    const wrongImage = `data:image/svg+xml;base64,${Buffer.from(svg.replace('white', 'black')).toString('base64')}`;
    await expect(importAppearanceTheme(themeFile({ ...document, images: { [reference]: wrongImage } }))).rejects.toThrow('摘要不匹配');
    expect(driver.store).not.toHaveBeenCalled();
  });

  it('imports legacy embedded presets and leaves Web demo migration unchanged', async () => {
    const original = makeTheme(dataUrl);
    const imported = await importAppearanceTheme(themeFile(original));
    expect(imported.node.backgroundImage?.imageDataUrl).toBe(reference);
    expect(imported.ui.button.radius).toBe(9);
    driver.desktop = false;
    expect(await persistAppearanceImages(original)).toBe(original);
  });

  it('rejects an oversized file before reading or writing its body', async () => {
    const text = vi.fn();
    await expect(importAppearanceTheme({ size: 64 * 1024 * 1024 + 1, text } as unknown as File)).rejects.toThrow('不能超过 64MB');
    expect(text).not.toHaveBeenCalled();
    expect(driver.store).not.toHaveBeenCalled();
  });
});
