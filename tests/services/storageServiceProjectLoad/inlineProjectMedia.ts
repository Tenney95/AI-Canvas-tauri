import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { getProjectById, saveProjectToDb } from '../../../src/services/indexedDbService';
import {
  loadProjectData,
  restoreProjectRecord,
  saveProject,
  serializeProjectRecord,
  type ProjectSaveData,
} from '../../../src/services/storageService';
import type { BaseNodeData } from '../../../src/types';
import { createNativeProject, readNativeProjectCapture, saveNativeProjectView } from '../../../src/services/indexedDb/nativeProjectRepository';
import type { ProjectLoadMocks } from '../storageServiceProjectLoad.test';

export function registerInlineMediaTests(mocks: ProjectLoadMocks) {
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
      imageUrl: `asset://localhost${writtenPath}`,
      sourceUrl: `asset://localhost${writtenPath}`,
      thumbnailUrl: `asset://localhost${writtenPath}`,
      output: `asset://localhost${writtenPath}`,
    });
    expect(record.nodes[0].data).not.toHaveProperty('filePath');
    expect(JSON.stringify(record.nodes[0])).not.toContain('data:image');
  });

  it.each(['native', 'legacy'] as const)('marks %s inline-mask materialization for directory refresh without making a new autosave input', async (kind) => {
    const sha256 = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
    mocks.notifyProjectDiskChanged.mockClear();
    mocks.getNativeProjectOwner.mockReturnValue(kind === 'native' ? 'native-owner' : undefined);
    mocks.invoke.mockResolvedValue({ relativePath: `media/${sha256}.png`, sha256, bytes: 3, mimeType: 'image/png' });
    mocks.exists.mockResolvedValue(false);
    const record: ProjectSaveData = { id: 'mask-project', name: '遮罩物化', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'source', data: { type: 'ai-image', imageUrl: 'https://example.invalid/source.png', mattingMask: 'data:image/png;base64,AQID' } }] };
    await serializeProjectRecord(record);
    mocks.exists.mockResolvedValue(true);
    await serializeProjectRecord(record);
    expect(mocks.notifyProjectDiskChanged.mock.calls).toEqual(Array.from({ length: kind === 'native' ? 2 : 1 }, () => [
      { source: 'save-materialization', projectId: record.id },
    ]));
    expect(record.nodes).toMatchObject([{ data: { mattingMask: 'data:image/png;base64,AQID' } }]);
  });

  it('新项目扩图垫图独立落盘并可保存重开，不替换结果媒体或增加素材节点', async () => {
    const factory = new IDBFactory();
    const initial = await createNativeProject({ name: '扩图垫图',
      projectId: 'p2-11111111-1111-4111-8111-111111111111', canvasId: 'c2-22222222-2222-4222-8222-222222222222' }, { factory });
    const sha256 = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
    const relativePath = `media/${sha256}.png`;
    mocks.getNativeProjectOwner.mockReturnValue(initial.project.id);
    mocks.nativeSelection.mockResolvedValue({ project: initial.project, canvas: initial.canvas });
    mocks.invoke.mockResolvedValue({ relativePath, sha256, bytes: 3, mimeType: 'image/png' });
    mocks.identifyAsset.mockImplementation(async (path: string) => ({ assetId: 'asset-outpaint',
      relativePath: path.slice('/project/data/'.length) }));
    const record: ProjectSaveData = { id: initial.canvas!.id, name: '扩图垫图', createdAt: 1, updatedAt: 2, edges: [], groups: [],
      nodes: [{ id: 'result', type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image', role: 'generator',
        assetId: 'asset-result', relativePath: 'result.png', imageUrl: 'asset://localhost/project/data/result.png',
        outpaintInput: { url: 'data:image/png;base64,AQID', width: 1024, height: 768 } } }] };
    const original = structuredClone(record);

    const serialized = await serializeProjectRecord(record);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('write_native_project_media', {
      projectId: initial.project.id, mimeType: 'image/png', data: [1, 2, 3],
    });
    expect(serialized.nodes).toMatchObject([{ data: { imageUrl: 'result.png',
      outpaintInput: { assetId: 'asset-outpaint', relativePath, url: relativePath,
        storageRootRef: initial.project.storageRootRef, width: 1024, height: 768 } } }]);
    expect(JSON.stringify(serialized.nodes)).not.toMatch(/data:image|asset:|\/project\/data/);
    expect(record).toEqual(original);
    await saveNativeProjectView({ projectId: initial.project.id, expectedProjectEpoch: initial.project.epoch,
      canvasId: initial.canvas!.id, episodeId: null, expectedCanvasEpoch: initial.canvas!.epoch,
      expectedCanvasRevision: initial.canvas!.revision,
      document: { nodes: serialized.nodes as unknown[], edges: serialized.edges as unknown[], groups: (serialized.groups ?? []) as unknown[] } }, { factory });
    const capture = await readNativeProjectCapture(initial.project.id, { factory });
    const restored = await restoreProjectRecord({ ...serialized, nodes: capture!.aggregate.canvases[0].nodes });
    expect(restored.nodes).toHaveLength(1);
    expect(restored.nodes).toMatchObject([{ data: { imageUrl: 'asset://localhost/project/data/result.png',
      outpaintInput: { assetId: 'asset-outpaint', relativePath,
        url: `asset://localhost/project/data/${relativePath}`, width: 1024, height: 768 } } }]);
    expect(mocks.writeFile).not.toHaveBeenCalled();

    mocks.exists.mockResolvedValue(false);
    const missing = await restoreProjectRecord(serialized);
    expect(missing.nodes).toMatchObject([{ data: { outpaintInput: { assetId: 'asset-outpaint', relativePath,
      url: undefined, width: 1024, height: 768 } } }]);
    expect((await serializeProjectRecord(missing)).nodes).toMatchObject([{ data: { outpaintInput: {
      assetId: 'asset-outpaint', relativePath, url: undefined, width: 1024, height: 768,
    } } }]);
  });

  it('新项目扩图垫图索引失败时拒绝保存本机路径，原输入保留', async () => {
    mocks.getNativeProjectOwner.mockReturnValue('native-owner');
    const rootRef = 'r2-11111111-1111-4111-8111-111111111111';
    mocks.nativeSelection.mockResolvedValue({ project: { id: 'native-owner', storageRootRef: rootRef, storageBindings: [{ rootRef }] },
      canvas: { id: 'native-canvas', storageRootRef: rootRef } });
    const record: ProjectSaveData = { id: 'native-canvas', name: '扩图', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'result', data: { type: 'ai-image', outpaintInput: {
        url: 'asset://localhost/project/data/padding.png', width: 1024, height: 768,
      } } }] };
    const original = structuredClone(record);
    await expect(serializeProjectRecord(record)).rejects.toThrow('扩图垫图未能保存为项目素材');
    expect(record).toEqual(original);
  });

  it('子根画布扩图新垫图绑定作品主根，已存在子根输入保持独立归属，异常根不回退', async () => {
    const primary = 'r2-11111111-1111-4111-8111-111111111111', child = 'r2-33333333-3333-4333-8333-333333333333';
    const unknown = 'r2-44444444-4444-4444-8444-444444444444';
    const sha256 = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
    mocks.getNativeProjectOwner.mockReturnValue('native-owner');
    mocks.nativeSelection.mockResolvedValue({ project: { id: 'native-owner', storageRootRef: primary,
      storageBindings: [{ rootRef: primary }, { rootRef: child }] }, canvas: { id: 'native-canvas', storageRootRef: child } });
    mocks.invoke.mockImplementation(async (command: string) => command === 'resolve_native_project_media_subroot'
      ? `/project/data/roots/${child}` : { relativePath: `media/${sha256}.png`, sha256, bytes: 3, mimeType: 'image/png' });
    mocks.identifyAsset.mockImplementation(async (path: string, options: { rootPath: string }) => ({
      assetId: 'asset-padding', relativePath: path.slice(options.rootPath.length + 1),
    }));
    const record = (outpaintInput: BaseNodeData['outpaintInput']): ProjectSaveData => ({ id: 'native-canvas', name: '子根画布',
      createdAt: 1, updatedAt: 2, edges: [], nodes: [{ id: 'expanded', data: { type: 'ai-image', outpaintInput } }] });
    const fresh = await serializeProjectRecord(record({ url: 'data:image/png;base64,AQID', width: 1024, height: 768 }));
    expect(fresh.nodes).toMatchObject([{ data: { outpaintInput: { relativePath: `media/${sha256}.png`, storageRootRef: primary } } }]);
    expect((await restoreProjectRecord(fresh)).nodes).toMatchObject([{ data: { outpaintInput: {
      url: `asset://localhost/project/data/media/${sha256}.png`, storageRootRef: primary,
    } } }]);

    const existing = await serializeProjectRecord(record({ url: `asset://localhost/project/data/roots/${child}/padding.png`,
      assetId: 'child-padding', relativePath: 'padding.png', storageRootRef: child, width: 1024, height: 768 }));
    expect(existing.nodes).toMatchObject([{ data: { outpaintInput: { assetId: 'child-padding', url: 'padding.png', relativePath: 'padding.png', storageRootRef: child } } }]);
    expect((await restoreProjectRecord(existing)).nodes).toMatchObject([{ data: { outpaintInput: {
      url: `asset://localhost/project/data/roots/${child}/padding.png`, storageRootRef: child,
    } } }]);
    const invalid = record({ url: 'padding.png', relativePath: 'padding.png', storageRootRef: unknown, width: 1024, height: 768 });
    await expect(serializeProjectRecord(invalid)).rejects.toThrow('根不属于该项目');
    expect((await restoreProjectRecord(invalid)).nodes).toMatchObject([{ data: { outpaintInput: { url: undefined, storageRootRef: unknown } } }]);
    expect(mocks.copyFileToProjectData).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('只有扩图垫图含临时媒体且无项目目录时仍拒绝落库', async () => {
    mocks.getProjectDataDir.mockResolvedValue(null);
    const id = `project-outpaint-no-directory-${Date.now()}`;
    await expect(saveProject({ id, name: '扩图', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'result', data: { type: 'ai-image', outpaintInput: {
        url: 'data:image/png;base64,AQID', width: 1024, height: 768,
      } } }],
    })).rejects.toThrow('没有项目目录');
    expect(await getProjectById(id)).toBeUndefined();
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
      videoUrl: `asset://localhost${writtenPath}`,
      sourceUrl: `asset://localhost${writtenPath}`,
      output: `asset://localhost${writtenPath}`,
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
          outpaintInput: { url: second, width: 1024, height: 768 },
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
        outpaintInput: Record<string, unknown>;
        shotlistRows: Array<{ frame: Record<string, unknown>; video: Record<string, unknown> }>;
        videoReferences: Array<{ url: string }>;
        directorCaptureUrls: string[];
      } }>;
      settings: { visualStyle: { styleReference: Record<string, unknown> } };
    };
    expect(JSON.stringify(record)).not.toContain('data:image');
    expect(JSON.stringify(record)).not.toContain('data:video');
    expect(record.nodes[0].data.filePath).not.toBe('/project/data/missing.png');
    expect(record.nodes[0].data.outpaintInput).toMatchObject({ assetId: expect.any(String),
      relativePath: expect.stringMatching(/^embedded-image-/),
      url: expect.stringMatching(/^asset:\/\/localhost\/project\/data\/embedded-image-/), width: 1024, height: 768 });
    expect(record.nodes[0].data.storyboardOverrides[0]).toEqual(expect.objectContaining({
      assetId: expect.any(String),
      relativePath: expect.stringMatching(/^embedded-image-/),
      url: expect.stringMatching(/^asset:\/\/localhost\/project\/data\/embedded-image-/),
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
      .toMatch(/^asset:\/\/localhost\/project\/data\/embedded-image-/);
    expect(record.nodes[0].data.directorCaptureUrls[0])
      .toMatch(/^asset:\/\/localhost\/project\/data\/embedded-image-/);
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
}
