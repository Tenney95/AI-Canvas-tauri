/** 普通生成文件转摘要副本；原生IO均为固定替身。 */
import { beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ invoke: vi.fn(), published: [] as Array<{ path: string; bytes: number; sha256: string }>, loseReply: false, failPublish: false }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async () => io.published.length > 0 }));
vi.mock('../../src/services/fileService', () => ({ getProjectDataDir: async () => 'C:/fixture',
  getRelativeAssetPath: (path: string, root: string) => path.startsWith(root + '/') ? path.slice(root.length + 1) : null }));
import { captureNativeMediaLocalResult, readNativeMediaLocalResult } from '../../src/services/nativeMediaLocalResult';
const hash = 'a'.repeat(64);
beforeEach(() => {
  io.published = []; io.loseReply = false; io.failPublish = false; io.invoke.mockReset();
  io.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'publish_project_import_assets') {
      if (io.failPublish) throw new Error('项目素材超出项目目录');
      const assets = args.assets as Array<{ destinationPath: string }>;
      io.published = [{ path: assets[0].destinationPath, bytes: 12, sha256: hash }];
      if (io.loseReply) throw new Error('response lost');
      return undefined;
    }
    if (command === 'inspect_project_archive_assets') return args.assetsDir === 'C:/fixture' && args.selectedPaths
      ? (args.selectedPaths as string[]).map((path) => ({ path, bytes: 12, sha256: hash })) : io.published;
    throw new Error(`unexpected ${command}`);
  });
});
it('Rust发布失败时不返回伪造的摘要产物，修复路径后只重试冻结同一原文件', async () => {
  io.failPublish = true;
  await expect(captureNativeMediaLocalResult('original-canvas', 'C:/fixture/原媒体产物_1.png')).rejects.toThrow('超出项目目录');
  expect(io.published).toEqual([]);
  io.failPublish = false;
  const result = await captureNativeMediaLocalResult('original-canvas', 'C:/fixture/原媒体产物_1.png');
  expect(result).toEqual({ relativePath: `imports/retained-${hash}/${hash}.png`, bytes: 12, sha256: hash });
  const attempts = io.invoke.mock.calls.filter(([command]) => command === 'publish_project_import_assets');
  expect(attempts).toHaveLength(2);
  expect(attempts[0][1]).toEqual(attempts[1][1]);
  expect(attempts[1][1]).toMatchObject({ operationId: `retained-${hash}`, assets: [expect.objectContaining({ path: '原媒体产物_1.png', bytes: 12, sha256: hash })] });
  await expect(readNativeMediaLocalResult('original-canvas', result)).resolves.toBeUndefined();
});
it('普通命名的已下载文件冻结为可重启摘要引用，丢失发布响应只核验复用', async () => {
  io.loseReply = true;
  const result = await captureNativeMediaLocalResult('original-canvas', 'C:/fixture/output-1.mp3');
  expect(result).toEqual({ relativePath: `imports/retained-${hash}/${hash}.mp3`, bytes: 12, sha256: hash });
  expect(await captureNativeMediaLocalResult('original-canvas', 'C:/fixture/output-1.mp3')).toEqual(result);
  expect(io.invoke.mock.calls.filter(([command]) => command === 'publish_project_import_assets')).toHaveLength(1);
  await expect(readNativeMediaLocalResult('original-canvas', result)).resolves.toBeUndefined();
});
it('已有摘要目录被替换时拒绝复用，源文件不被覆盖或删除', async () => {
  io.published = [{ path: `${hash}.mp3`, bytes: 12, sha256: 'b'.repeat(64) }];
  await expect(captureNativeMediaLocalResult('original-canvas', 'C:/fixture/output-1.mp3')).rejects.toThrow('未覆盖');
  expect(io.invoke.mock.calls.some(([command]) => command === 'publish_project_import_assets')).toBe(false);
});
it('同一字节通过不同扩展名下载时复用首个摘要副本，不覆盖目录', async () => {
  io.published = [{ path: `${hash}.mp3`, bytes: 12, sha256: hash }];
  expect(await captureNativeMediaLocalResult('original-canvas', 'C:/fixture/same-bytes.wav')).toEqual({
    relativePath: `imports/retained-${hash}/${hash}.mp3`, bytes: 12, sha256: hash });
  expect(io.invoke.mock.calls.some(([command]) => command === 'publish_project_import_assets')).toBe(false);
});
it('旧media摘要路径继续读取，项目外路径拒绝冻结', async () => {
  expect(await captureNativeMediaLocalResult('original-canvas', `C:/fixture/media/${hash}.mp3`)).toEqual({ relativePath: `media/${hash}.mp3`, bytes: 12, sha256: hash });
  await expect(captureNativeMediaLocalResult('original-canvas', 'C:/other/output.mp3')).rejects.toThrow('原项目');
});
it('已声明摘要的路径被改写时失败，不把替换内容当作普通下载重绑', async () => {
  await expect(captureNativeMediaLocalResult('original-canvas', `C:/fixture/media/${'b'.repeat(64)}.mp3`)).rejects.toThrow('替换内容');
  expect(io.invoke.mock.calls.some(([command]) => command === 'publish_project_import_assets')).toBe(false);
});
