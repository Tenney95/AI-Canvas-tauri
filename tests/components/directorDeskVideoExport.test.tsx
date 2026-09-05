import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BaseNodeData, DirectorResultManifestReference } from '../../src/types';

// 沿用节点交互测试的 Hook driver；Store、历史和派生守卫使用真实实现。
const hooks = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    memo: <T,>(component: T) => component,
    useCallback: <T,>(callback: T) => callback,
    useMemo: <T,>(factory: () => T) => factory(),
    useEffect: () => undefined,
    useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
    useRef: <T,>(value: T) => {
      const index = hooks.index++;
      hooks.values[index] ??= { current: value };
      return hooks.values[index];
    },
    useState: <T,>(initialValue: T) => {
      const index = hooks.index++;
      if (!(index in hooks.values)) hooks.values[index] = initialValue;
      return [hooks.values[index], (value: T) => { hooks.values[index] = value; }];
    },
  };
});

vi.mock('../../src/store/useAppStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/useAppStore')>();
  return {
    ...actual,
    useAppStore: Object.assign(
      <T,>(selector: (state: ReturnType<typeof actual.useAppStore.getState>) => T) => (
        selector(actual.useAppStore.getState())
      ),
      actual.useAppStore,
    ),
  };
});

vi.mock('../../src/components/nodes/shared/useNodeRename', () => ({
  useNodeRename: (_id: string, data: BaseNodeData) => ({
    displayLabel: data.label,
    handleRename: vi.fn(),
  }),
}));
vi.mock('../../src/services/directorSceneService', () => ({
  loadDirectorScene: vi.fn(),
  saveDirectorScene: vi.fn(),
}));
vi.mock('../../src/services/directorRuntimeRegistry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/directorRuntimeRegistry')>(),
  exportDirectorRuntimeVideo: vi.fn(),
  getDirectorRuntimeAvailability: vi.fn(),
}));
vi.mock('../../src/services/fileService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fileService')>(),
  saveDataUrlToProjectData: vi.fn(),
}));

import DirectorDeskNode from '../../src/components/nodes/DirectorDeskNode';
import { useAppStore } from '../../src/store/useAppStore';
import { createDefaultDirectorScene } from '../../src/services/directorBlenderRuntimeService';
import { loadDirectorScene } from '../../src/services/directorSceneService';
import {
  exportDirectorRuntimeVideo,
  getDirectorRuntimeAvailability,
  type DirectorRuntimeVideoResult,
} from '../../src/services/directorRuntimeRegistry';
import {
  buildDirectorResultManifestRelativePath,
  buildDirectorSceneRelativePath,
} from '../../src/services/directorSceneSchema';
import { saveDataUrlToProjectData } from '../../src/services/fileService';
import { collectNodeFileReferences } from '../../src/services/fs/trash';
import { resetDirectorNodeOperationsForTests, startDirectorNodeOperation } from '../../src/services/directorNodeOperationService';

const scene = createDefaultDirectorScene('director-1');
const sceneHash = 'a'.repeat(64);
const sceneReference = {
  schemaVersion: 1 as const,
  sceneId: scene.sceneId,
  revision: scene.revision,
  relativePath: buildDirectorSceneRelativePath(scene.sceneId, scene.revision, sceneHash),
  sha256: sceneHash,
  bytes: 512,
};
const manifestHash = 'b'.repeat(64);
const manifestReference: DirectorResultManifestReference = {
  schemaVersion: 1,
  sceneId: scene.sceneId,
  sceneRevision: scene.revision,
  sceneSha256: sceneHash,
  manifestRevision: 1,
  relativePath: buildDirectorResultManifestRelativePath(scene.sceneId, 1, manifestHash),
  sha256: manifestHash,
  bytes: 768,
};
const videoResult: DirectorRuntimeVideoResult = {
  mediaUrl: 'asset://director-reference.mp4',
  filePath: `/project/director/scenes/${scene.sceneId}/results/reference.mp4`,
  fileName: 'reference.mp4',
  manifestReference,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function renderNode() {
  hooks.index = 0;
  const node = useAppStore.getState().nodes.find((item) => item.id === 'director-1')!;
  return (DirectorDeskNode as unknown as (props: {
    id: string;
    data: BaseNodeData;
  }) => ReactElement)({ id: node.id, data: node.data });
}

function button(label: string) {
  const pending: unknown[] = [renderNode()];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value && typeof value === 'object' && 'props' in value) {
      const element = value as ReactElement<{
        children?: unknown;
        'aria-label'?: string;
        disabled?: boolean;
        onClick: () => void;
      }>;
      if (element.type === 'button'
        && (element.props['aria-label'] === label || element.props.children === label)) {
        return element.props;
      }
      pending.push(element.props.children);
    }
  }
  throw new Error(`Button not found: ${label}`);
}

const videoNodes = () => useAppStore.getState().nodes.filter((node) => node.type === 'ai-video');

beforeEach(() => {
  resetDirectorNodeOperationsForTests();
  hooks.index = 0;
  hooks.values = [];
  vi.resetAllMocks();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-a',
    nodes: [{
      id: 'director-1',
      type: 'ai-director',
      position: { x: 100, y: 80 },
      data: {
        type: 'ai-director',
        label: '3D 导演台',
        displayId: 24,
        directorRuntimeKind: 'blender',
        directorInstanceId: 'director-1',
        directorScene: sceneReference,
        directorStatus: 'ready',
        status: 'success',
        imageUrl: 'asset://camera.png',
        directorCaptureUrls: ['asset://camera.png'],
        nodeWidth: 320,
      },
    }],
    showToast: vi.fn(),
  });
  vi.mocked(loadDirectorScene).mockResolvedValue(scene);
  vi.mocked(getDirectorRuntimeAvailability).mockResolvedValue({ state: 'ready' });
  vi.mocked(exportDirectorRuntimeVideo).mockImplementation(async (_kind, _instanceId, options) => {
    const manifestRevision = (options.blender?.previousManifestReference?.manifestRevision ?? 0) + 1;
    return { ...videoResult, manifestReference: {
      ...manifestReference, manifestRevision,
      relativePath: buildDirectorResultManifestRelativePath(scene.sceneId, manifestRevision, manifestHash),
    } };
  });
});
afterEach(() => { resetDirectorNodeOperationsForTests(); });

describe('Blender director video export', () => {
  it('creates a playable source video on the right and supports undo/redo with one snapshot', async () => {
    const commit = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    button('导出参考视频').onClick();
    await vi.waitFor(() => expect(videoNodes()).toHaveLength(1));

    const output = videoNodes()[0];
    expect(output).toMatchObject({
      position: { x: 460, y: 80 },
      data: {
        type: 'ai-video',
        role: 'source',
        displayId: 25,
        status: 'success',
        videoUrl: videoResult.mediaUrl,
        filePath: videoResult.filePath,
        fileName: videoResult.fileName,
        directorResultManifest: manifestReference,
      },
    });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      imageUrl: 'asset://camera.png',
      directorCaptureUrls: ['asset://camera.png'],
      videoUrl: videoResult.mediaUrl,
      directorResultManifest: manifestReference,
    });
    expect(collectNodeFileReferences(output.data)).toContain(`director-scene:${scene.sceneId}`);
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().getCurrentRevision()).toBe(1);

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(videoNodes()).toHaveLength(0);
    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(videoNodes()).toEqual([output]);
  });

  it('preserves the source group and uses the current position when rendering completes', async () => {
    const pending = deferred<DirectorRuntimeVideoResult>();
    vi.mocked(exportDirectorRuntimeVideo).mockReturnValueOnce(pending.promise);
    button('导出参考视频').onClick();
    await vi.waitFor(() => expect(exportDirectorRuntimeVideo).toHaveBeenCalledOnce());
    useAppStore.setState((state) => ({
      nodes: state.nodes.map((node) => ({ ...node, parentId: 'group-1', position: { x: 20, y: 30 } })),
    }));
    pending.resolve(videoResult);
    await vi.waitFor(() => expect(videoNodes()).toHaveLength(1));
    expect(videoNodes()[0]).toMatchObject({ parentId: 'group-1', position: { x: 380, y: 30 } });
  });

  it('ignores rapid duplicate clicks and permits another export after completion', async () => {
    const pending = deferred<DirectorRuntimeVideoResult>();
    vi.mocked(exportDirectorRuntimeVideo).mockReturnValueOnce(pending.promise);
    const exportButton = button('导出参考视频');
    exportButton.onClick();
    exportButton.onClick();
    await vi.waitFor(() => expect(exportDirectorRuntimeVideo).toHaveBeenCalledOnce());
    expect(loadDirectorScene).toHaveBeenCalledOnce();
    pending.resolve(videoResult);
    await vi.waitFor(() => expect(videoNodes()).toHaveLength(1));
    button('导出参考视频').onClick();
    await vi.waitFor(() => expect(videoNodes()).toHaveLength(2));
    expect(new Set(videoNodes().map((node) => node.id)).size).toBe(2);
  });

  it.each(['project', 'revision', 'node', 'instance', 'scene', 'runtime'] as const)(
    'does not create a node or replace the manifest after the %s binding changes', async (binding) => {
      const pending = deferred<DirectorRuntimeVideoResult>();
      vi.mocked(exportDirectorRuntimeVideo).mockReturnValueOnce(pending.promise);
      button('导出参考视频').onClick();
      await vi.waitFor(() => expect(exportDirectorRuntimeVideo).toHaveBeenCalledOnce());
      const state = useAppStore.getState();
      if (binding === 'project') useAppStore.setState({ currentProjectId: 'project-b' });
      if (binding === 'revision') state.incrementRevision();
      if (binding === 'node') state.setNodes([]);
      if (binding === 'instance') state.updateNodeDataTransient('director-1', { directorInstanceId: 'other' });
      if (binding === 'scene') state.updateNodeDataTransient('director-1', { directorScene: undefined });
      if (binding === 'runtime') state.updateNodeDataTransient('director-1', { directorRuntimeKind: 'lightweight-web' });
      pending.resolve(videoResult);
      await vi.waitFor(() => expect(state.showToast).toHaveBeenCalledWith(
        '画布绑定已变化，Blender 结果未写回节点', 'error',
      ));
      expect(videoNodes()).toHaveLength(0);
      expect(useAppStore.getState().nodes[0]?.data.directorResultManifest).toBeUndefined();
    },
  );

  it('checks the revision again after an asynchronous video save', async () => {
    const saved = deferred<Awaited<ReturnType<typeof saveDataUrlToProjectData>>>();
    vi.mocked(exportDirectorRuntimeVideo).mockResolvedValueOnce({ ...videoResult, mediaUrl: 'data:video/mp4;base64,AAAA' });
    vi.mocked(saveDataUrlToProjectData).mockReturnValueOnce(saved.promise);
    button('导出参考视频').onClick();
    await vi.waitFor(() => expect(saveDataUrlToProjectData).toHaveBeenCalledOnce());
    useAppStore.getState().incrementRevision();
    saved.resolve({ assetUrl: videoResult.mediaUrl, filePath: videoResult.filePath! });
    await vi.waitFor(() => expect(useAppStore.getState().showToast).toHaveBeenCalledWith(
      '画布绑定已变化，Blender 结果未写回节点', 'error',
    ));
    expect(videoNodes()).toHaveLength(0);
  });

  it('does not create a node when a cancelled native job still returns a video', async () => {
    const pending = deferred<DirectorRuntimeVideoResult>();
    vi.mocked(exportDirectorRuntimeVideo).mockReturnValueOnce(pending.promise);
    button('导出参考视频').onClick();
    await vi.waitFor(() => expect(exportDirectorRuntimeVideo).toHaveBeenCalledOnce());
    button('取消任务').onClick();
    expect(vi.mocked(exportDirectorRuntimeVideo).mock.calls[0][2].blender?.signal?.aborted).toBe(true);
    pending.resolve(videoResult);
    await vi.waitFor(() => expect(button('导出参考视频').disabled).toBe(false));
    expect(videoNodes()).toHaveLength(0);
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBeUndefined();
  });

  it('leaves no empty node after an export failure and allows a retry', async () => {
    vi.mocked(exportDirectorRuntimeVideo).mockRejectedValueOnce(new Error('渲染失败'));
    button('导出参考视频').onClick();
    await vi.waitFor(() => expect(useAppStore.getState().showToast).toHaveBeenCalledWith('Blender 操作失败，请检查本机 Blender 运行环境', 'error'));
    expect(videoNodes()).toHaveLength(0);
    button('导出参考视频').onClick();
    await vi.waitFor(() => expect(videoNodes()).toHaveLength(1));
  });

  it('shows and cancels an externally started MCP export through the same UI state and task', async () => {
    const pending = deferred<DirectorRuntimeVideoResult>();
    vi.mocked(exportDirectorRuntimeVideo).mockImplementationOnce((_kind, _instanceId, options) => {
      options.blender?.onStatus?.({ jobId: 'job-external', operation: 'render-video', state: 'running',
        sceneId: scene.sceneId, sceneRevision: scene.revision, createdAtMs: 1, updatedAtMs: 2 });
      return pending.promise;
    });
    await startDirectorNodeOperation({ nodeId: 'director-1', operation: 'render-video' }, {
      source: 'mcp', projectId: 'project-a', conversationId: 'mcp-control-project-a', taskId: 'external-start',
    });
    expect(button('导出参考视频').disabled).toBe(true);
    button('取消任务').onClick();
    expect(vi.mocked(exportDirectorRuntimeVideo).mock.calls[0][2].blender?.signal?.aborted).toBe(true);
    pending.resolve(videoResult);
    await vi.waitFor(() => expect(button('导出参考视频').disabled).toBe(false));
    expect(videoNodes()).toHaveLength(0);
  });
});
