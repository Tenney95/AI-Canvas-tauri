import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(async () => true),
  identifyAsset: vi.fn(),
  walkDirectoryFiles: vi.fn(),
  writeFile: vi.fn(),
  notifyProjectDiskChanged: vi.fn(),
  resolveUniqueDestPath: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({ exists: mocks.exists, writeFile: mocks.writeFile }));
vi.mock('../../src/services/fs/core', () => ({
  buildNodeFileName: (label: string | undefined, ext: string, fallback: string) => `${label || fallback}${ext}`,
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`),
  getProjectDataDir: vi.fn(async () => '/project/data'),
  joinPath: (...parts: string[]) => parts.join('/'),
  notifyProjectDiskChanged: mocks.notifyProjectDiskChanged,
  resolveUniqueDestPath: mocks.resolveUniqueDestPath,
  stripVerbatimPrefix: (path: string) => path,
}));
vi.mock('../../src/services/fs/assetLibrary', () => ({
  walkDirectoryFiles: mocks.walkDirectoryFiles,
}));
vi.mock('../../src/services/fs/assetIndex', () => ({
  identifyAsset: mocks.identifyAsset,
  resolveIndexedAssetPath: vi.fn(async () => null),
}));

import {
  getLastActiveProjectId,
  getProjectById,
  saveProjectToDb,
  setLastActiveProjectId,
} from '../../src/services/indexedDbService';
import { loadProjectData, saveProject } from '../../src/services/storageService';

describe('project loading tolerates asset recovery failures', () => {
  beforeEach(() => {
    mocks.exists.mockResolvedValue(true);
    mocks.identifyAsset.mockRejectedValue(new Error('asset index unavailable'));
    mocks.walkDirectoryFiles.mockRejectedValue(new Error('directory scan unavailable'));
    mocks.resolveUniqueDestPath.mockImplementation(async (dir: string, name: string) => `${dir}/${name}`);
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

    expect(mocks.walkDirectoryFiles).not.toHaveBeenCalled();
    expect(mocks.identifyAsset).not.toHaveBeenCalled();
    expect((loaded?.nodes as Array<{ data: { filePath?: string } }>)[0].data.filePath)
      .toBe('/project/data/saved.png');
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

  it('moves legacy inline generated media to a project file before saving', async () => {
    mocks.identifyAsset.mockResolvedValue({
      assetId: 'asset-generated',
      relativePath: '自定义接口图片.png',
    });
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

    expect(mocks.writeFile).toHaveBeenCalledWith(
      '/project/data/自定义接口图片.png',
      new Uint8Array([1, 2, 3]),
    );
    const record = await getProjectById(projectId) as { nodes: Array<{ data: Record<string, unknown> }> };
    expect(record.nodes[0].data).toMatchObject({
      assetId: 'asset-generated',
      relativePath: '自定义接口图片.png',
      imageUrl: 'asset:///project/data/自定义接口图片.png',
      sourceUrl: 'asset:///project/data/自定义接口图片.png',
      thumbnailUrl: 'asset:///project/data/自定义接口图片.png',
      output: 'asset:///project/data/自定义接口图片.png',
    });
    expect(record.nodes[0].data).not.toHaveProperty('filePath');
    expect(JSON.stringify(record.nodes[0])).not.toContain('data:image');
  });

  it('automatically migrates inline media when an existing project is loaded', async () => {
    mocks.identifyAsset.mockResolvedValue({
      assetId: 'asset-loaded',
      relativePath: '旧生成视频.mp4',
    });
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

    expect(mocks.writeFile).toHaveBeenCalledWith(
      '/project/data/旧生成视频.mp4',
      new Uint8Array([1, 2, 3]),
    );
    expect((loaded?.nodes as Array<{ data: Record<string, unknown> }>)[0].data).toMatchObject({
      filePath: '/project/data/旧生成视频.mp4',
      videoUrl: 'asset:///project/data/旧生成视频.mp4',
      sourceUrl: 'asset:///project/data/旧生成视频.mp4',
      output: 'asset:///project/data/旧生成视频.mp4',
    });
    expect(JSON.stringify(stored.nodes[0])).not.toContain('data:video');
  });

  it('persists the last successfully opened project in metadata', async () => {
    const projectId = `project-active-${Date.now()}`;

    await setLastActiveProjectId(projectId);

    await expect(getLastActiveProjectId()).resolves.toBe(projectId);
  });
});
