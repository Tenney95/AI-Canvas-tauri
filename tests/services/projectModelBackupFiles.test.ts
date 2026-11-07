/** 固定恢复目录端口：覆盖链接、路径、覆盖保护和读取预算，不访问真实用户文件。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directories: new Set<string>(), links: new Set<string>(), files: new Map<string, Uint8Array>() }));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: async () => '/app-data' }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => true, joinPath: (...parts: string[]) => parts.join('/') }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (path: string) => state.directories.has(path) || state.files.has(path) || state.links.has(path),
  mkdir: async (path: string) => { if (state.directories.has(path) || state.files.has(path) || state.links.has(path)) throw new Error('exists'); state.directories.add(path); },
  lstat: async (path: string) => {
    if (!state.directories.has(path) && !state.files.has(path) && !state.links.has(path)) throw new Error('missing');
    return { isDirectory: state.directories.has(path), isFile: state.files.has(path), isSymlink: state.links.has(path), size: state.files.get(path)?.byteLength ?? 0 };
  },
  writeFile: async (path: string, bytes: Uint8Array, options: { createNew: boolean }) => {
    if (!options.createNew || state.files.has(path)) throw new Error('overwrite'); state.files.set(path, Uint8Array.from(bytes));
  },
  open: async (path: string) => {
    const bytes = state.files.get(path); if (!bytes) throw new Error('missing'); let offset = 0;
    return { stat: async () => ({ isFile: true, size: bytes.byteLength }), close: async () => undefined,
      read: async (target: Uint8Array) => { const count = Math.min(bytes.byteLength - offset, target.byteLength);
        if (count === 0) return 0; target.set(bytes.subarray(offset, offset + count)); offset += count; return count; } };
  },
}));

import { createProjectModelBackupPort, openProjectModelBackupPort } from '../../src/services/fs/projectModelBackupFiles';

beforeEach(() => { state.directories.clear(); state.files.clear(); state.links.clear(); state.directories.add('/app-data'); });

describe('本地项目备份文件边界', () => {
  it('使用独立恢复区，材料独占写入，读取已有备份不允许写入', async () => {
    const port = await createProjectModelBackupPort('op-one'); const bytes = new Uint8Array([1, 2, 3]);
    await port.writeExclusive('stores/projects/000000.json', bytes);
    expect(state.files.has('/app-data/project-model-backups/op-one/stores/projects/000000.json')).toBe(true);
    expect(await port.read('stores/projects/000000.json', 3)).toEqual(bytes);
    await expect(port.writeExclusive('stores/projects/000000.json', bytes)).rejects.toThrow();
    await expect(createProjectModelBackupPort('op-one')).rejects.toThrow();
    const readOnly = await openProjectModelBackupPort('op-one');
    await expect(readOnly.publishComplete('complete.json', bytes)).rejects.toThrow('只读');
  });
  it('读取前限制大小，拒绝路径穿越和非固定完成标记', async () => {
    const port = await createProjectModelBackupPort('safe-op');
    await port.writeExclusive('manifest.json', new Uint8Array([1, 2, 3]));
    await expect(port.read('manifest.json', 2)).rejects.toThrow('大小');
    await expect(port.writeExclusive('../outside.json', new Uint8Array())).rejects.toThrow('路径');
    await expect(port.publishComplete('other.json', new Uint8Array())).rejects.toThrow('路径');
    await expect(createProjectModelBackupPort('../outside')).rejects.toThrow('身份');
  });
  it('备份父目录/条目为链接时失败，不将其当普通文件读取', async () => {
    state.links.add('/app-data/project-model-backups');
    await expect(createProjectModelBackupPort('linked-root')).rejects.toThrow('普通目录');
    state.links.clear(); const port = await createProjectModelBackupPort('linked-file');
    state.links.add('/app-data/project-model-backups/linked-file/manifest.json');
    await expect(port.read('manifest.json', 1024)).rejects.toThrow('类型');
  });
});
