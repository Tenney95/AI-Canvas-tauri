import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectorOperationOwner } from '../../src/types/directorOperation';
import { useAppStore } from '../../src/store/useAppStore';
import { createDefaultDirectorScene, type DirectorBlenderJobStatus } from '../../src/services/directorBlenderRuntimeService';
import { loadDirectorScene, saveDirectorScene } from '../../src/services/directorSceneService';
import {
  exportDirectorRuntimeFrame, exportDirectorRuntimeVideo, getDirectorRuntimeAvailability,
  openDirectorRuntime, prepareDirectorRuntime, type DirectorRuntimeBlenderContext,
} from '../../src/services/directorRuntimeRegistry';
import { buildDirectorResultManifestRelativePath, buildDirectorSceneRelativePath } from '../../src/services/directorSceneSchema';
import {
  cancelDirectorOperation, getActiveDirectorNodeOperation, getDirectorNodeState, getDirectorOperation,
  resetDirectorNodeOperationsForTests, setDirectorNodeRuntime, startDirectorNodeOperation,
} from '../../src/services/directorNodeOperationService';
import { saveDataUrlToProjectData } from '../../src/services/fileService';

vi.mock('../../src/services/directorSceneService', () => ({ loadDirectorScene: vi.fn(), saveDirectorScene: vi.fn() }));
vi.mock('../../src/services/directorRuntimeRegistry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/directorRuntimeRegistry')>(),
  exportDirectorRuntimeFrame: vi.fn(), exportDirectorRuntimeVideo: vi.fn(),
  getDirectorRuntimeAvailability: vi.fn(), openDirectorRuntime: vi.fn(), prepareDirectorRuntime: vi.fn(),
}));
vi.mock('../../src/services/fileService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fileService')>(), saveDataUrlToProjectData: vi.fn(),
}));

const owner: DirectorOperationOwner = {
  source: 'mcp', projectId: 'project-a', conversationId: 'mcp-control-project-a', taskId: 'task-start',
};
const uiOwner: DirectorOperationOwner = { source: 'ui', projectId: 'project-a' };
const scene = createDefaultDirectorScene('director-1');
const sceneReference = {
  schemaVersion: 1 as const, sceneId: scene.sceneId, revision: 1, sha256: 'a'.repeat(64), bytes: 512,
  relativePath: buildDirectorSceneRelativePath(scene.sceneId, 1, 'a'.repeat(64)),
};

function manifest(context?: DirectorRuntimeBlenderContext) {
  const revision = (context?.previousManifestReference?.manifestRevision ?? 0) + 1;
  return {
    schemaVersion: 1 as const, sceneId: scene.sceneId, sceneRevision: 1, sceneSha256: sceneReference.sha256,
    manifestRevision: revision, sha256: 'b'.repeat(64), bytes: 768,
    relativePath: buildDirectorResultManifestRelativePath(scene.sceneId, revision, 'b'.repeat(64)),
  };
}

function status(operation: DirectorBlenderJobStatus['operation']): DirectorBlenderJobStatus {
  return { jobId: 'job-native-1', operation, state: 'running', sceneId: scene.sceneId,
    sceneRevision: 1, createdAtMs: 1, updatedAtMs: 2 };
}

function capture(context?: DirectorRuntimeBlenderContext) {
  return { mediaUrl: 'asset://frame.png', filePath: '/private/project/frame.png',
    fileName: 'frame.png', manifestReference: manifest(context) };
}

function opened(context?: DirectorRuntimeBlenderContext) {
  return { blendFilePath: '/private/project/project.blend', manifestReference: manifest(context), capture: capture(context) };
}

function video(context?: DirectorRuntimeBlenderContext) {
  return { mediaUrl: 'asset://reference.mp4', filePath: '/private/project/reference.mp4',
    fileName: 'reference.mp4', manifestReference: manifest(context) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pendingEditor() {
  const pending = deferred<ReturnType<typeof opened>>();
  vi.mocked(openDirectorRuntime).mockImplementationOnce((_kind, request) => {
    request.blender?.onStatus?.(status('open-editor'));
    return pending.promise;
  });
  return pending;
}

const start = () => startDirectorNodeOperation({ nodeId: 'director-1', operation: 'open-editor' }, owner);

beforeEach(() => {
  resetDirectorNodeOperationsForTests();
  vi.resetAllMocks();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-a', showToast: vi.fn(),
    nodes: [{ id: 'director-1', type: 'ai-director', position: { x: 10, y: 20 },
      data: { type: 'ai-director', label: '导演台', directorRuntimeKind: 'blender',
        directorInstanceId: 'director-1', directorScene: sceneReference, status: 'idle' } }],
  });
  vi.mocked(getDirectorRuntimeAvailability).mockResolvedValue({ state: 'ready', supportsSavedScene: true });
  vi.mocked(loadDirectorScene).mockResolvedValue(scene);
  vi.mocked(saveDirectorScene).mockResolvedValue({ scene, reference: sceneReference });
  vi.mocked(openDirectorRuntime).mockImplementation(async (_kind, request) => {
    request.blender?.onStatus?.(status('open-editor'));
    return opened(request.blender);
  });
  vi.mocked(exportDirectorRuntimeFrame).mockImplementation(async (_kind, _instance, options) => {
    options.blender?.onStatus?.(status('render-frame'));
    return capture(options.blender);
  });
  vi.mocked(exportDirectorRuntimeVideo).mockImplementation(async (_kind, _instance, options) => {
    options.blender?.onStatus?.(status('render-video'));
    return video(options.blender);
  });
});
afterEach(() => { resetDirectorNodeOperationsForTests(); });

describe('shared director operation lifecycle', () => {
  it('defaults existing results to the saved scene and keeps its current frame unresolved by old JSON', async () => {
    useAppStore.getState().updateNodeDataTransient('director-1', { directorResultManifest: manifest() });
    expect((await getDirectorNodeState('director-1', owner)).renderContract).toBe('saved-blender');
    const operation = await startDirectorNodeOperation({ nodeId: 'director-1', operation: 'render-frame' }, owner);
    expect(operation.sceneSource).toBe('saved-blender');
    expect(vi.mocked(exportDirectorRuntimeFrame).mock.lastCall?.[2]).toMatchObject({
      targetFrame: undefined, blender: { sceneSource: 'saved-blender' },
    });
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner).state).toBe('succeeded'));
  });

  it('allows saved-scene target frames beyond the portable JSON timeline', async () => {
    useAppStore.getState().updateNodeDataTransient('director-1', { directorResultManifest: manifest() });
    const operation = await startDirectorNodeOperation({ nodeId: 'director-1', operation: 'render-frame', frame: 350 }, owner);
    expect(vi.mocked(exportDirectorRuntimeFrame).mock.lastCall?.[2].targetFrame).toBe(350);
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner).state).toBe('succeeded'));
  });

  it('can explicitly retain Director Scene mode after saving Blender results', async () => {
    useAppStore.getState().updateNodeDataTransient('director-1', { directorResultManifest: manifest() });
    const operation = await startDirectorNodeOperation({ nodeId: 'director-1', operation: 'render-frame', sceneSource: 'director-scene' }, owner);
    expect(operation.sceneSource).toBe('director-scene');
    expect(vi.mocked(exportDirectorRuntimeFrame).mock.lastCall?.[2]).toMatchObject({
      targetFrame: scene.timeline.startFrame, blender: { sceneSource: 'director-scene' },
    });
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner).state).toBe('succeeded'));
  });

  it('fails saved-scene mode without a previous result instead of building a replacement scene', async () => {
    await expect(startDirectorNodeOperation({ nodeId: 'director-1', operation: 'open-editor', sceneSource: 'saved-blender' }, owner))
      .rejects.toMatchObject({ code: 'DIRECTOR_SAVED_SCENE_REQUIRED' });
    expect(openDirectorRuntime).not.toHaveBeenCalled();
    expect(saveDirectorScene).not.toHaveBeenCalled();
  });

  it('keeps existing editor requests compatible with a backend that lacks saved-scene support', async () => {
    useAppStore.getState().updateNodeDataTransient('director-1', { directorResultManifest: manifest() });
    vi.mocked(getDirectorRuntimeAvailability).mockResolvedValue({ state: 'ready' });
    expect(await getDirectorNodeState('director-1', owner)).toMatchObject({
      renderContract: 'director-scene', supportsSavedScene: false,
    });
    const operation = await start();
    expect(operation.sceneSource).toBe('director-scene');
    expect(vi.mocked(openDirectorRuntime).mock.lastCall?.[1].blender?.sceneSource).toBe('director-scene');
  });

  it('reports the desktop upgrade requirement before writing when saved mode is explicit', async () => {
    useAppStore.getState().updateNodeDataTransient('director-1', { directorResultManifest: manifest() });
    vi.mocked(getDirectorRuntimeAvailability).mockResolvedValue({ state: 'ready' });
    await expect(startDirectorNodeOperation({ nodeId: 'director-1', operation: 'open-editor', sceneSource: 'saved-blender' }, owner))
      .rejects.toMatchObject({ code: 'DIRECTOR_DESKTOP_UPDATE_REQUIRED' });
    expect(openDirectorRuntime).not.toHaveBeenCalled();
    expect(saveDirectorScene).not.toHaveBeenCalled();
  });

  it('returns the native video timeline in the safe result snapshot', async () => {
    const timeline = { startFrame: 100, endFrame: 399, fps: 30 / 1.001 };
    vi.mocked(exportDirectorRuntimeVideo).mockImplementationOnce(async (_kind, _instance, options) => ({ ...video(options.blender), timeline }));
    const operation = await startDirectorNodeOperation({ nodeId: 'director-1', operation: 'render-video' }, owner);
    expect(operation.result?.timeline).toEqual(timeline);
    timeline.endFrame = 900;
    expect(getDirectorOperation(operation.operationId, owner).result?.timeline?.endFrame).toBe(399);
  });

  it('returns a native job identity before the editor exits and queries without collecting or writing', async () => {
    const pending = pendingEditor();
    const operation = await start();
    expect(operation).toMatchObject({ state: 'running', jobId: 'job-native-1',
      scene: { sceneId: scene.sceneId, revision: 1, sha256: sceneReference.sha256 } });
    expect(useAppStore.getState().nodes[0].data.directorResultManifest).toBeUndefined();
    const before = useAppStore.getState().getCurrentRevision();
    const queried = getDirectorOperation(operation.operationId, { ...owner, taskId: 'task-query' });
    expect(queried.state).toBe('running');
    expect(JSON.stringify(queried)).not.toMatch(/relativePath|filePath|jobDir|outputDir|asset:|private/);
    expect(useAppStore.getState().getCurrentRevision()).toBe(before);
    expect(saveDirectorScene).not.toHaveBeenCalled();
    pending.resolve(opened());
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner)).toMatchObject({
      state: 'succeeded', result: { hasBlend: true, hasFrame: true, nodeIds: ['director-1'] },
    }));
    expect(useAppStore.getState().nodes[0].data.imageUrl).toBe('asset://frame.png');
  });

  it('detaches the short MCP request signal after acceptance while explicit cancel aborts the job', async () => {
    const pending = pendingEditor();
    const caller = new AbortController();
    const operation = await startDirectorNodeOperation({ nodeId: 'director-1', operation: 'open-editor' }, owner, { signal: caller.signal });
    caller.abort();
    const nativeSignal = vi.mocked(openDirectorRuntime).mock.calls[0][1].blender!.signal!;
    expect(nativeSignal.aborted).toBe(false);
    expect(cancelDirectorOperation(operation.operationId, owner).state).toBe('cancelling');
    expect(nativeSignal.aborted).toBe(true);
    pending.resolve(opened());
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner).state).toBe('cancelled'));
    expect(useAppStore.getState().nodes[0].data.imageUrl).toBeUndefined();
  });

  it('holds the node lock during async preparation, rejecting a racing UI or MCP start', async () => {
    const loading = deferred<typeof scene>();
    vi.mocked(loadDirectorScene).mockReturnValueOnce(loading.promise);
    const first = start();
    await expect(startDirectorNodeOperation({ nodeId: 'director-1', operation: 'render-video' }, uiOwner))
      .rejects.toMatchObject({ code: 'DIRECTOR_BUSY' });
    loading.resolve(scene);
    await first;
    await vi.waitFor(() => expect(getActiveDirectorNodeOperation('director-1')).toBeUndefined());
    expect(loadDirectorScene).toHaveBeenCalledOnce();
  });

  it('allows only one editor session across director nodes and refuses runtime switching while active', async () => {
    const pending = pendingEditor();
    const operation = await start();
    useAppStore.setState((state) => ({ nodes: [...state.nodes, { ...state.nodes[0], id: 'director-2' }] }));
    await expect(startDirectorNodeOperation({ nodeId: 'director-2', operation: 'open-editor' }, owner))
      .rejects.toMatchObject({ code: 'DIRECTOR_BUSY' });
    expect(() => setDirectorNodeRuntime('director-1', 'lightweight-web', uiOwner))
      .toThrow('已有任务');
    cancelDirectorOperation(operation.operationId, owner);
    pending.resolve(opened());
  });

  it('checks project and conversation ownership and allows the main UI to cancel a MCP task', async () => {
    const pending = pendingEditor();
    const operation = await start();
    expect(() => getDirectorOperation(operation.operationId, { ...owner, projectId: 'project-b' }))
      .toThrow('画布绑定');
    const other = { ...owner, conversationId: 'other-conversation' };
    expect(() => getDirectorOperation(operation.operationId, other)).toThrow('不属于');
    expect(() => cancelDirectorOperation(operation.operationId, other)).toThrow('不属于');
    expect(cancelDirectorOperation(operation.operationId, uiOwner).state).toBe('cancelling');
    pending.resolve(opened());
  });

  it('lets the external MCP inspect a director editor opened by the UI', async () => {
    const pending = pendingEditor();
    const operation = await startDirectorNodeOperation({ nodeId: 'director-1', operation: 'open-editor' }, uiOwner);
    expect((await getDirectorNodeState('director-1', owner)).activeOperation?.operationId).toBe(operation.operationId);
    pending.resolve(opened());
  });

  it.each(['project', 'revision', 'node', 'instance', 'scene', 'manifest', 'runtime'] as const)(
    'aborts and refuses results when the %s binding changes, including changes restored before completion', async (binding) => {
      const pending = pendingEditor();
      const operation = await start();
      const previous = useAppStore.getState();
      if (binding === 'project') useAppStore.setState({ currentProjectId: 'project-b' });
      if (binding === 'revision') previous.incrementRevision();
      if (binding === 'node') useAppStore.setState({ nodes: [] });
      if (binding === 'instance') previous.updateNodeDataTransient('director-1', { directorInstanceId: 'changed' });
      if (binding === 'scene') previous.updateNodeDataTransient('director-1', { directorScene: undefined });
      if (binding === 'manifest') previous.updateNodeDataTransient('director-1', { directorResultManifest: manifest() });
      if (binding === 'runtime') previous.updateNodeDataTransient('director-1', { directorRuntimeKind: 'lightweight-web' });
      expect(vi.mocked(openDirectorRuntime).mock.calls[0][1].blender?.signal?.aborted).toBe(true);
      useAppStore.setState({ currentProjectId: 'project-a', nodes: previous.nodes });
      pending.resolve(opened());
      await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner).state).toBe('stale'));
      expect(useAppStore.getState().nodes[0].data.imageUrl).toBeUndefined();
      expect(useAppStore.getState().nodes[0].data.directorResultManifest).toBeUndefined();
    },
  );

  it('fails without a picker when MCP has not selected an installation, including allowSetup=true', async () => {
    vi.mocked(getDirectorRuntimeAvailability).mockResolvedValue({ state: 'setup-required' });
    await expect(startDirectorNodeOperation({ nodeId: 'director-1', operation: 'open-editor' }, owner, { allowSetup: true }))
      .rejects.toMatchObject({ code: 'DIRECTOR_SETUP_REQUIRED' });
    expect(prepareDirectorRuntime).not.toHaveBeenCalled();
    expect(saveDirectorScene).not.toHaveBeenCalled();
    expect(openDirectorRuntime).not.toHaveBeenCalled();
    expect(getActiveDirectorNodeOperation('director-1')).toBeUndefined();
  });

  it('preserves explicit UI installation selection and creates a scene before launch', async () => {
    vi.mocked(getDirectorRuntimeAvailability).mockResolvedValue({ state: 'setup-required' });
    useAppStore.getState().updateNodeDataTransient('director-1', { directorScene: undefined });
    const operation = await startDirectorNodeOperation({ nodeId: 'director-1', operation: 'open-editor' }, uiOwner, { allowSetup: true });
    expect(prepareDirectorRuntime).toHaveBeenCalledWith('blender');
    expect(saveDirectorScene).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, uiOwner).state).toBe('succeeded'));
    expect(useAppStore.getState().nodes[0].data.directorScene).toEqual(sceneReference);
  });

  it('does not adopt a scene or start Blender after cancelled asynchronous preparation', async () => {
    const loading = deferred<typeof scene>();
    vi.mocked(loadDirectorScene).mockReturnValueOnce(loading.promise);
    const controller = new AbortController();
    const starting = startDirectorNodeOperation({ nodeId: 'director-1', operation: 'open-editor' }, owner, { signal: controller.signal });
    const rejection = expect(starting).rejects.toMatchObject({ code: 'DIRECTOR_CANCELLED' });
    await vi.waitFor(() => expect(loadDirectorScene).toHaveBeenCalledOnce());
    controller.abort();
    loading.resolve(scene);
    await rejection;
    expect(openDirectorRuntime).not.toHaveBeenCalled();
  });

  it('rejects a stale proposed revision before any preparation or file write', async () => {
    await expect(startDirectorNodeOperation({ nodeId: 'director-1', operation: 'open-editor' }, owner, { baseRevision: 9 }))
      .rejects.toMatchObject({ code: 'DIRECTOR_CONTEXT_CHANGED' });
    expect(getDirectorRuntimeAvailability).not.toHaveBeenCalled();
  });

  it('does not leak native errors or silently retry failed jobs', async () => {
    const pending = pendingEditor();
    const operation = await start();
    pending.reject(new Error('private credential=secret C:\\private\\job-directory'));
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner).state).toBe('failed'));
    expect(JSON.stringify(getDirectorOperation(operation.operationId, owner))).not.toMatch(/credential|private|secret/);
    expect(openDirectorRuntime).toHaveBeenCalledOnce();
    const retry = await start();
    await vi.waitFor(() => expect(getDirectorOperation(retry.operationId, owner).state).toBe('succeeded'));
  });

  it('returns detached public snapshots and drops old operation IDs when the runtime resets', async () => {
    const pending = pendingEditor();
    const operation = await start();
    operation.scene!.sceneId = 'changed-by-caller';
    expect(getDirectorOperation(operation.operationId, owner).scene?.sceneId).toBe(scene.sceneId);
    pending.resolve(opened());
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner).state).toBe('succeeded'));
    resetDirectorNodeOperationsForTests();
    expect(() => getDirectorOperation(operation.operationId, owner)).toThrow('不属于');
  });
});

describe('director result projection', () => {
  it.each(['job', 'scene', 'operation'] as const)('rejects a mismatched native %s identity before acknowledging the editor', async (field) => {
    vi.mocked(openDirectorRuntime).mockImplementationOnce(async (_kind, request) => {
      const invalid = status('open-editor');
      if (field === 'job') invalid.jobId = '/private/wrong-job';
      if (field === 'scene') invalid.sceneId = 'different-scene';
      if (field === 'operation') invalid.operation = 'render-video';
      request.blender?.onStatus?.(invalid);
      expect(request.blender?.signal?.aborted).toBe(true);
      return opened();
    });
    await expect(start()).rejects.toMatchObject({ code: 'DIRECTOR_INVALID_RESULT' });
    expect(useAppStore.getState().nodes[0].data.imageUrl).toBeUndefined();
  });

  it('creates a playable video source and commits the node plus output in one undo transaction', async () => {
    const history = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    const operation = await startDirectorNodeOperation({ nodeId: 'director-1', operation: 'render-video' }, owner);
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner).state).toBe('succeeded'));
    const result = getDirectorOperation(operation.operationId, owner).result!;
    expect(result.nodeIds).toHaveLength(2);
    expect(useAppStore.getState().nodes[1]).toMatchObject({ type: 'ai-video',
      data: { role: 'source', videoUrl: 'asset://reference.mp4', directorResultManifest: manifest() } });
    expect(history).toHaveBeenCalledOnce();
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().nodes).toHaveLength(1);
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(useAppStore.getState().nodes).toHaveLength(2);
  });

  it('validates explicit frame bounds and uses the chosen frame in the native request', async () => {
    await expect(startDirectorNodeOperation({ nodeId: 'director-1', operation: 'render-frame', frame: scene.timeline.endFrame + 1 }, owner))
      .rejects.toMatchObject({ code: 'DIRECTOR_INVALID_FRAME' });
    expect(exportDirectorRuntimeFrame).not.toHaveBeenCalled();
    const operation = await startDirectorNodeOperation({ nodeId: 'director-1', operation: 'render-frame', frame: scene.timeline.startFrame }, owner);
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner).state).toBe('succeeded'));
    expect(vi.mocked(exportDirectorRuntimeFrame).mock.calls[0][2].targetFrame).toBe(scene.timeline.startFrame);
  });

  it.each(['blend', 'capture', 'manifest'] as const)('does not project an editor result missing %s', async (part) => {
    const pending = pendingEditor();
    const operation = await start();
    const result = opened();
    if (part === 'blend') result.blendFilePath = '';
    if (part === 'capture') result.capture.mediaUrl = '';
    if (part === 'manifest') result.capture.manifestReference.sceneSha256 = 'c'.repeat(64);
    pending.resolve(result);
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner)).toMatchObject({
      state: 'failed', error: { code: 'DIRECTOR_INVALID_RESULT' },
    }));
    expect(useAppStore.getState().nodes[0].data.imageUrl).toBeUndefined();
  });

  it('rechecks bindings after an asynchronous fallback media save', async () => {
    const saving = deferred<Awaited<ReturnType<typeof saveDataUrlToProjectData>>>();
    vi.mocked(saveDataUrlToProjectData).mockReturnValueOnce(saving.promise);
    vi.mocked(exportDirectorRuntimeVideo).mockImplementationOnce(async (_kind, _id, options) => {
      options.blender?.onStatus?.(status('render-video'));
      return { ...video(), mediaUrl: 'data:video/mp4;base64,AAAA' };
    });
    const operation = await startDirectorNodeOperation({ nodeId: 'director-1', operation: 'render-video' }, owner);
    await vi.waitFor(() => expect(saveDataUrlToProjectData).toHaveBeenCalledOnce());
    useAppStore.getState().incrementRevision();
    saving.resolve({ assetUrl: 'asset://saved.mp4', filePath: '/private/saved.mp4' });
    await vi.waitFor(() => expect(getDirectorOperation(operation.operationId, owner).state).toBe('stale'));
    expect(useAppStore.getState().nodes).toHaveLength(1);
  });

  it('reads state without launching, creating a scene, or revealing paths', async () => {
    const result = await getDirectorNodeState('director-1', owner);
    expect(result).toMatchObject({ runtimeKind: 'blender', availability: 'ready', renderContract: 'director-scene' });
    expect(JSON.stringify(result)).not.toMatch(/relativePath|filePath|private/);
    expect(openDirectorRuntime).not.toHaveBeenCalled();
    expect(saveDirectorScene).not.toHaveBeenCalled();
  });
});
