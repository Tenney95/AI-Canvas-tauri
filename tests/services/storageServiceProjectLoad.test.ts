/**
 * storageServiceProjectLoad — 回归测试：project loading tolerates asset recovery failures。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(async (_path: string) => true),
  getProjectDataDir: vi.fn(async (_projectId: string): Promise<string | null> => '/project/data'),
  identifyAsset: vi.fn(),
  resolveIndexedAssetPath: vi.fn(async (_assetId: string): Promise<string | null> => null),
  scanDirectoryFiles: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
  readDir: vi.fn(),
  notifyProjectDiskChanged: vi.fn(),
  resolveUniqueDestPath: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mocks.exists, mkdir: mocks.mkdir, writeFile: mocks.writeFile, stat: mocks.stat, readDir: mocks.readDir,
}));
vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: () => true,
  getConvertFileSrc: async () => (path: string) => `asset://${path}`,
  getFileCategory: () => 'image',
  CATEGORY_EXTENSIONS: { image: ['.png'] },
  buildNodeFileName: (label: string | undefined, ext: string, fallback: string) => `${label || fallback}${ext}`,
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`),
  getProjectDataDir: mocks.getProjectDataDir,
  joinPath: (...parts: string[]) => parts.join('/'),
  notifyProjectDiskChanged: mocks.notifyProjectDiskChanged,
  resolveUniqueDestPath: mocks.resolveUniqueDestPath,
  stripVerbatimPrefix: (path: string) => path,
}));
vi.mock('../../src/services/fs/assetLibrary', () => ({
  scanDirectoryFiles: mocks.scanDirectoryFiles,
}));
vi.mock('../../src/services/fs/assetIndex', () => ({
  identifyAsset: mocks.identifyAsset,
  resolveIndexedAssetPath: mocks.resolveIndexedAssetPath,
}));

import {
  getLastActiveProjectId,
  getAssetIndexById,
  getAssetIndexByPath,
  getProjectById,
  putAssetIndex,
  saveProjectToDb,
  setLastActiveProjectId,
} from '../../src/services/indexedDbService';
import { loadProjectData, saveProject, type ProjectSaveData } from '../../src/services/storageService';
import { normalizeDramaAssetLibrary, normalizeDramaVisualAsset, syncDramaVisualAssetPrimary, type DramaScene } from '../../src/types/dramaAssets';
import { captureExchangeSnapshot, materializeExchangeSnapshot } from '../../src/services/projectExchangeDomain';
import { resolveDramaAssetImageRef } from '../../src/services/dramaAssetPrompt';
import type { ProjectExchangeIdentity, ProjectExchangeState } from '../../src/types/projectExchange';
import type { AssetDirectoryScanResult } from '../../src/services/fs/assetLibrary';

function scanResult(overrides: Partial<AssetDirectoryScanResult> = {}): AssetDirectoryScanResult {
  return { files: [], folders: [], truncated: false, complete: true, failedDirectories: 0, failedFiles: 0, ...overrides };
}

describe('project loading tolerates asset recovery failures', () => {
  beforeEach(() => {
    mocks.exists.mockResolvedValue(true);
    mocks.getProjectDataDir.mockResolvedValue('/project/data');
    mocks.identifyAsset.mockRejectedValue(new Error('asset index unavailable'));
    mocks.resolveIndexedAssetPath.mockReset().mockResolvedValue(null);
    mocks.scanDirectoryFiles.mockReset().mockRejectedValue(new Error('directory scan unavailable'));
    mocks.resolveUniqueDestPath.mockImplementation(async (dir: string, name: string) => `${dir}/${name}`);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.stat.mockReset();
    mocks.readDir.mockReset();
  });

  it('全局来源标记经重复归一化及 JSON 往返保留，明确改绑项目后不复活旧来源', () => {
    const legacy: DramaScene = { id: 'scene-source', kind: 'scene', name: '全局复用', key: 'scene', summary: '', visualNotes: '',
      importance: 'main', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 2,
      imageAssetId: 'global-source-image', imageRelativePath: 'global.png' };
    const normalized = normalizeDramaVisualAsset(legacy);
    const roundTrip = normalizeDramaVisualAsset(JSON.parse(JSON.stringify(normalizeDramaVisualAsset(normalized))) as DramaScene);
    expect(roundTrip.referenceImages?.[0]).toMatchObject({ assetId: 'global-source-image', assetSource: 'global', relativePath: 'global.png' });
    expect(syncDramaVisualAssetPrimary(roundTrip)).toMatchObject({ imageAssetId: 'global-source-image', imageRelativePath: 'global.png' });

    const reference = { ...roundTrip.referenceImages![0], assetSource: undefined,
      relativePath: 'project.png', sourceNodeId: 'project-image-node' };
    const rebound = syncDramaVisualAssetPrimary({ ...roundTrip, referenceImages: [reference] });
    expect(rebound).toMatchObject({ assetId: 'global-source-image', relativePath: 'project.png', imageNodeId: 'project-image-node' });
    expect(rebound.imageAssetId).toBeUndefined();
    expect(normalizeDramaVisualAsset(rebound).referenceImages?.[0].assetSource).toBeUndefined();
    const local = normalizeDramaVisualAsset({ ...legacy, imageAssetId: undefined, imageRelativePath: undefined,
      assetId: 'local-only', relativePath: 'local.png' });
    expect(local.referenceImages?.[0]).not.toHaveProperty('assetSource');
  });

  it.each(['missing', 'offline', 'wrong-scope'] as const)('已标全局的多图引用在索引 %s 时不借用项目同名文件或旧 URL', async (state) => {
    const projectId = `global-reference-${state}-${Date.now()}`;
    const assetId = `global-reference-${state}`;
    const relativePath = `${state}/same.png`;
    // assetIndex.path 为唯一索引；参数化用例保留各自记录，不抢占上一例的路径。
    if (state !== 'missing') await putAssetIndex({ assetId, path: `/project/data/${relativePath}`, relativePath,
      rootPath: state === 'wrong-scope' ? '/project/data' : '/global', source: state === 'wrong-scope' ? 'project' : 'global',
      projectId: state === 'wrong-scope' ? projectId : undefined, fingerprint: '1:1', size: 1, mtimeMs: 1,
      status: state === 'offline' ? 'offline' : 'online', updatedAt: 1 });
    await saveProjectToDb({ id: projectId, name: '索引边界', createdAt: 1, updatedAt: 2, nodes: [], edges: [],
      dramaAssets: { version: 2, characters: [], props: [], scenes: [{ id: 'scene', kind: 'scene', name: '场景', key: 'scene',
        summary: '', visualNotes: '', importance: 'main', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 2,
        referenceImages: [{ id: 'global-ref', label: '', prompt: '', assetId, assetSource: 'global', relativePath,
          imageUrl: 'asset:///old/same.png', createdAt: 1, updatedAt: 2 }], primaryReferenceImageId: 'global-ref' }],
      } } as Parameters<typeof saveProjectToDb>[0]);
    const loaded = await loadProjectData(projectId);
    expect(loaded?.dramaAssets?.scenes[0].referenceImages?.[0]).toMatchObject({ assetId, assetSource: 'global', imageUrl: undefined });
    expect(loaded?.dramaAssets?.scenes[0]).toMatchObject({ imageAssetId: assetId, imageUrl: undefined });
    expect(mocks.identifyAsset).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('项目场景道具保留全局主图身份，重开按全局索引恢复且不复制到项目目录', async () => {
    const projectId = `project-global-library-${Date.now()}`;
    await putAssetIndex({ assetId: 'global-scene-shared', path: '/global/new-scene.png', relativePath: 'new-scene.png',
      rootPath: '/global', source: 'global', fingerprint: '1:1', size: 1, mtimeMs: 1, status: 'online', updatedAt: 1 });
    const scene = { id: 'scene', kind: 'scene' as const, name: '客厅', key: 'scene', summary: '', visualNotes: '',
      importance: 'main' as const, confirmed: true, source: 'manual' as const, createdAt: 1, updatedAt: 2,
      imageAssetId: 'global-scene-shared', imageRelativePath: 'old-scene.png', imageUrl: 'asset:///global/old-scene.png' };
    mocks.identifyAsset.mockClear(); mocks.writeFile.mockClear();
    await saveProject({ id: projectId, name: '全局复用', createdAt: 1, updatedAt: 2, nodes: [], edges: [],
      dramaAssets: { version: 2, characters: [], scenes: [scene], props: [{ ...scene, id: 'prop', kind: 'prop' }] } });
    const persisted = await getProjectById(projectId) as ProjectSaveData | null;
    expect(persisted?.dramaAssets?.scenes[0]).toMatchObject({ imageAssetId: 'global-scene-shared', imageRelativePath: 'new-scene.png' });
    const loaded = await loadProjectData(projectId);
    expect(loaded?.dramaAssets?.scenes[0].imageUrl).toBe('asset:///global/new-scene.png');
    expect(loaded?.dramaAssets?.props[0].imageUrl).toBe('asset:///global/new-scene.png');
    expect(mocks.identifyAsset).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('全局主图缺失时保留精确身份并清空旧图，不回落到项目同名图片', async () => {
    const projectId = `project-global-missing-${Date.now()}`;
    await saveProjectToDb({ id: projectId, name: '缺图', createdAt: 1, updatedAt: 2, nodes: [], edges: [],
      dramaAssets: { version: 2, characters: [], props: [], scenes: [{
        id: 'scene', kind: 'scene', name: '客厅', key: 'scene', summary: '', visualNotes: '', importance: 'main',
        confirmed: true, source: 'manual', createdAt: 1, updatedAt: 2, imageAssetId: 'global-image-no-index',
        imageRelativePath: 'scene.png', imageUrl: 'asset:///old/scene.png',
      }] } } as Parameters<typeof saveProjectToDb>[0]);
    const loaded = await loadProjectData(projectId);
    expect(loaded?.dramaAssets?.scenes[0]).toMatchObject({ imageAssetId: 'global-image-no-index', imageUrl: undefined });
    expect(mocks.identifyAsset).not.toHaveBeenCalled();
  });

  it('returns the persisted canvas when scanning and indexing an asset fail', async () => {
    const projectId = `project-load-${Date.now()}`;
    await saveProjectToDb({
      id: projectId,
      name: 'Recoverable project',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{
        id: 'image-node',
        type: 'ai-image',
        position: { x: 10, y: 20 },
        data: {
          type: 'ai-image',
          label: 'Saved image',
          assetId: 'asset-saved',
          relativePath: 'saved.png',
          imageUrl: 'asset://stale',
        },
      }],
      edges: [],
    });

    const loaded = await loadProjectData(projectId);

    expect(loaded).not.toBeNull();
    expect(loaded?.nodes).toEqual([expect.objectContaining({
      id: 'image-node',
      position: { x: 10, y: 20 },
      data: expect.objectContaining({
        assetId: 'asset-saved',
        filePath: '/project/data/saved.png',
        imageUrl: 'asset:///project/data/saved.png',
      }),
    })]);
  });

  it('rebuilds character reference and voice URLs from the shared local files', async () => {
    const projectId = `project-character-${Date.now()}`;
    await saveProjectToDb({
      id: projectId,
      name: 'Character project',
      createdAt: 1,
      updatedAt: 2,
      nodes: [],
      edges: [],
      dramaAssets: {
        version: 2,
        characters: [{
          id: 'character-1',
          kind: 'character',
          name: '沈砚',
          key: 'shenyan',
          identity: '',
          summary: '',
          visualNotes: '',
          importance: 'main',
          confirmed: true,
          createdAt: 1,
          updatedAt: 2,
          source: 'manual',
          imageUrl: 'asset://stale-cover',
          primaryReferenceImageId: 'reference-1',
          referenceImages: [{
            id: 'reference-1',
            kind: 'primary',
            assetId: 'asset-reference',
            relativePath: 'character/shenyan.png',
            imageUrl: 'asset://stale',
            prompt: '',
            createdAt: 1,
            updatedAt: 2,
          }],
          primaryVoiceClipId: 'voice-1',
          voiceClips: [{
            id: 'voice-1',
            kind: 'timbre',
            assetId: 'asset-voice',
            relativePath: 'character/shenyan.mp3',
            audioUrl: 'asset://stale',
            transcript: '',
            createdAt: 1,
            updatedAt: 2,
          }],
        }],
        scenes: [],
        props: [],
      },
    } as Parameters<typeof saveProjectToDb>[0]);

    const loaded = await loadProjectData(projectId);
    const character = loaded?.dramaAssets?.characters[0];

    expect(character?.referenceImages?.[0]).toEqual(expect.objectContaining({
      filePath: '/project/data/character/shenyan.png',
      imageUrl: 'asset:///project/data/character/shenyan.png',
    }));
    expect(character?.voiceClips?.[0]).toEqual(expect.objectContaining({
      filePath: '/project/data/character/shenyan.mp3',
      audioUrl: 'asset:///project/data/character/shenyan.mp3',
    }));
    expect(character?.imageUrl).toBe('asset:///project/data/character/shenyan.png');
  });

  it('便携快照异机落库后恢复媒体和参考图展示，实际选图可用且再导出不改变快照', async () => {
    const sourceId = 'portable-source', recipientId = `portable-recipient-${Date.now()}`;
    mocks.identifyAsset.mockImplementation(async (path: string) => ({ assetId: `portable-${path}`, relativePath: path.slice('/recipient/data/'.length) }));
    const paths = ['图片/角色.png', '视频/动作.mp4', '声音/角色.wav', '说明.md'];
    const source: ProjectSaveData = {
      id: sourceId, name: '跨设备项目', createdAt: 1, updatedAt: 2, edges: [], groups: [],
      nodes: [
        { id: 'image', type: 'source-image', data: { type: 'source-image', relativePath: paths[0], imageUrl: 'asset:///old/image.png' } },
        { id: 'video', type: 'ai-video', data: { type: 'ai-video', relativePath: paths[1], videoUrl: 'asset:///old/video.mp4',
          videoReferences: [{ id: 'reference', kind: 'frame', role: 'reference', relativePath: paths[0], url: 'asset:///old/reference.png' }] } },
        { id: 'audio', data: { type: 'source-audio', relativePath: paths[2], audioUrl: 'asset:///old/audio.wav' } },
        { id: 'markdown', type: 'ai-markdown', data: { type: 'ai-markdown', relativePath: paths[3], output: '# 原文\n中文说明' } },
        { id: 'sheet', data: { type: 'ai-shotlist', shotlistRows: [{ id: 'shot', shotNo: '1',
          frame: { nodeId: 'image', kind: 'image', relativePath: paths[0], url: 'asset:///old/frame.png' },
          video: { nodeId: 'video', kind: 'video', relativePath: paths[1], url: 'asset:///old/shot.mp4' } }] } },
        { id: 'grid', data: { type: 'ai-storyboard', storyboardOverrides: [{ relativePath: paths[0], url: 'asset:///old/cell.png' }] } },
        { id: 'workflow', data: { type: 'ai-image', relativePath: paths[0], imageUrl: 'asset:///old/primary.png',
          runninghubOutputs: [{ kind: 'image', relativePath: paths[0], url: 'asset:///old/result.png' }],
          workflowApiOutputs: [{ kind: 'video', relativePath: paths[1], url: 'asset:///old/result.mp4' }] } },
        { id: 'director', data: { type: 'ai-director', directorCaptureRelativePaths: [paths[0]], directorCaptureUrls: ['asset:///old/capture.png'] } },
      ],
      settings: { visualStyle: { styleReference: { relativePath: paths[0], imageUrl: 'asset:///old/style.png' } } } as ProjectSaveData['settings'],
      dramaAssets: normalizeDramaAssetLibrary({ version: 2, characters: [{ id: 'hero', name: '角色', kind: 'character', relativePath: paths[0],
        referenceImages: [{ id: 'hero-reference', kind: 'primary', relativePath: paths[0], imageUrl: 'asset:///old/hero.png' }],
        primaryReferenceImageId: 'hero-reference',
        voiceClips: [{ id: 'hero-voice', kind: 'timbre', relativePath: paths[2], audioUrl: 'asset:///old/voice.wav' }],
        actions: [{ id: 'hero-action', name: '动作', prompt: '转身',
          media: [{ id: 'hero-action-media', kind: 'video', relativePath: paths[1], url: 'asset:///old/action.mp4' }] }] }],
        scenes: [{ id: 'scene', name: '场景', kind: 'scene', relativePath: paths[0], referenceImages: [{ id: 'scene-reference', relativePath: paths[0], imageUrl: 'asset:///old/scene.png' }] }],
        props: [{ id: 'prop', name: '道具', kind: 'prop', relativePath: paths[0], referenceImages: [{ id: 'prop-reference', relativePath: paths[0], imageUrl: 'asset:///old/prop.png' }] }],
      }),
    };
    const assets = paths.map((path, index) => ({ path, bytes: index + 1, sha256: String(index + 1).repeat(64) }));
    const captured = captureExchangeSnapshot([source], assets, null);
    const identities: ProjectExchangeIdentity[] = [{ kind: 'project', scopeId: sourceId, id: sourceId, localId: recipientId }];
    const published = new Map([...captured.files].map(([id, path]) => [id, `imports/portable/${id}/${path.split('/').pop()}`]));
    const imported = materializeExchangeSnapshot(captured.snapshot, identities, [], '接收方目录', published);
    for (const [id, path] of published) identities.push({ kind: 'file', scopeId: sourceId, id, localId: path });
    const state: ProjectExchangeState = { ownerId: recipientId, lineageId: captured.snapshot.lineageId, rootProjectId: sourceId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities };
    const receivedAssets = [...captured.files].map(([id, path]) => ({ ...assets.find((asset) => asset.path === path)!, path: published.get(id)! }));
    const importedNodes = imported[0].nodes as Array<{ id: string; data: Record<string, unknown> }>;
    expect(importedNodes.find((node) => node.id === 'image')?.data).not.toHaveProperty('imageUrl');
    await saveProjectToDb(imported[0]);
    mocks.getProjectDataDir.mockResolvedValue('/recipient/data');
    const loaded = (await loadProjectData(recipientId))!;
    const nodes = loaded.nodes as Array<{ id: string; data: Record<string, unknown> }>;
    const data = (id: string) => nodes.find((node) => node.id === id)!.data;
    const url = (sourcePath: string) => `asset:///recipient/data/${published.get([...captured.files].find(([, path]) => path === sourcePath)![0])}`;
    expect(data('image').imageUrl).toBe(url(paths[0]));
    expect(data('video').videoUrl).toBe(url(paths[1]));
    expect(data('audio').audioUrl).toBe(url(paths[2]));
    expect(data('markdown').output).toBe('# 原文\n中文说明');
    expect(data('markdown')).not.toHaveProperty('imageUrl');
    expect(data('video').videoReferences).toMatchObject([{ url: url(paths[0]) }]);
    expect(data('sheet').shotlistRows).toMatchObject([{ frame: { url: url(paths[0]) }, video: { url: url(paths[1]) } }]);
    expect(data('grid').storyboardOverrides).toMatchObject([{ url: url(paths[0]) }]);
    expect(data('workflow').runninghubOutputs).toMatchObject([{ url: url(paths[0]) }]);
    expect(data('workflow').workflowApiOutputs).toMatchObject([{ url: url(paths[1]) }]);
    expect(data('director').directorCaptureUrls).toEqual([url(paths[0])]);
    expect(loaded.settings?.visualStyle?.styleReference?.imageUrl).toBe(url(paths[0]));
    const library = loaded.dramaAssets!;
    expect(library.characters[0].voiceClips?.[0].audioUrl).toBe(url(paths[2]));
    expect(library.characters[0].actions?.[0].media?.[0].url).toBe(url(paths[1]));
    for (const asset of [library.characters[0], library.scenes[0], library.props[0]]) {
      const referenceId = asset.referenceImages![0].id;
      expect(resolveDramaAssetImageRef(asset, nodes, referenceId)?.imageUrl).toBe(url(paths[0]));
    }
    expect(captureExchangeSnapshot([loaded], receivedAssets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
    await saveProject(loaded);
    const saved = (await getProjectById(recipientId))! as ProjectSaveData;
    const savedWorkflow = (saved.nodes as Array<{ id: string; data: Record<string, unknown> }>).find((node) => node.id === 'workflow')!;
    for (const field of ['runninghubOutputs', 'workflowApiOutputs']) {
      const output = (savedWorkflow.data[field] as Array<Record<string, unknown>>)[0];
      expect(output.relativePath).toEqual(expect.stringMatching(/^imports\/portable\//));
      expect(output).not.toHaveProperty('filePath');
    }
    expect(captureExchangeSnapshot([saved], receivedAssets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('便携媒体文件缺失时保留引用，不伪造可用的展示地址', async () => {
    mocks.exists.mockResolvedValue(false);
    mocks.scanDirectoryFiles.mockResolvedValue(scanResult());
    const projectId = `portable-missing-${Date.now()}`;
    await saveProjectToDb({ id: projectId, name: '缺失媒体', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'image', data: { type: 'source-image', relativePath: 'missing.png' } }],
    });
    const loaded = await loadProjectData(projectId);
    expect((loaded?.nodes as Array<{ data: Record<string, unknown> }>)[0].data).toEqual({ type: 'source-image', relativePath: 'missing.png' });
  });

  it('persists URL-only video references with local identities and restores them in the new directory', async () => {
    mocks.identifyAsset.mockResolvedValue({ assetId: 'asset-hero-image', relativePath: 'character/hero.png' });
    const projectId = `project-video-reference-save-${Date.now()}`;
    const localUrl = 'http://asset.localhost/%2Fproject%2Fdata%2Fcharacter%2Fhero.png';
    const references = [
      { id: 'character:hero', kind: 'character', role: 'reference', url: localUrl },
      { id: 'volcengine-asset:remote-hero', kind: 'volcengine-asset', role: 'reference',
        provider: 'volcengine', assetId: 'remote-hero', url: 'asset://remote-hero' },
      { id: 'remote-image', kind: 'frame', role: 'last_frame', url: 'https://cdn.example/frame.png' },
    ];
    await saveProject({
      id: projectId, name: 'Video references', createdAt: 1, updatedAt: 2,
      nodes: [{ id: 'video', data: { type: 'ai-video', videoReferences: references } }], edges: [],
    });
    const stored = await getProjectById(projectId) as { nodes: Array<{ data: {
      videoReferences: Array<Record<string, unknown>>;
    } }> };
    expect(stored.nodes[0].data.videoReferences[0]).toMatchObject({
      url: localUrl, assetId: 'asset-hero-image', relativePath: 'character/hero.png',
    });
    expect(stored.nodes[0].data.videoReferences[0]).not.toHaveProperty('filePath');
    expect(stored.nodes[0].data.videoReferences.slice(1)).toEqual(references.slice(1));
    expect(references[0]).not.toHaveProperty('assetId');

    mocks.getProjectDataDir.mockResolvedValue('/project/moved');
    const loaded = await loadProjectData(projectId);
    const restored = loaded?.nodes as typeof stored.nodes;
    expect(restored[0].data.videoReferences[0]).toMatchObject({
      url: 'asset:///project/moved/character/hero.png', filePath: '/project/moved/character/hero.png',
    });
    expect(restored[0].data.videoReferences.slice(1)).toEqual(references.slice(1));
  });

  it.each([false, true])('recovers legacy character media by exact URLs (shared library: %s)', async (sharedLibrary) => {
    const projectId = `project-video-reference-legacy-${Date.now()}`;
    const imageUrl = 'http://asset.localhost/%2Fold-project%2Fcharacter%2Fhero.png';
    const audioUrl = 'http://asset.localhost/%2Fold-project%2Fcharacter%2Fhero.wav';
    const unmatchedUrl = 'http://asset.localhost/%2Fold-project%2Fcharacter%2Fdeleted.png';
    const input: ProjectSaveData = {
      id: projectId, name: 'Legacy references', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'video', data: { type: 'ai-video', videoReferences: [
        { id: 'character:hero', kind: 'character', role: 'reference', url: imageUrl },
        { id: 'character:hero:voice', kind: 'character', mediaKind: 'audio', role: 'reference_audio', url: audioUrl },
        { id: 'character:deleted', kind: 'character', role: 'reference', url: unmatchedUrl },
      ] } }],
      dramaAssets: {
        version: 2, scenes: [], props: [], characters: [{
          id: 'hero', kind: 'character', name: '主角', key: 'hero', identity: '', summary: '', visualNotes: '',
          importance: 'main', confirmed: true, createdAt: 1, updatedAt: 2, source: 'manual',
          primaryReferenceImageId: 'new-primary',
          referenceImages: [
            { id: 'original', kind: 'primary', assetId: 'asset-hero-image', relativePath: 'character/hero.png',
              imageUrl, prompt: '', createdAt: 1, updatedAt: 2 },
            { id: 'new-primary', kind: 'primary', assetId: 'asset-new-image', relativePath: 'character/new.png',
              imageUrl: 'http://asset.localhost/%2Fold-project%2Fcharacter%2Fnew.png', prompt: '', createdAt: 1, updatedAt: 2 },
          ],
          voiceClips: [{ id: 'voice', kind: 'timbre', assetId: 'asset-hero-voice', relativePath: 'character/hero.wav',
            audioUrl, transcript: '', createdAt: 1, updatedAt: 2 }],
        }],
      },
    };
    const ownerId = `${projectId}-series`;
    if (sharedLibrary) await saveProjectToDb({ ...input, id: ownerId, nodes: [] });
    const episodeInput: ProjectSaveData = {
      ...input, parentId: sharedLibrary ? ownerId : undefined,
      dramaAssets: sharedLibrary ? undefined : input.dramaAssets,
    };
    await saveProjectToDb(episodeInput);
    const loaded = await loadProjectData(projectId);
    const restored = loaded?.nodes as Array<{ data: { videoReferences: Array<Record<string, unknown>> } }>;
    expect(restored[0].data.videoReferences[0]).toMatchObject({
      url: 'asset:///project/data/character/hero.png', assetId: 'asset-hero-image',
    });
    expect(restored[0].data.videoReferences[1]).toMatchObject({
      url: 'asset:///project/data/character/hero.wav', assetId: 'asset-hero-voice', role: 'reference_audio',
    });
    expect(restored[0].data.videoReferences[2].url).toBe(unmatchedUrl);
    const stored = await getProjectById(projectId) as { nodes: typeof restored };
    expect(stored.nodes[0].data.videoReferences[0].url).toBe(imageUrl);
    expect(stored.nodes[0].data.videoReferences[0]).not.toHaveProperty('assetId');
  });

  it('collapses character media file paths into asset ids when saving', async () => {
    mocks.identifyAsset.mockResolvedValue({
      assetId: 'asset-shared',
      relativePath: 'character/shared.mp3',
    });
    const projectId = `project-save-${Date.now()}`;

    await saveProject({
      id: projectId,
      name: 'Character save',
      createdAt: 1,
      updatedAt: 2,
      nodes: [],
      edges: [],
      dramaAssets: {
        version: 2,
        characters: [{
          id: 'character-1',
          kind: 'character',
          name: '沈砚',
          key: 'shenyan',
          identity: '',
          summary: '',
          visualNotes: '',
          importance: 'main',
          confirmed: true,
          createdAt: 1,
          updatedAt: 2,
          source: 'manual',
          referenceImages: [],
          voiceClips: [{
            id: 'voice-1',
            kind: 'timbre',
            filePath: '/project/data/character/shared.mp3',
            audioUrl: 'asset:///project/data/character/shared.mp3',
            transcript: '',
            createdAt: 1,
            updatedAt: 2,
          }],
        }],
        scenes: [],
        props: [],
      },
    });

    const record = await getProjectById(projectId) as { dramaAssets?: { characters: Array<{
      voiceClips?: Array<Record<string, unknown>>;
    }> } } | undefined;
    const persistedClip = record?.dramaAssets?.characters[0]?.voiceClips?.[0];

    expect(persistedClip).toEqual(expect.objectContaining({
      assetId: 'asset-shared',
      relativePath: 'character/shared.mp3',
    }));
    expect(persistedClip).not.toHaveProperty('filePath');
  });

  it('skips the directory scan and re-identification while every asset stays in place', async () => {
    const projectId = `project-fast-${Date.now()}`;
    await saveProjectToDb({
      id: projectId,
      name: 'Unchanged project',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{
        id: 'image-node',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: { type: 'ai-image', assetId: 'asset-saved', relativePath: 'saved.png', imageUrl: 'asset://stale' },
      }],
      edges: [],
    });

    const loaded = await loadProjectData(projectId);

    expect(mocks.scanDirectoryFiles).not.toHaveBeenCalled();
    expect(mocks.identifyAsset).not.toHaveBeenCalled();
    expect((loaded?.nodes as Array<{ data: { filePath?: string } }>)[0].data.filePath)
      .toBe('/project/data/saved.png');
  });

  it('序列化成片快照并在源节点已删除、项目目录变化后恢复同一视频', async () => {
    mocks.identifyAsset.mockResolvedValue({ assetId: 'shot-video', relativePath: 'final.mp4' });
    const projectId = `project-shot-video-${Date.now()}`;
    await saveProject({
      id: projectId, name: '成片快照', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'sheet', data: { type: 'ai-shotlist', shotlistRows: [{
        id: 'shot-1', shotNo: '1', frame: null,
        video: { nodeId: 'deleted-source', kind: 'video', url: 'asset:///project/data/final.mp4',
          filePath: '/project/data/final.mp4', sourceDuration: 4.5 },
      }] } }],
    });
    const persisted = await getProjectById(projectId) as unknown as {
      nodes: Array<{ data: { shotlistRows: Array<{ video: Record<string, unknown> }> } }>;
    };
    expect(persisted.nodes[0].data.shotlistRows[0].video).toMatchObject({
      nodeId: 'deleted-source', kind: 'video', assetId: 'shot-video', relativePath: 'final.mp4', sourceDuration: 4.5,
    });
    expect(persisted.nodes[0].data.shotlistRows[0].video).not.toHaveProperty('filePath');

    mocks.getProjectDataDir.mockResolvedValue('/project/moved');
    mocks.identifyAsset.mockClear();
    const loaded = await loadProjectData(projectId) as unknown as typeof persisted;
    expect(loaded.nodes[0].data.shotlistRows[0].video).toMatchObject({
      nodeId: 'deleted-source', assetId: 'shot-video', relativePath: 'final.mp4',
      filePath: '/project/moved/final.mp4', url: 'asset:///project/moved/final.mp4',
    });
    expect(mocks.identifyAsset).not.toHaveBeenCalled();
  });

  it('成片快照素材缺失也触发索引恢复扫描并保留稳定身份', async () => {
    mocks.exists.mockResolvedValue(false);
    mocks.scanDirectoryFiles.mockResolvedValue(scanResult());
    const projectId = `project-shot-video-missing-${Date.now()}`;
    await saveProjectToDb({ id: projectId, name: '缺失成片', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'sheet', data: { type: 'ai-shotlist', shotlistRows: [{ id: 'shot-1', shotNo: '1',
        video: { nodeId: 'deleted-source', kind: 'video', assetId: 'missing-video', relativePath: 'missing.mp4' },
      }] } }],
    });
    const loaded = await loadProjectData(projectId) as unknown as {
      nodes: Array<{ data: { shotlistRows: Array<{ video: Record<string, unknown> }> } }>;
    };
    expect(mocks.scanDirectoryFiles).toHaveBeenCalledWith('/project/data', {
      source: 'project', projectId, excludedRootDirectories: ['.thumbnail'],
    });
    expect(loaded.nodes[0].data.shotlistRows[0].video).toEqual({
      nodeId: 'deleted-source', kind: 'video', assetId: 'missing-video', relativePath: 'missing.mp4',
    });
  });

  it('excludes the project thumbnail cache when rebuilding the index for a missing asset', async () => {
    mocks.exists.mockResolvedValue(false);
    mocks.scanDirectoryFiles.mockResolvedValue(scanResult());
    const projectId = `project-missing-${Date.now()}`;
    await saveProjectToDb({
      id: projectId,
      name: 'Missing asset',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{ id: 'missing', data: { assetId: 'missing', relativePath: 'missing.png' } }],
      edges: [],
    });

    await loadProjectData(projectId);

    expect(mocks.scanDirectoryFiles).toHaveBeenCalledWith('/project/data', {
      source: 'project', projectId,
      excludedRootDirectories: ['.thumbnail'],
    });
  });

  it('keeps the newest generation when the record still carries a runtime file path', async () => {
    const projectId = `project-latest-${Date.now()}`;
    // 上一次保存没能收敛身份（identifyAsset 失败）：filePath 是最后一次生成的图，
    // assetId / relativePath 还停在上一张上。
    await saveProjectToDb({
      id: projectId,
      name: 'Regenerated node',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{
        id: 'image-node',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          type: 'ai-image',
          assetId: 'asset-first',
          relativePath: 'shot.png',
          filePath: '/project/data/shot (2).png',
          imageUrl: 'asset://stale',
        },
      }],
      edges: [],
    });

    const loaded = await loadProjectData(projectId);

    expect((loaded?.nodes as Array<{ data: { filePath?: string; imageUrl?: string } }>)[0].data)
      .toMatchObject({
        filePath: '/project/data/shot (2).png',
        imageUrl: 'asset:///project/data/shot (2).png',
      });
  });

  it('reuses the recorded asset identity when saving an unmoved file', async () => {
    const projectId = `project-fast-save-${Date.now()}`;

    await saveProject({
      id: projectId,
      name: 'Unmoved save',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{
        id: 'image-node',
        data: { assetId: 'asset-saved', relativePath: 'saved.png', filePath: '/project/data/saved.png' },
      }],
      edges: [],
    });

    const record = await getProjectById(projectId) as { nodes: Array<{ data: Record<string, unknown> }> };

    expect(mocks.identifyAsset).not.toHaveBeenCalled();
    expect(record.nodes[0].data).toEqual({ assetId: 'asset-saved', relativePath: 'saved.png' });
  });

  it('checks a shared path once per save across nodes, references, settings and the asset library', async () => {
    const reference = { assetId: 'shared', relativePath: 'shared.png', filePath: '/project/data/shared.png',
      imageUrl: 'asset:///project/data/shared.png' };
    const project = {
      id: `shared-save-${Date.now()}`, name: 'Shared asset', createdAt: 1, updatedAt: 2,
      nodes: [{ id: 'a', data: reference }, { id: 'b', data: { ...reference,
        storyboardOverrides: [{ ...reference, url: reference.imageUrl }],
        videoReferences: [{ ...reference, url: reference.imageUrl }],
      } }], edges: [],
      settings: { visualStyle: { styleReference: { ...reference, fileName: 'shared.png' } } },
      dramaAssets: { version: 2, characters: [], scenes: [{ ...reference, id: 'scene', kind: 'scene', name: '场景',
        key: 'scene', summary: '', visualNotes: '', importance: 'supporting', confirmed: true,
        source: 'manual', createdAt: 1, updatedAt: 2 }], props: [] },
    } as ProjectSaveData;

    await saveProject(project);
    expect(mocks.exists).toHaveBeenCalledExactlyOnceWith('/project/data/shared.png');
    expect(mocks.identifyAsset).not.toHaveBeenCalled();
    await saveProject(project);
    expect(mocks.exists).toHaveBeenCalledTimes(2);
  });

  it('shares load path checks without reusing file state across later loads or projects', async () => {
    const reference = { assetId: 'shared', relativePath: 'shared.png', imageUrl: 'asset:///project/data/shared.png' };
    const record = {
      id: `shared-load-${Date.now()}`, name: 'Shared asset', createdAt: 1, updatedAt: 2,
      nodes: [{ id: 'a', data: reference }, { id: 'b', data: { ...reference,
        videoReferences: [{ ...reference, url: reference.imageUrl }],
      } }], edges: [],
      settings: { visualStyle: { styleReference: { ...reference, fileName: 'shared.png' } } },
      dramaAssets: { version: 2, characters: [], scenes: [{ ...reference, id: 'scene', kind: 'scene', name: '场景',
        key: 'scene', summary: '', visualNotes: '', importance: 'supporting', confirmed: true,
        source: 'manual', createdAt: 1, updatedAt: 2 }], props: [] },
    } as ProjectSaveData;
    await saveProjectToDb(record);
    await saveProjectToDb({ ...record, id: `${record.id}-other` });

    await loadProjectData(record.id);
    expect(mocks.exists).toHaveBeenCalledExactlyOnceWith('/project/data/shared.png');
    await loadProjectData(record.id);
    expect(mocks.exists).toHaveBeenCalledTimes(2);
    await loadProjectData(`${record.id}-other`);
    expect(mocks.exists).toHaveBeenCalledTimes(3);
    expect(mocks.identifyAsset).not.toHaveBeenCalled();
  });

  it('bounds node restoration concurrency while preserving node order', async () => {
    let active = 0;
    let peak = 0;
    mocks.exists.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return true;
    });
    const projectId = `bounded-load-${Date.now()}`;
    const nodes = Array.from({ length: 20 }, (_, index) => ({ id: `n${index}`,
      data: { assetId: `asset${index}`, relativePath: `image${index}.png` } }));
    await saveProjectToDb({ id: projectId, name: 'Bounded load', createdAt: 1, updatedAt: 2, nodes, edges: [] });

    const loaded = await loadProjectData(projectId);

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect((loaded?.nodes as typeof nodes).map((node) => node.id)).toEqual(nodes.map((node) => node.id));
  });

  it('normalizes Windows path separators without merging case-sensitive non-Windows paths', async () => {
    const windowsId = `normalized-load-${Date.now()}`;
    mocks.getProjectDataDir.mockResolvedValue('C:/project/data');
    await saveProjectToDb({ id: windowsId, name: 'Windows paths', createdAt: 1, updatedAt: 2,
      nodes: [{ id: 'a', data: { assetId: 'shared', relativePath: 'folder/shared.png' } },
        { id: 'b', data: { assetId: 'shared', relativePath: 'folder\\shared.png' } }], edges: [],
    });
    await loadProjectData(windowsId);
    expect(mocks.exists).toHaveBeenCalledOnce();

    mocks.exists.mockClear();
    mocks.getProjectDataDir.mockResolvedValue('/project/data');
    const sensitiveId = `${windowsId}-sensitive`;
    await saveProjectToDb({ id: sensitiveId, name: 'Distinct paths', createdAt: 1, updatedAt: 2,
      nodes: [{ id: 'a', data: { assetId: 'lower', relativePath: 'a.png' } },
        { id: 'b', data: { assetId: 'upper', relativePath: 'A.png' } }], edges: [],
    });
    await loadProjectData(sensitiveId);
    expect(mocks.exists).toHaveBeenCalledTimes(2);
  });

  it('observes a file that reappears during missing-asset recovery', async () => {
    let recovered = false;
    mocks.exists.mockImplementation(async () => recovered);
    mocks.scanDirectoryFiles.mockImplementation(async () => { recovered = true; return scanResult(); });
    const projectId = `reappeared-load-${Date.now()}`;
    await saveProjectToDb({ id: projectId, name: 'Recovered file', createdAt: 1, updatedAt: 2,
      nodes: [{ id: 'a', data: { assetId: 'saved', relativePath: 'saved.png' } }], edges: [],
    });

    const loaded = await loadProjectData(projectId);

    expect((loaded?.nodes as Array<{ data: { filePath?: string } }>)[0].data.filePath).toBe('/project/data/saved.png');
    expect(mocks.exists).toHaveBeenCalledTimes(2);
  });

  it('bounds recovery path checks and reuses the scan without registering every file again', async () => {
    let active = 0;
    let peak = 0;
    mocks.exists.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return false;
    });
    const files = Array.from({ length: 12 }, (_, index) => ({ name: `image${index}.png`,
      path: `/project/data/image${index}.png`, relativePath: `image${index}.png`, assetId: `asset${index}`,
      size: 10, category: 'image' as const }));
    mocks.scanDirectoryFiles.mockResolvedValue(scanResult({ files }));
    const projectId = `bounded-recovery-${Date.now()}`;
    await saveProjectToDb({ id: projectId, name: 'Recovery', createdAt: 1, updatedAt: 2,
      nodes: files.map((_, index) => ({ id: `n${index}`, data: { assetId: `asset${index}`, relativePath: `image${index}.png` } })),
      edges: [],
    });

    await loadProjectData(projectId);

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(mocks.scanDirectoryFiles).toHaveBeenCalledExactlyOnceWith('/project/data', {
      source: 'project', projectId, excludedRootDirectories: ['.thumbnail'],
    });
    expect(mocks.identifyAsset).not.toHaveBeenCalled();
    expect(mocks.exists).toHaveBeenCalledTimes(files.length * 2);
  });

  it('reuses real scan registration once and does not reindex retired copies or thumbnail files', async () => {
    const projectId = `single-scan-recovery-${Date.now()}`;
    const directory = `/project/${projectId}`;
    const assetId = `${projectId}-image`;
    const currentPath = `${directory}/current.png`;
    const oldPath = `${directory}/old.png`;
    mocks.getProjectDataDir.mockResolvedValue(directory);
    mocks.exists.mockResolvedValueOnce(false).mockResolvedValue(true);
    mocks.stat.mockResolvedValue({ size: 10, mtime: new Date(20) });
    mocks.readDir.mockResolvedValue([
      { name: 'old.png', isFile: true, isDirectory: false, isSymlink: false },
      { name: 'current.png', isFile: true, isDirectory: false, isSymlink: false },
      { name: '.thumbnail', isFile: false, isDirectory: true, isSymlink: false },
    ]);
    await putAssetIndex({ assetId, path: currentPath, rootPath: directory, relativePath: 'current.png',
      source: 'project', projectId, size: 10, mtimeMs: 20, fingerprint: '10:20', status: 'online', updatedAt: 1 });
    const { persistMediaRelocation } = await import('../../src/services/indexedDb/mediaRelocations');
    await persistMediaRelocation({ projectId, oldPath, newPath: currentPath,
      assetUrl: `asset://${currentPath}`, relativePath: 'current.png' });
    const realIndex = await vi.importActual<typeof import('../../src/services/fs/assetIndex')>('../../src/services/fs/assetIndex');
    const realLibrary = await vi.importActual<typeof import('../../src/services/fs/assetLibrary')>('../../src/services/fs/assetLibrary');
    mocks.identifyAsset.mockImplementation(realIndex.identifyAsset);
    mocks.scanDirectoryFiles.mockImplementation(realLibrary.scanDirectoryFiles);
    await saveProjectToDb({ id: projectId, name: 'Single recovery scan', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'image', data: { type: 'source-image', assetId, relativePath: 'current.png' } }],
    });

    const loaded = await loadProjectData(projectId);

    expect(mocks.scanDirectoryFiles).toHaveBeenCalledExactlyOnceWith(directory, {
      source: 'project', projectId, excludedRootDirectories: ['.thumbnail'],
    });
    expect(mocks.stat).toHaveBeenCalledExactlyOnceWith(currentPath);
    expect(mocks.identifyAsset).toHaveBeenCalledExactlyOnceWith(currentPath, {
      assetId: undefined, rootPath: directory, source: 'project', projectId, size: 10, mtimeMs: 20,
    });
    expect(mocks.readDir).toHaveBeenCalledExactlyOnceWith(directory);
    expect(mocks.exists).toHaveBeenCalledTimes(2);
    expect(await getAssetIndexByPath(oldPath)).toBeUndefined();
    expect(await getAssetIndexById(assetId)).toMatchObject({ path: currentPath, source: 'project', projectId, mtimeMs: 20 });
    expect((loaded?.nodes as Array<{ data: { filePath?: string } }>)[0].data.filePath).toBe(currentPath);
  });

  it('restores a renamed asset from the identity registered by the recovery scan', async () => {
    const projectId = `renamed-scan-recovery-${Date.now()}`;
    const directory = `/project/${projectId}`;
    const assetId = `${projectId}-image`;
    const oldPath = `${directory}/old.png`;
    const newPath = `${directory}/renamed.png`;
    mocks.getProjectDataDir.mockResolvedValue(directory);
    mocks.exists.mockImplementation(async (path: string) => path === newPath);
    mocks.stat.mockResolvedValue({ size: 10, mtime: new Date(20) });
    const realIndex = await vi.importActual<typeof import('../../src/services/fs/assetIndex')>('../../src/services/fs/assetIndex');
    mocks.identifyAsset.mockImplementation(realIndex.identifyAsset);
    mocks.resolveIndexedAssetPath.mockImplementation(realIndex.resolveIndexedAssetPath);
    mocks.scanDirectoryFiles.mockImplementation(async () => {
      await putAssetIndex({ assetId, path: newPath, rootPath: directory, relativePath: 'renamed.png',
        source: 'project', projectId, size: 10, mtimeMs: 20, fingerprint: '10:20', status: 'online', updatedAt: 1 });
      return scanResult({ files: [{ assetId, path: newPath, relativePath: 'renamed.png', name: 'renamed.png',
        size: 10, category: 'image', source: 'project' }] });
    });
    await saveProjectToDb({ id: projectId, name: 'Renamed recovery', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'image', data: { type: 'source-image', assetId, relativePath: 'old.png' } }],
    });

    const loaded = await loadProjectData(projectId);

    expect(mocks.scanDirectoryFiles).toHaveBeenCalledTimes(1);
    expect(mocks.resolveIndexedAssetPath).toHaveBeenCalledTimes(2);
    expect(mocks.exists.mock.calls.filter(([path]) => path === oldPath)).toHaveLength(2);
    // 仅改名后的单个引用需要重新核对身份，不再对扫描结果整批登记。
    expect(mocks.identifyAsset).toHaveBeenCalledExactlyOnceWith(newPath, {
      assetId, rootPath: directory, projectId, source: 'project',
    });
    expect((loaded?.nodes as Array<{ data: Record<string, unknown> }>)[0].data).toMatchObject({
      assetId, relativePath: 'renamed.png', filePath: newPath, imageUrl: `asset://${newPath}`,
    });
    expect(await getAssetIndexById(assetId)).toMatchObject({ path: newPath, source: 'project', projectId });
  });

  it.each(['failed', 'partial', 'truncated'] as const)('keeps the persisted canvas and retries recovery after a %s scan', async (state) => {
    const projectId = `incomplete-scan-${state}-${Date.now()}`;
    const nodes = [{ id: 'image', position: { x: 10, y: 20 },
      data: { type: 'source-image', assetId: 'missing', relativePath: 'missing.png' } }];
    mocks.exists.mockResolvedValue(false);
    const result = scanResult({ complete: false, failedFiles: state === 'partial' ? 2 : 0,
      failedDirectories: state === 'partial' ? 1 : 0, truncated: state === 'truncated' });
    if (state !== 'failed') mocks.scanDirectoryFiles.mockResolvedValue(result);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await saveProjectToDb({ id: projectId, name: 'Incomplete recovery', createdAt: 1, updatedAt: 2, nodes, edges: [] });

    const loaded = await loadProjectData(projectId);

    expect(loaded?.nodes).toEqual(nodes);
    expect(mocks.scanDirectoryFiles).toHaveBeenCalledTimes(1);
    expect(mocks.exists).toHaveBeenCalledTimes(2);
    expect(mocks.identifyAsset).not.toHaveBeenCalled();
    if (state === 'failed') {
      expect(warn).toHaveBeenCalledWith('[项目加载] 资产目录扫描失败，已继续加载画布', { projectId });
    } else {
      expect(warn).toHaveBeenCalledWith('[项目加载] 资产索引扫描未完成，已继续加载画布', {
        projectId, failedFiles: result.failedFiles, failedDirectories: result.failedDirectories, truncated: result.truncated,
      });
    }
  });

  it('moves legacy inline generated media to a project file before saving', async () => {
    mocks.exists.mockResolvedValueOnce(false).mockResolvedValue(true);
    mocks.identifyAsset.mockImplementation(async (path: string) => ({
      assetId: 'asset-generated',
      relativePath: path.split('/').pop(),
    }));
    const projectId = `project-inline-${Date.now()}`;
    const inline = 'data:image/png;base64,AQID';

    await saveProject({
      id: projectId,
      name: 'Inline media migration',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{
        id: 'image-node',
        data: {
          type: 'ai-image',
          label: '自定义接口图片',
          imageUrl: inline,
          sourceUrl: inline,
          thumbnailUrl: inline,
          output: inline,
        },
      }],
      edges: [],
    });

    const writtenPath = mocks.writeFile.mock.calls[0][0] as string;
    expect(writtenPath).toMatch(/^\/project\/data\/embedded-image-[a-f0-9]{20}\.png$/);
    expect(mocks.writeFile).toHaveBeenCalledWith(writtenPath, new Uint8Array([1, 2, 3]));
    const record = await getProjectById(projectId) as { nodes: Array<{ data: Record<string, unknown> }> };
    expect(record.nodes[0].data).toMatchObject({
      assetId: 'asset-generated',
      relativePath: writtenPath.split('/').pop(),
      imageUrl: `asset://${writtenPath}`,
      sourceUrl: `asset://${writtenPath}`,
      thumbnailUrl: `asset://${writtenPath}`,
      output: `asset://${writtenPath}`,
    });
    expect(record.nodes[0].data).not.toHaveProperty('filePath');
    expect(JSON.stringify(record.nodes[0])).not.toContain('data:image');
  });

  it('creates the project directory before checking or writing inline media', async () => {
    let directoryReady = false;
    mocks.mkdir.mockImplementation(async () => {
      await Promise.resolve();
      directoryReady = true;
    });
    mocks.exists.mockImplementation(async () => {
      if (!directoryReady) throw new Error('project directory is missing');
      return false;
    });
    mocks.writeFile.mockImplementation(async () => {
      if (!directoryReady) throw new Error('project directory is missing');
    });
    const projectId = `project-create-directory-${Date.now()}`;

    await saveProject({
      id: projectId, name: '新项目', createdAt: 1, updatedAt: 2,
      nodes: [{ id: 'inline-node', data: { imageUrl: 'data:image/png;base64,AQID' } }],
      edges: [],
    });

    expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith('/project/data', { recursive: true });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(await getProjectById(projectId)).toBeDefined();
  });

  it.each(['mkdir', 'exists'] as const)('preserves the saved project when %s rejects access', async (operation) => {
    const projectId = `project-access-denied-${operation}-${Date.now()}`;
    const original = {
      id: projectId, name: '已保存项目', createdAt: 1, updatedAt: 2,
      nodes: [], edges: [],
    };
    await saveProjectToDb(original);
    const denied = new Error('forbidden path');
    mocks[operation].mockRejectedValue(denied);

    await expect(saveProject({
      ...original, updatedAt: 3,
      nodes: [{ id: 'inline-node', data: { imageUrl: 'data:image/png;base64,AQID' } }],
    })).rejects.toBe(denied);

    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(await getProjectById(projectId)).toMatchObject(original);
  });

  it('automatically migrates inline media when an existing project is loaded', async () => {
    mocks.exists.mockResolvedValueOnce(false).mockResolvedValue(true);
    mocks.identifyAsset.mockImplementation(async (path: string) => ({
      assetId: 'asset-loaded',
      relativePath: path.split('/').pop(),
    }));
    const projectId = `project-inline-load-${Date.now()}`;
    const inline = 'data:video/mp4;base64,AQID';
    await saveProjectToDb({
      id: projectId,
      name: 'Legacy inline video',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{
        id: 'video-node',
        data: {
          type: 'ai-video',
          label: '旧生成视频',
          videoUrl: inline,
          sourceUrl: inline,
          output: inline,
        },
      }],
      edges: [],
    });

    const loaded = await loadProjectData(projectId);
    const stored = await getProjectById(projectId) as { nodes: Array<{ data: Record<string, unknown> }> };

    const writtenPath = mocks.writeFile.mock.calls[0][0] as string;
    expect(writtenPath).toMatch(/^\/project\/data\/embedded-video-[a-f0-9]{20}\.mp4$/);
    expect(mocks.writeFile).toHaveBeenCalledWith(writtenPath, new Uint8Array([1, 2, 3]));
    expect((loaded?.nodes as Array<{ data: Record<string, unknown> }>)[0].data).toMatchObject({
      filePath: writtenPath,
      videoUrl: `asset://${writtenPath}`,
      sourceUrl: `asset://${writtenPath}`,
      output: `asset://${writtenPath}`,
    });
    expect(JSON.stringify(stored.nodes[0])).not.toContain('data:video');
  });

  it('migrates every explicit nested media field and reuses content-addressed files', async () => {
    const existingPaths = new Set<string>();
    mocks.exists.mockImplementation(async (path: string) => existingPaths.has(path));
    mocks.writeFile.mockImplementation(async (path: string) => {
      existingPaths.add(path);
    });
    mocks.identifyAsset.mockImplementation(async (path: string) => ({
      assetId: `asset-${path.split('/').pop()}`,
      relativePath: path.split('/').pop(),
    }));
    const projectId = `project-nested-inline-${Date.now()}`;
    const first = 'data:image/png;base64,AQID';
    const second = 'data:image/png;base64,BAUG';
    const video = 'data:video/mp4;base64,BwgJ';
    const project = {
      id: projectId,
      name: 'Nested inline media',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{
        id: 'nested-node',
        data: {
          type: 'ai-image',
          imageUrl: first,
          filePath: '/project/data/missing.png',
          mattingMask: first,
          annotation: second,
          storyboardOverrides: [{ url: first }],
          shotlistRows: [{
            id: 'shot-1',
            shotNo: '1',
            frame: { nodeId: 'source-1', kind: 'image', url: second },
            video: { nodeId: 'video-source', kind: 'video', url: video },
          }],
          videoReferences: [{
            id: 'reference-1',
            url: first,
            kind: 'frame',
            role: 'reference',
          }],
          directorCaptureUrls: [second],
        },
      }],
      edges: [],
      settings: {
        visualStyle: {
          styleReference: { imageUrl: first, fileName: 'style.png' },
        },
      },
    } as Parameters<typeof saveProject>[0];

    await saveProject(project);
    await saveProject(project);

    expect(mocks.writeFile).toHaveBeenCalledTimes(3);
    const record = await getProjectById(projectId) as unknown as {
      nodes: Array<{ data: {
        filePath?: string;
        storyboardOverrides: Array<Record<string, unknown>>;
        shotlistRows: Array<{ frame: Record<string, unknown>; video: Record<string, unknown> }>;
        videoReferences: Array<{ url: string }>;
        directorCaptureUrls: string[];
      } }>;
      settings: { visualStyle: { styleReference: Record<string, unknown> } };
    };
    expect(JSON.stringify(record)).not.toContain('data:image');
    expect(JSON.stringify(record)).not.toContain('data:video');
    expect(record.nodes[0].data.filePath).not.toBe('/project/data/missing.png');
    expect(record.nodes[0].data.storyboardOverrides[0]).toEqual(expect.objectContaining({
      assetId: expect.any(String),
      relativePath: expect.stringMatching(/^embedded-image-/),
      url: expect.stringMatching(/^asset:\/\/\/project\/data\/embedded-image-/),
    }));
    expect(record.nodes[0].data.shotlistRows[0].frame).toEqual(expect.objectContaining({
      assetId: expect.any(String),
      relativePath: expect.stringMatching(/^embedded-image-/),
    }));
    expect(record.nodes[0].data.shotlistRows[0].video).toMatchObject({
      nodeId: 'video-source', kind: 'video', assetId: expect.any(String),
      relativePath: expect.stringMatching(/^embedded-video-/),
    });
    expect(record.nodes[0].data.shotlistRows[0].video).not.toHaveProperty('filePath');
    expect(record.nodes[0].data.videoReferences[0].url)
      .toMatch(/^asset:\/\/\/project\/data\/embedded-image-/);
    expect(record.nodes[0].data.directorCaptureUrls[0])
      .toMatch(/^asset:\/\/\/project\/data\/embedded-image-/);
    expect(record.settings.visualStyle.styleReference).toEqual(expect.objectContaining({
      assetId: expect.any(String),
      relativePath: expect.stringMatching(/^embedded-image-/),
    }));
  });

  it('refuses to persist inline media when no project directory is available', async () => {
    mocks.getProjectDataDir.mockResolvedValue(null);
    const projectId = `project-no-directory-${Date.now()}`;

    await expect(saveProject({
      id: projectId,
      name: 'No directory',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{ id: 'inline-node', data: { imageUrl: 'data:image/png;base64,AQID' } }],
      edges: [],
    })).rejects.toThrow('没有项目目录');
    await expect(getProjectById(projectId)).resolves.toBeUndefined();
  });

  it('只有成片快照含临时媒体且无项目目录时拒绝保存', async () => {
    mocks.getProjectDataDir.mockResolvedValue(null);
    const projectId = `project-shot-video-no-directory-${Date.now()}`;
    await expect(saveProject({ id: projectId, name: '临时成片', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'sheet', data: { type: 'ai-shotlist', shotlistRows: [{ id: 'shot-1', shotNo: '1',
        video: { nodeId: 'source', kind: 'video', url: 'data:video/mp4;base64,BwgJ' },
      }] } }],
    })).rejects.toThrow('没有项目目录');
    await expect(getProjectById(projectId)).resolves.toBeUndefined();
  });

  it('persists the last successfully opened project in metadata', async () => {
    const projectId = `project-active-${Date.now()}`;

    await setLastActiveProjectId(projectId);

    await expect(getLastActiveProjectId()).resolves.toBe(projectId);
  });
});
