/**
 * assetUsageService — 回归测试：asset usage identity matching。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetUsageTarget } from '../../src/types/assetUsage';
const io = vi.hoisted(() => ({ projects: vi.fn(), project: vi.fn(), globals: vi.fn(), details: vi.fn(), nativeCapture: vi.fn(), retired: vi.fn(), history: vi.fn(),
  nativeCatalog: [] as unknown[],
  state: { value: {} as Record<string, unknown> } }));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn(async () => '/data/secondary'),
}));
vi.mock('../../src/services/projectModelRouter', () => ({ listProjectCatalog: async () => [
  ...(await io.projects()).map((project: unknown) => ({ dataModel: 'legacy', project })), ...io.nativeCatalog,
] }));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', () => ({ readNativeProjectCapture: io.nativeCapture, listNativeRetiredCanvasIds: io.retired }));
vi.mock('../../src/services/fileService', () => ({ getBaseDir: async () => '/base', getProjectDataDir: async (id: string) => `/data/${id}`,
  joinPath: (...parts: string[]) => parts.join('/') }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => io.state.value } }));
vi.mock('../../src/services/indexedDbService', () => ({
  getAllProjects: io.projects, getProjectById: io.project, getAllGlobalCharacters: io.globals,
  getAllGlobalDramaAssets: async () => [], getHistoryEntriesPage: io.history,
  getProjectConversations: async () => [], getTrashConversations: async () => [], getConversationMessages: async () => ({ messages: [], total: 0 }),
  getProjectAgentTasks: async () => [], listVideoEditorProjectsByProject: async () => [], getAllWorkflows: async () => [], getAllPresets: async () => [], getAssetImageRecords: io.details,
}));
import { loadAssetUsage, matchesAssetUsage } from '../../src/services/assetUsageService';
const file: AssetUsageTarget = { kind: 'file', path: 'D:/media/a b.png', assetId: 'file-a', name: '图' };
beforeEach(() => {
  vi.clearAllMocks(); io.projects.mockResolvedValue([{ id: 'project', name: '项目' }]); io.globals.mockResolvedValue([]); io.details.mockResolvedValue([]);
  io.nativeCatalog = []; io.retired.mockResolvedValue([]); io.history.mockResolvedValue({ records: [], hasMore: false });
  io.state.value = { currentProjectId: 'project', projects: [{ id: 'project', name: '项目' }], projectName: '项目', nodes: [],
    dramaAssets: { characters: [], scenes: [], props: [] }, globalCharacters: [], globalScenes: [], globalProps: [], history: [], messages: [], workflows: [], userPresets: [] };
});
describe('asset usage identity matching', () => {
  it('matches encoded asset tokens and exact local identities without matching names or partial paths', () => {
    expect(matchesAssetUsage(`参考 @asset{${encodeURIComponent(file.path)}}`, file)).toBe(true);
    expect(matchesAssetUsage('参考 @asset{D%3A%2Fmedia%2Fother%2Fa%20b.png}', file)).toBe(false);
    expect(matchesAssetUsage('参考 @asset{%ZZ}', file)).toBe(false);
    expect(matchesAssetUsage({ imageAssetId: 'file-a' }, file)).toBe(true);
    expect(matchesAssetUsage({ imageRelativePath: 'a b.png' }, file, { root: 'D:/media' })).toBe(true);
    expect(matchesAssetUsage({ name: 'a b.png' }, file)).toBe(false);
  });
  it('resolves same-ID creative mentions by the real kind priority and project owner', () => {
    const character: AssetUsageTarget = { kind: 'creative', scope: 'project', ownerId: 'series', assetKind: 'character', assetId: 'same', name: '人物' };
    const scene: AssetUsageTarget = { ...character, assetKind: 'scene' };
    const context = { ownerId: 'series', projectKinds: new Map([['same', 'character' as const]]) };
    expect(matchesAssetUsage('@drama{same#all:同名}', character, context)).toBe(true);
    expect(matchesAssetUsage('@drama{same:同名}', scene, context)).toBe(false);
    expect(matchesAssetUsage('@drama{same:同名}', character, { ...context, ownerId: 'other' })).toBe(false);
    expect(matchesAssetUsage('@drama{global/same:同名}', character, context)).toBe(false);
  });
  it('follows only explicitly supplied source output IDs and resolved creative file IDs', () => {
    expect(matchesAssetUsage('@{source:图}', file, { nodeIds: new Set(['source']) })).toBe(true);
    expect(matchesAssetUsage('@{other:图}', file, { nodeIds: new Set(['source']) })).toBe(false);
    const card = { id: 'card', kind: 'character', primaryReferenceImageId: 'a', referenceImages: [
      { id: 'a', imageUrl: file.path }, { id: 'b', imageUrl: 'D:/other.png' }], voiceClips: [{ id: 'v1', audioUrl: file.path }, { id: 'v2', audioUrl: 'D:/other.wav' }] };
    const context = { globalAssets: new Map([['card', card]]) };
    expect(matchesAssetUsage('@drama{global/card#all:角色}', file, context)).toBe(true);
    expect(matchesAssetUsage('@drama{global/card#b:角色}', file, context)).toBe(false);
    expect(matchesAssetUsage('@drama{global/card#voice/v2:角色}', file, context)).toBe(false);
    const legacy = { id: 'legacy', imageUrl: 'D:/other.png', voiceClips: [{ id: 'v1', audioUrl: file.path, sourceNodeId: 'voice' }] };
    const legacyContext = { projectAssets: new Map([['legacy', legacy]]), nodes: new Map([['voice', { data: { audioUrl: 'D:/new.wav' } }]]) };
    expect(matchesAssetUsage('@drama{legacy:角色}', file, legacyContext)).toBe(false);
    expect(matchesAssetUsage('@drama{legacy#voice/v1:角色}', file, legacyContext)).toBe(true);
  });
  it('keeps saved and live source output maps separate, and aggregates multiple targets in one project read', async () => {
    const card = { id: 'card', kind: 'character', name: '角色', referenceImages: [{ id: 'ref', sourceNodeId: 'source' }] };
    io.project.mockResolvedValue({ id: 'project', name: '项目', nodes: [{ id: 'source', type: 'source-image', data: { filePath: file.path, label: '旧图' } }],
      dramaAssets: { characters: [card], scenes: [], props: [] } });
    io.state.value.nodes = [{ id: 'source', type: 'source-image', data: { filePath: 'D:/media/new.png', label: '新图' } },
      { id: 'consumer', type: 'ai-image', data: { prompt: '@{source:新图}', label: '使用新图' } }];
    io.state.value.dramaAssets = { characters: [card], scenes: [], props: [] };
    const report = await loadAssetUsage([file, { kind: 'file', path: 'D:/unrelated.png', name: '其他' }]);
    expect(io.project).toHaveBeenCalledTimes(1);
    expect(report.locations.find((location) => location.kind === 'creative')?.live).toBe(false);
    expect(report.locations.some((location) => location.nodeId === 'consumer')).toBe(false);
  });
  it('rejects an incomplete project read instead of reporting that deletion has no impact', async () => {
    io.project.mockResolvedValue(undefined);
    await expect(loadAssetUsage(file)).rejects.toThrow('读取不完整');
  });
  it('includes image information associations and live workflow or preset edits', async () => {
    io.project.mockResolvedValue({ id: 'project', name: '项目', nodes: [] });
    io.details.mockResolvedValue([{ id: 'details', assetId: 'owner', fileName: '主图', references: [{ relativePath: 'references/image.png' }] }]);
    io.state.value.workflows = [{ id: 'workflow', name: '草稿工作流', prompt: `@asset{${encodeURIComponent(file.path)}}` }];
    io.state.value.userPresets = [{ id: 'preset', name: '草稿预设', thumbnail: file.path }];
    const report = await loadAssetUsage([file, { kind: 'file', name: '参考图', path: '/base/references/image.png' }]);
    expect(report.locations.map((location) => location.kind)).toEqual(expect.arrayContaining(['image-details', 'workflow', 'preset']));
  });
  it('treats canvas undo history as snapshots rather than generation history records', async () => {
    io.project.mockResolvedValue({ id: 'project', name: '项目', nodes: [] });
    io.state.value.history = [{ nodes: [{ id: 'old', data: { filePath: file.path, label: '旧画布节点' } }], edges: [], groups: [] }];
    const report = await loadAssetUsage(file);
    expect(report.locations.find((location) => location.key === 'undo:0:old')).toMatchObject({ kind: 'history', live: true });
  });
  it('新项目从独立仓储读取画布和共享素材，不把画布 ID 当旧项目读取', async () => {
    const root = { id: 'native-root', name: '新项目', kind: 'standalone', createdAt: 1, updatedAt: 2, epoch: 1,
      dataFolder: 'folder', storageRootRef: 'root', storageBindings: [{ rootRef: 'root' }] };
    const canvas = { id: 'native-canvas', projectId: root.id, episodeId: null, storageRootRef: 'root',
      nodes: [{ id: 'n', data: { relativePath: 'media.png', label: '新画布图' } }], edges: [], groups: [] };
    io.nativeCatalog = [{ dataModel: 'native', project: root, episodes: [], episodeIds: [], canvasIds: [canvas.id] }];
    io.nativeCapture.mockResolvedValue({ changeRevision: 2, aggregate: { project: root, content: { projectId: root.id,
      dramaAssets: { characters: [], scenes: [], props: [] } }, episodes: [], episodeContents: [], canvases: [canvas], canvas } });
    io.project.mockResolvedValue({ id: 'project', name: '项目', nodes: [] });
    const report = await loadAssetUsage({ kind: 'file', path: '/data/native-canvas/media.png', name: '媒体' });
    expect(report.locations).toContainEqual(expect.objectContaining({ kind: 'node', projectId: canvas.id, nodeId: 'n' }));
    expect(io.project).not.toHaveBeenCalledWith(canvas.id);
    expect(io.project).not.toHaveBeenCalledWith(root.id);
  });
  it('新项目聚合读取失败或扫描期间发生变化时不生成可用于删除的报告', async () => {
    const root = { id: 'native-root', name: '新项目', kind: 'standalone', createdAt: 1, updatedAt: 2, epoch: 1,
      dataFolder: 'folder', storageRootRef: 'root', storageBindings: [{ rootRef: 'root' }] };
    io.nativeCatalog = [{ dataModel: 'native', project: root, episodes: [], episodeIds: [], canvasIds: ['native-canvas'] }];
    io.nativeCapture.mockResolvedValue(null);
    await expect(loadAssetUsage(file)).rejects.toThrow('读取不完整');
    const aggregate = { project: root, content: { projectId: root.id }, episodes: [], episodeContents: [],
      canvases: [{ id: 'native-canvas', projectId: root.id, episodeId: null, storageRootRef: 'root', nodes: [], edges: [], groups: [] }] };
    io.nativeCapture.mockResolvedValueOnce({ changeRevision: 1, aggregate }).mockResolvedValueOnce({ changeRevision: 2, aggregate });
    io.project.mockResolvedValue({ id: 'project', name: '项目', nodes: [] });
    await expect(loadAssetUsage(file)).rejects.toThrow('引用已变化');
  });
  it('已删除画布的历史仍参与引用扫描', async () => {
    const root = { id: 'native-root', name: '剧集', kind: 'series', createdAt: 1, updatedAt: 2, epoch: 1,
      dataFolder: 'folder', storageRootRef: 'root', storageBindings: [{ rootRef: 'root' }] };
    io.nativeCatalog = [{ dataModel: 'native', project: root, episodes: [], episodeIds: [], canvasIds: [] }];
    io.nativeCapture.mockResolvedValue({ changeRevision: 1, aggregate: { project: root, content: { projectId: root.id },
      episodes: [], episodeContents: [], canvases: [] } });
    io.retired.mockResolvedValue(['retired-canvas']);
    io.history.mockImplementation(async (id: string) => ({ records: id === 'retired-canvas' ? [{ id: 'old-history',
      nodeId: 'old-node', nodeLabel: '旧历史', filePath: file.path }] : [], hasMore: false }));
    io.project.mockResolvedValue({ id: 'project', name: '项目', nodes: [] });
    const report = await loadAssetUsage(file);
    expect(report.locations).toContainEqual(expect.objectContaining({ kind: 'history', key: 'history:old-history' }));
    io.history.mockImplementation(async (id: string) => ({ records: id === 'retired-canvas' ? [{ id: 'old-history',
      nodeId: 'old-node', nodeLabel: '旧历史', prompt: '@{removed-node:引用}' }] : [], hasMore: false }));
    await expect(loadAssetUsage(file)).rejects.toThrow('历史引用无法确认');
  });
});
