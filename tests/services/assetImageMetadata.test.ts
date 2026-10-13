import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetImageRecord, AssetImageSaveInput } from '../../src/types/assetImage';

const driver = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(), records: [] as AssetImageRecord[], indexes: new Map<string, string>(),
  chunk: Infinity, close: vi.fn(), copy: vi.fn(), put: vi.fn(), exists: vi.fn(), stat: vi.fn(),
}));
const info = (path: string) => {
  const bytes = driver.files.get(path); if (!bytes) throw new Error('not found');
  return { isFile: true, isSymlink: false, size: bytes.length, mtime: new Date(1) };
};
vi.mock('@tauri-apps/plugin-fs', () => ({
  lstat: (path: string) => info(path), stat: driver.stat, exists: driver.exists,
  open: async (path: string) => {
    const bytes = driver.files.get(path)!; let offset = 0;
    return { stat: async () => info(path), close: driver.close, read: async (buffer: Uint8Array) => {
      const count = Math.min(driver.chunk, buffer.length, bytes.length - offset);
      buffer.set(bytes.subarray(offset, offset + count)); offset += count; return count || null;
    } };
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../../src/services/fileService', () => ({ copyAssetImageReference: driver.copy }));
vi.mock('../../src/services/indexedDbService', () => ({
  savePresetFolderToDb: vi.fn().mockResolvedValue(undefined),
  loadPresetFoldersFromDb: vi.fn().mockResolvedValue([]),
  deletePresetFolderFromDb: vi.fn().mockResolvedValue(undefined),
  getAssetImageRecords: async () => driver.records,
  getAssetIndexById: async (id: string) => driver.indexes.has(id) ? { path: driver.indexes.get(id) } : null,
  putAssetImageRecord: driver.put,
  findImageHistoryByReferences: async () => ({ prompt: '原始生成提示词', params: { imageSize: '2K' } }),
  putGlobalCharacterOrder: vi.fn(),
}));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => true, getBaseDir: async () => '/managed',
  joinPath: (...parts: string[]) => parts.join('/'), CATEGORY_EXTENSIONS: { image: ['.png', '.jpg'] },
  getAssetUrlFromPath: async (path: string) => `asset:${path}`,
}));
vi.mock('../../src/services/fs/assetIndex', () => ({ identifyAsset: async () => ({ assetId: 'asset' }) }));

import { findSavedAssetImage, fingerprintAssetImage, resolveAssetImageReferences, saveAssetImageMetadata } from '../../src/services/fs/assetImageMetadata';
import { loadAssetImageDetails } from '../../src/services/assetImageDetails';

const image = { name: 'hero.png', path: '/original.png', category: 'image' as const, size: 4, assetId: 'asset' };
const record = (assetId: string, digest: string): AssetImageRecord => ({ id: `asset-image:${assetId}`, assetId, contentDigest: digest,
  fileName: 'hero.png', prompt: '保留的提示词', references: [], revision: 1, updatedAt: 1 });
async function input(): Promise<AssetImageSaveInput> {
  return { identity: { assetId: 'asset', ...await fingerprintAssetImage(image.path) }, record: null, prompt: '编辑后的提示词', references: [], newReferencePaths: [] };
}
beforeEach(() => {
  driver.files.clear(); driver.files.set(image.path, new Uint8Array([1, 2, 3, 4]));
  driver.files.set('/selected.png', new Uint8Array([5, 6, 7]));
  driver.records = []; driver.indexes.clear(); driver.chunk = Infinity; driver.close.mockReset();
  driver.stat.mockReset().mockImplementation((path: string) => info(path));
  driver.exists.mockReset().mockImplementation((path: string) => driver.files.has(path));
  driver.put.mockReset().mockResolvedValue(undefined);
  driver.copy.mockReset().mockImplementation(async (source: string, relative: string, root: string) => {
    driver.files.set(`${root}/${relative}`, driver.files.get(source)!.slice());
  });
});

describe('content-bound asset image information', () => {
  it('hashes all bytes independently of short reads, detecting changes with the same size and mtime', async () => {
    driver.files.set(image.path, new Uint8Array(300000).fill(7));
    const whole = await fingerprintAssetImage(image.path); driver.chunk = 4093;
    expect(await fingerprintAssetImage(image.path)).toEqual(whole);
    driver.files.get(image.path)![270000] = 8;
    expect((await fingerprintAssetImage(image.path)).digest).not.toBe(whole.digest);
    expect(driver.close).toHaveBeenCalledTimes(3);
  });

  it('closes the handle on cancellation and rejects a file changed while being read', async () => {
    const controller = new AbortController();
    driver.stat.mockImplementationOnce((path: string) => { controller.abort(); return info(path); });
    await expect(fingerprintAssetImage(image.path, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(driver.close).toHaveBeenCalledTimes(1);
    driver.stat.mockImplementationOnce((path: string) => ({ ...info(path), mtime: new Date(2) }));
    await expect(fingerprintAssetImage(image.path)).rejects.toThrow('变化');
    expect(driver.close).toHaveBeenCalledTimes(2);
  });

  it('recovers a unique renamed/moved file only when its original indexed location is missing', async () => {
    const identity = (await input()).identity;
    driver.records = [record('old', identity.digest)]; driver.indexes.set('old', '/old.png');
    expect((await findSavedAssetImage(identity)).record?.assetId).toBe('old');
    driver.files.set('/old.png', driver.files.get(image.path)!);
    expect((await findSavedAssetImage(identity)).record).toBeNull();
    driver.exists.mockRejectedValueOnce(new Error('permission denied'));
    await expect(findSavedAssetImage(identity)).rejects.toThrow('permission denied');
    expect(driver.records[0].prompt).toBe('保留的提示词');
  });

  it('retains deleted records, rejects same-name replacement and refuses ambiguous detached matches', async () => {
    const old = (await input()).identity;
    driver.records = [record('asset', old.digest)]; driver.indexes.set('asset', image.path);
    driver.files.delete(image.path);
    expect(driver.records).toHaveLength(1);
    driver.files.set(image.path, new Uint8Array([8, 2, 3, 4]));
    const replacement = (await input()).identity;
    expect(await findSavedAssetImage(replacement)).toEqual({ record: null, ambiguous: false, contentChanged: true });
    driver.records = [record('old-a', old.digest), record('old-b', old.digest)];
    driver.indexes.set('old-a', '/missing-a.png'); driver.indexes.set('old-b', '/missing-b.png');
    expect(await findSavedAssetImage(old)).toEqual({ record: null, ambiguous: true, contentChanged: false });
  });

  it('suppresses path-only generation history after a known replacement while retaining the original record', async () => {
    const old = (await input()).identity;
    driver.records = [record('asset', old.digest)];
    driver.files.set(image.path, new Uint8Array([8, 2, 3, 4]));
    const loaded = await loadAssetImageDetails(image);
    expect(loaded).toMatchObject({ record: null, history: null, contentChanged: true });
    expect(loaded.warning).toContain('旧提示词');
    expect(driver.records[0].contentDigest).toBe(old.digest);
  });

  it('copies and verifies references before saving only relative metadata, with a stable key for first-save conflicts', async () => {
    const draft = await input(); draft.newReferencePaths = ['/selected.png'];
    const saved = await saveAssetImageMetadata(image, draft);
    expect(saved.references).toHaveLength(1);
    expect(saved.references[0].relativePath).toMatch(/^asset-image-references\/.*\.png$/);
    expect(JSON.stringify(saved)).not.toContain('/selected.png');
    expect(JSON.stringify(saved)).not.toContain('/managed');
    expect(driver.put).toHaveBeenCalledWith(saved, 0, { signal: undefined, tagReplacement: undefined });
    const again = await saveAssetImageMetadata(image, { ...draft, newReferencePaths: [] });
    expect(again.id).toBe(saved.id);
    expect((await resolveAssetImageReferences(saved.references))[0].url).toContain('/managed/asset-image-references/');
    driver.files.set(`/managed/${saved.references[0].relativePath}`, new Uint8Array([0, 6, 7]));
    expect((await resolveAssetImageReferences(saved.references))[0].url).toBeNull();
    driver.files.delete(`/managed/${saved.references[0].relativePath}`);
    expect((await resolveAssetImageReferences(saved.references))[0].url).toBeNull();
  });

  it('does not commit when the original was replaced, copying was cancelled or a copied reference changed', async () => {
    const draft = await input(); draft.newReferencePaths = ['/selected.png'];
    driver.files.set(image.path, new Uint8Array([9, 2, 3, 4]));
    await expect(saveAssetImageMetadata(image, draft)).rejects.toThrow('原图内容已变化');
    expect(driver.copy).not.toHaveBeenCalled(); expect(driver.put).not.toHaveBeenCalled();
    driver.files.set(image.path, new Uint8Array([1, 2, 3, 4]));
    const controller = new AbortController();
    driver.copy.mockImplementationOnce(async () => { controller.abort(); });
    await expect(saveAssetImageMetadata(image, draft, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    driver.copy.mockImplementationOnce(async (_source: string, relative: string, root: string) => {
      driver.files.set(`${root}/${relative}`, new Uint8Array([0, 0, 0]));
    });
    await expect(saveAssetImageMetadata(image, draft)).rejects.toThrow('复制校验失败');
    expect(driver.put).not.toHaveBeenCalled();
  });

  it('removes only a reference association and leaves its managed file intact', async () => {
    const draft = await input(); draft.newReferencePaths = ['/selected.png'];
    const first = await saveAssetImageMetadata(image, draft);
    const copiedPath = `/managed/${first.references[0].relativePath}`;
    const updated = await saveAssetImageMetadata(image, { ...draft, record: first, references: [], newReferencePaths: [] });
    expect(updated.references).toEqual([]); expect(driver.files.has(copiedPath)).toBe(true);
    expect(driver.put).toHaveBeenLastCalledWith(updated, 1, { signal: undefined, tagReplacement: undefined });
  });
});
