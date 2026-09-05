import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(async (_path: string) => true),
  getProjectDataDir: vi.fn(async (_projectId: string): Promise<string | null> => '/project/data'),
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
  getProjectDataDir: mocks.getProjectDataDir,
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
    mocks.getProjectDataDir.mockResolvedValue('/project/data');
    mocks.identifyAsset.mockRejectedValue(new Error('asset index unavailable'));
    mocks.walkDirectoryFiles.mockRejectedValue(new Error('directory scan unavailable'));
    mocks.resolveUniqueDestPath.mockImplementation(async (dir: string, name: string) => `${dir}/${name}`);
    mocks.writeFile.mockResolvedValue(undefined);
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

    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    const record = await getProjectById(projectId) as unknown as {
      nodes: Array<{ data: {
        filePath?: string;
        storyboardOverrides: Array<Record<string, unknown>>;
        shotlistRows: Array<{ frame: Record<string, unknown> }>;
        videoReferences: Array<{ url: string }>;
        directorCaptureUrls: string[];
      } }>;
      settings: { visualStyle: { styleReference: Record<string, unknown> } };
    };
    expect(JSON.stringify(record)).not.toContain('data:image');
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

  it('persists the last successfully opened project in metadata', async () => {
    const projectId = `project-active-${Date.now()}`;

    await setLastActiveProjectId(projectId);

    await expect(getLastActiveProjectId()).resolves.toBe(projectId);
  });
});
