/**
 * generationPrevis — 回归测试：director node generation with canvas references。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { executeGeneration } from '../../src/services/generationService';
import { createDefaultPrevisScene } from '../../src/services/directorPrevisSchema';
import { writeImmutableProjectFile } from '../../src/services/fs/projectFiles';
import { cancelDirectorPrevisGeneration } from '../../src/services/directorPrevisService';

vi.mock('../../src/services/fs/projectFiles', async (original) => ({
  ...await original<typeof import('../../src/services/fs/projectFiles')>(),
  readVerifiedProjectFile: vi.fn(), writeImmutableProjectFile: vi.fn(),
}));

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZXkAAAAASUVORK5CYII=';
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(createDefaultPrevisScene()) } }] }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
const fetchMock = vi.fn();
const nodeData = () => useAppStore.getState().nodes.find((node) => node.id === 'director')!.data;
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetAllMocks();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState((state) => ({
    currentProjectId: 'project-a', projectLoadStatus: 'ready', showToast: vi.fn(), recordOutputHistory: vi.fn(),
    projects: [{ id: 'project-a', name: '电影', createdAt: 1, updatedAt: 1, settings: { defaultModels: { text: 'general/vision' } } }],
    config: { ...state.config, providers: { ...state.config.providers,
      'vision-provider': { name: '视觉测试连接', baseUrl: 'https://vision.example', apiKey: 'test-key' } },
    generalModels: [{ id: 'vision', name: '视觉模型', modelId: 'vision-text', category: 'text', providerConfigId: 'vision-provider' }] },
    nodes: [{ id: 'director', type: 'ai-director', position: { x: 0, y: 0 }, data: {
      type: 'ai-director', label: '导演台', directorRuntimeKind: 'ai-threejs', directorInstanceId: 'instance-a',
      prompt: '生成走廊跟拍预演', status: 'idle',
    } }],
  }));
  vi.mocked(writeImmutableProjectFile).mockImplementation(async ({ reference }) => ({ ...reference, created: true }));
  fetchMock.mockResolvedValue(response());
  vi.stubGlobal('fetch', fetchMock);
});

describe('director node generation with canvas references', () => {
  it('does not start a request in a project switched while loading the generation module', async () => {
    const pending = executeGeneration('director');
    useAppStore.setState({ currentProjectId: 'project-b' });
    expect((await pending).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeImmutableProjectFile).not.toHaveBeenCalled();
  });
  it('uses the project text model and saves a previs scene instead of ordinary text output', async () => {
    expect(await executeGeneration('director')).toEqual({ success: true });
    expect(nodeData().directorPrevisScene).toMatchObject({ kind: 'project-file' });
    expect(nodeData()).toMatchObject({ status: 'success', directorPrevisModel: 'general/vision',
      directorPrevisProvider: 'general', prompt: '生成走廊跟拍预演' });
    expect(nodeData().output).toBeUndefined();
    expect(writeImmutableProjectFile).toHaveBeenCalledOnce();
    expect(useAppStore.getState().recordOutputHistory).not.toHaveBeenCalled();
  });

  it('sends explicitly referenced images plus every shot row and optional field to the actual text protocol', async () => {
    const state = useAppStore.getState();
    state.updateNodeDataTransient('director', { prompt: '参考 @{image:空间图} 和 @{sheet:整张分镜表} 生成预演' });
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes,
      { id: 'image', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '空间图', imageUrl: png } },
      { id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 }, data: { type: 'ai-shotlist', label: '整张分镜表', shotlistRows: [
        { id: 'r1', shotNo: '1', shotSize: '全景', camera: '跟拍', content: '人物进入走廊', dialogue: '快走', duration: 3.5,
          audio: '脚步', transition: '叠化', note: '先露出入口', frame: { nodeId: 'image', kind: 'image', url: png } },
        { id: 'r2', shotNo: '2', shotSize: '中景', camera: '环绕', content: '人物回头', duration: 4.5, note: '最后到正面' },
      ] } },
    ], edges: [{ id: 'image-director', source: 'image', target: 'director' }, { id: 'sheet-director', source: 'sheet', target: 'director' }] });
    expect((await executeGeneration('director')).success).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const content = body.messages[0].content;
    const text = content.filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('');
    for (const field of ['人物进入走廊', '人物回头', '3.5″', '4.5″', '快走', '脚步', '叠化', '先露出入口', '最后到正面', '图片1']) expect(text).toContain(field);
    expect(content.filter((part: { type: string }) => part.type === 'image_url')).toEqual([{ type: 'image_url', image_url: { url: png } }]);
    expect(text).not.toContain('@{');
    expect(nodeData().directorPrevisScene).toBeDefined();
  });

  it('does not implicitly send merely connected images or shotlists', async () => {
    useAppStore.setState((state) => ({ nodes: [...state.nodes,
      { id: 'image', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '空间图', imageUrl: png } },
    ], edges: [{ id: 'image-director', source: 'image', target: 'director' }] }));
    expect((await executeGeneration('director')).success).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(typeof body.messages[0].content).toBe('string');
    expect(JSON.stringify(body)).not.toContain(png);
  });

  it('enforces the shared vision image limit before calling the model or writing a scene', async () => {
    useAppStore.setState((state) => ({ nodes: [...state.nodes,
      ...Array.from({ length: 7 }, (_, index) => ({ id: `image-${index}`, type: 'source-image' as const, position: { x: 0, y: 0 },
        data: { type: 'source-image' as const, label: `图${index}`, imageUrl: png } })),
    ] }));
    const prompt = Array.from({ length: 7 }, (_, index) => `@{image-${index}:图${index}}`).join(' ');
    expect((await executeGeneration('director', `${prompt} 生成跟拍`)).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeImmutableProjectFile).not.toHaveBeenCalled();
    expect(nodeData().status).toBe('error');
  });

  it('cancels the actual protocol request and leaves the node ready for a new generation', async () => {
    fetchMock.mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));
    const pending = executeGeneration('director');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(nodeData().status).toBe('loading');
    cancelDirectorPrevisGeneration('director');
    expect((await pending).success).toBe(false);
    expect(nodeData().status).toBe('idle');
    expect(nodeData().directorPrevisScene).toBeUndefined();
    expect(writeImmutableProjectFile).not.toHaveBeenCalled();
  });

  it.each(['blender', 'lightweight-web'] as const)('does not silently generate text for the %s runtime', async (runtime) => {
    useAppStore.getState().updateNodeDataTransient('director', { directorRuntimeKind: runtime, model: 'general/vision', provider: 'general' });
    expect((await executeGeneration('director')).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeImmutableProjectFile).not.toHaveBeenCalled();
    expect(nodeData().output).toBeUndefined();
  });
});
