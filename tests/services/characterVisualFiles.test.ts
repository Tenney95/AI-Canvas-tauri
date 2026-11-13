import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({ present: false, bytes: new Uint8Array(24), previous: new Uint8Array(24), write: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async () => driver.present, mkdir: vi.fn(), remove: vi.fn(), writeFile: driver.write }));
vi.mock('../../src/i18n', () => ({ t: (text: string) => text }));
vi.mock('../../src/services/fileService', () => ({ downloadGeneratedImageToPath: vi.fn() }));
vi.mock('../../src/services/fs/core', () => ({ getAssetUrlFromPath: async (path: string) => `asset://localhost${path}`, joinPath: (...parts: string[]) => parts.join('/') }));
vi.mock('../../src/services/fs/imageSourceBlob', () => ({ readImageSourceBlob: async (url: string) =>
  new Blob([Uint8Array.from(url.startsWith('asset:') ? driver.previous : driver.bytes)]) }));
import { CharacterVisualResultConflictError, saveCharacterVisualResult } from '../../src/services/fs/characterVisualFiles';

beforeEach(() => {
  vi.clearAllMocks(); driver.present = false;
  driver.bytes = new Uint8Array(24); driver.bytes.set([0x89, 80, 78, 71, 13, 10, 26, 10]);
  driver.bytes.set([73, 72, 68, 82], 12); driver.bytes[19] = 1; driver.bytes[23] = 1;
  driver.previous = driver.bytes.slice();
  vi.stubGlobal('crypto', { randomUUID: () => 'c6fce9e9-dd80-4abf-83bd-cd3c941b7632' });
});
afterEach(() => vi.unstubAllGlobals());

describe('character candidate retry saving', () => {
  it('reuses the same bytes when a prior write completed before the receipt was saved', async () => {
    driver.present = true;
    await expect(saveCharacterVisualResult('data:image/png;base64,fixture', '/images', 'candidate'))
      .resolves.toEqual({ filePath: '/images/candidate.png', width: 1, height: 1 });
    expect(driver.write).not.toHaveBeenCalled();
  });
  it('keeps a different existing file intact so the caller can allocate another candidate ordinal', async () => {
    driver.present = true; driver.previous[23] = 2;
    await expect(saveCharacterVisualResult('data:image/png;base64,fixture', '/images', 'candidate')).rejects.toBeInstanceOf(CharacterVisualResultConflictError);
    expect(driver.write).not.toHaveBeenCalled();
  });
  it('uses exclusive creation for a new candidate', async () => {
    await saveCharacterVisualResult('data:image/png;base64,fixture', '/images', 'candidate');
    expect(driver.write).toHaveBeenCalledWith('/images/candidate.png', driver.bytes, { createNew: true });
  });
});
