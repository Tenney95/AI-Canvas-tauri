/**
 * comfyRefmodService — 回归测试：RefMod 服务器目录。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  comfyFetch: vi.fn(),
  state: {
    config: {
      comfyUIUrl: 'http://refmod-server:8188',
      comfyServers: [] as Array<{ id: string; name: string; url: string }>,
    },
  },
}));

vi.mock('../../src/services/comfyPolling', () => ({ comfyFetch: mocks.comfyFetch }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));

import { loadComfyRefmodCatalog, loadComfyRefmodCatalogDetails, resolveComfyRefmodServerIdentity } from '../../src/services/comfyRefmodService';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function originalSchema(names: unknown[] = ['(none)', 'people/Alice']): Record<string, unknown> {
  return {
    MiniMaxH3RefModsLoader: {
      input: {
        required: {
          mod_1: [names, {}],
          strength_1: ['FLOAT', { default: 1, min: 0, max: 1, step: 0.01 }],
          copies_1: ['INT', { default: 1, min: 1, max: 10 }],
        },
        optional: { components_1: [['All', 'Visual', 'Audio'], {}] },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.config.comfyUIUrl = 'http://refmod-server:8188';
  mocks.state.config.comfyServers = [];
  mocks.comfyFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/object_info/MiniMaxH3RefModsLoader')) return json(originalSchema());
    if (url.endsWith('/refmods/library')) return json([]);
    return json({}, 404);
  });
});

describe('RefMod 服务器目录', () => {
  it('支持显式 COMBO 目录且继续过滤越界文件名', async () => {
    mocks.comfyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info/MiniMaxH3RefModsLoader')) return json({
        MiniMaxH3RefModsLoader: { input: { required: {
          mod_1: ['COMBO', { options: ['(none)', 'people/Alice', 'people/Alice', '../private', 'https://other.test/model', 1] }],
          strength_1: ['FLOAT', { default: 1, min: 0, max: 1, step: 0.01 }],
        } } },
      });
      return json({}, 404);
    });
    const catalog = await loadComfyRefmodCatalog(undefined, { fresh: true, includeDetails: false });
    expect(catalog.entries.map((entry) => entry.fileName)).toEqual(['people/Alice']);
    expect(catalog.loaders[0].slots[0]).toMatchObject({ allowedNames: ['people/Alice'], emptyNames: ['(none)'] });
  });

  it('使用真实节点 combo 目录，只摘取白名单元数据', async () => {
    mocks.comfyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info/MiniMaxH3RefModsLoader')) return json(originalSchema());
      if (url.endsWith('/refmods/library')) return json([{
        name: 'people/Alice', kind: 'bundle', tokens: 1234, description: '角色参考包',
        path: 'C:/private/people/Alice.safetensors', config: '{"untrusted":true}',
      }]);
      return json({}, 404);
    });

    const catalog = await loadComfyRefmodCatalog(undefined, { fresh: true });

    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]).toMatchObject({ fileName: 'people/Alice', name: 'Alice', kind: 'bundle', tokens: 1234 });
    expect(catalog.loaders[0].slots[0]).toMatchObject({
      slot: 1, fileField: 'mod_1', strengthField: 'strength_1', strengthMin: 0, strengthMax: 1,
      allowedNames: ['people/Alice'], emptyNames: ['(none)'],
    });
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain('C:/private');
    expect(serialized).not.toContain('untrusted');
    expect(serialized).not.toContain('http://refmod-server');
    expect(mocks.comfyFetch.mock.calls.every(([, options]) => options.method === undefined && options.cache === 'no-store')).toBe(true);
  });

  it('核心校验不请求可选描述，展示详情可在目录可用后独立补齐', async () => {
    let finishDetails: ((response: Response) => void) | undefined;
    mocks.comfyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info/MiniMaxH3RefModsLoader')) return json(originalSchema());
      if (url.endsWith('/refmods/library')) return new Promise<Response>((resolve) => { finishDetails = resolve; });
      return json({}, 404);
    });
    const core = await loadComfyRefmodCatalog(undefined, { fresh: true, includeDetails: false });
    expect(core.entries[0].fileName).toBe('people/Alice');
    expect(mocks.comfyFetch.mock.calls).toHaveLength(3);
    expect(mocks.comfyFetch.mock.calls.some(([url]) => url.endsWith('/refmods/library'))).toBe(false);
    const details = loadComfyRefmodCatalogDetails(core, { fresh: true });
    await vi.waitFor(() => expect(finishDetails).toBeDefined());
    // 可选信息仍挂起时，另一条 fresh 执行校验也能取得核心目录。
    const execution = await loadComfyRefmodCatalog(undefined, { fresh: true, includeDetails: false });
    expect(execution.loaders[0].loaderType).toBe('minimax-h3');
    finishDetails!(json([{ name: 'people/Alice', description: '角色描述', tokens: 12 }]));
    expect((await details).entries[0]).toMatchObject({ description: '角色描述', tokens: 12 });
  });

  it('区分各插件格式，保留 Lab 扩展名，Francky 只暴露真实强度字段', async () => {
    mocks.comfyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info/MiniMaxH3RefModsLoader')) return json(originalSchema(['(none)', 'Alice']));
      if (url.endsWith('/object_info/H3RefModLabLoad')) return json({
        H3RefModLabLoad: { input: { required: { filename: [['Alice.safetensors'], {}] } } },
      });
      if (url.endsWith('/object_info/H3RefModLoader')) return json({
        H3RefModLoader: { input: { required: {
          mod: [['Alice'], {}],
          weight: ['FLOAT', { default: 1, min: 0, max: 10, step: 0.01 }],
          video_weight: ['FLOAT', { default: 1, min: 0, max: 10, step: 0.01 }],
          audio_weight: ['FLOAT', { default: 1, min: 0, max: 10, step: 0.01 }],
        } } },
      });
      if (url.endsWith('/refmods/library')) return json([]);
      return json({}, 404);
    });

    const catalog = await loadComfyRefmodCatalog(undefined, { fresh: true });

    expect(catalog.entries.map((entry) => [entry.loaderType, entry.fileName])).toEqual([
      ['minimax-h3', 'Alice'], ['refmods-lab', 'Alice.safetensors'], ['h3-refmods', 'Alice'],
    ]);
    expect(new Set(catalog.entries.map((entry) => entry.id)).size).toBe(3);
    expect(catalog.loaders[1].slots[0].strengthField).toBeUndefined();
    expect(catalog.loaders[2].slots[0].additionalStrengthFields).toEqual(['video_weight', 'audio_weight']);
    expect(catalog.loaders[2].slots[0].strengthMax).toBe(10);
  });

  it('过滤绝对路径、URL、目录穿越及非字符串，拒绝不具备真实范围的强度定义', async () => {
    mocks.comfyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info/MiniMaxH3RefModsLoader')) return json(originalSchema([
        '(none)', 'ok/name', 'C:\\private\\Alice', '//server/share', '../Alice', 'a/../Alice', 'https://example.test/Alice', 1,
      ]));
      if (url.endsWith('/object_info/H3RefModLoader')) return json({ H3RefModLoader: { input: { required: {
        mod: [['unsafe-loader'], {}], weight: ['FLOAT', {}],
      } } } });
      return json({}, 404);
    });

    const catalog = await loadComfyRefmodCatalog(undefined, { fresh: true });

    expect(catalog.entries.map((entry) => entry.fileName)).toEqual(['ok/name']);
    expect(catalog.loaders).toHaveLength(1);
    expect(catalog.warnings.some((warning) => warning.includes('节点定义不兼容'))).toBe(true);
  });

  it('已安装但空目录与未安装可区分，复杂 Fantastic Stack 只提示不猜测 JSON', async () => {
    mocks.comfyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info/MiniMaxH3RefModsLoader')) return json(originalSchema(['(none)']));
      if (url.endsWith('/object_info/MiniMaxH3RefModStack')) return json({
        MiniMaxH3RefModStack: { input: { required: { stack_state: ['STRING', { default: '{}' }] } } },
      });
      return json({}, 404);
    });

    const catalog = await loadComfyRefmodCatalog(undefined, { fresh: true });

    expect(catalog.loaders).toHaveLength(1);
    expect(catalog.entries).toEqual([]);
    expect(catalog.warnings.join('')).toContain('Fantastic RefMod Stack');
  });

  it('缓存按端点身份隔离且 fresh 重新读取；调用方不能修改缓存', async () => {
    mocks.state.config.comfyUIUrl = 'http://cache-refmod:8188';
    const first = await loadComfyRefmodCatalog(undefined, { fresh: true });
    const count = mocks.comfyFetch.mock.calls.length;
    first.entries.length = 0;

    expect((await loadComfyRefmodCatalog()).entries).toHaveLength(1);
    expect(mocks.comfyFetch).toHaveBeenCalledTimes(count);
    await loadComfyRefmodCatalog(undefined, { fresh: true });
    expect(mocks.comfyFetch.mock.calls.length).toBeGreaterThan(count);

    mocks.state.config.comfyUIUrl = 'http://other-refmod:8188';
    const changed = await loadComfyRefmodCatalog();
    expect(changed.endpointFingerprint).not.toBe(first.endpointFingerprint);
  });

  it('同地址末尾斜杠不改变身份，同 serverId 改地址或默认服务器切换会改变身份', async () => {
    mocks.state.config.comfyServers = [{ id: 'h3', name: 'H3', url: 'http://HOST:80/' }];
    const first = await resolveComfyRefmodServerIdentity('h3');
    mocks.state.config.comfyServers[0].url = 'http://host';
    expect((await resolveComfyRefmodServerIdentity('h3')).endpointFingerprint).toBe(first.endpointFingerprint);
    mocks.state.config.comfyServers[0].url = 'http://other-host';
    expect((await resolveComfyRefmodServerIdentity('h3')).endpointFingerprint).not.toBe(first.endpointFingerprint);
    mocks.state.config.comfyServers = [];
    await expect(resolveComfyRefmodServerIdentity('h3')).rejects.toThrow('不存在');
    expect(first).not.toHaveProperty('baseUrl');
  });

  it('所有读取失败不能伪装没有文件，元数据失败可保留文件名目录', async () => {
    mocks.comfyFetch.mockRejectedValue(new Error('connect http://private-host C:/private/file'));
    await expect(loadComfyRefmodCatalog(undefined, { fresh: true })).rejects.toThrow('无法读取 ComfyUI RefMod 目录');
    mocks.comfyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info/MiniMaxH3RefModsLoader')) return json(originalSchema());
      if (url.endsWith('/refmods/library')) return json({}, 503);
      return json({}, 404);
    });
    const catalog = await loadComfyRefmodCatalog(undefined, { fresh: true });
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.warnings.join('')).toContain('详细信息暂不可用');
    expect(JSON.stringify(catalog)).not.toContain('private-host');
  });

  it('单类读取失败保留失败标识，不能将这类旧缓存判断为文件缺失', async () => {
    mocks.comfyFetch.mockImplementation(async (url: string) => (
      json({}, url.endsWith('/object_info/MiniMaxH3RefModsLoader') ? 503 : 404)
    ));

    const catalog = await loadComfyRefmodCatalog(undefined, { fresh: true });

    expect(catalog.entries).toEqual([]);
    expect(catalog.failedLoaderTypes).toEqual(['minimax-h3']);
    expect(catalog.warnings).toHaveLength(1);
  });

  it('读取中途切换端点必须丢弃迟到目录', async () => {
    mocks.comfyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info/MiniMaxH3RefModsLoader')) {
        mocks.state.config.comfyUIUrl = 'http://changed-during-read:8188';
        return json(originalSchema());
      }
      return json({}, 404);
    });

    await expect(loadComfyRefmodCatalog(undefined, { fresh: true })).rejects.toThrow('服务器配置已变化');
  });

  it('可选元数据的取消或失败不能丢掉成功目录', async () => {
    mocks.comfyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info/MiniMaxH3RefModsLoader')) return json(originalSchema());
      if (url.endsWith('/refmods/library')) throw new DOMException('optional read timeout', 'AbortError');
      return json({}, 404);
    });

    const catalog = await loadComfyRefmodCatalog(undefined, { fresh: true });

    expect(catalog.entries).toHaveLength(1);
    expect(catalog.warnings.join('')).toContain('详细信息暂不可用');
    expect(catalog.failedLoaderTypes).toEqual([]);
  });

  it('取消读取即失败，不回退过期目录', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadComfyRefmodCatalog(undefined, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.comfyFetch).not.toHaveBeenCalled();
  });
});
