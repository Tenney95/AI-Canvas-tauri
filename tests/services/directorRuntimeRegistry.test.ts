import { beforeEach, describe, expect, it, vi } from 'vitest';

type ProtocolMessage = {
  type: string;
  payload?: Record<string, unknown>;
};

const mocks = vi.hoisted(() => ({
  isDirectorDeskRuntimeAvailable: vi.fn(),
  getDirectorDeskRuntimeStatus: vi.fn(),
  openDirectorDeskWindow: vi.fn(),
  requestDirectorWindowAction: vi.fn(),
  subscribeDirectorDeskWindow: vi.fn(),
  getDirectorBlenderAvailability: vi.fn(),
  prepareDirectorBlenderInstallation: vi.fn(),
  runDirectorBlenderOperation: vi.fn(),
}));

vi.mock('../../src/services/directorDeskRuntimeService', () => ({
  isDirectorDeskRuntimeAvailable: mocks.isDirectorDeskRuntimeAvailable,
  getDirectorDeskRuntimeStatus: mocks.getDirectorDeskRuntimeStatus,
}));

vi.mock('../../src/services/directorDeskWindowService', () => ({
  openDirectorDeskWindow: mocks.openDirectorDeskWindow,
  requestDirectorWindowAction: mocks.requestDirectorWindowAction,
  subscribeDirectorDeskWindow: mocks.subscribeDirectorDeskWindow,
}));

vi.mock('../../src/services/directorBlenderRuntimeService', () => ({
  getDirectorBlenderAvailability: mocks.getDirectorBlenderAvailability,
  prepareDirectorBlenderInstallation: mocks.prepareDirectorBlenderInstallation,
  runDirectorBlenderOperation: mocks.runDirectorBlenderOperation,
}));

import {
  BLENDER_RUNTIME_UNAVAILABLE_REASON,
  exportDirectorRuntimeFrame,
  exportDirectorRuntimeVideo,
  getDirectorRuntimeAvailability,
  openDirectorRuntime,
  prepareDirectorRuntime,
  resolveDirectorRuntime,
  subscribeDirectorRuntime,
} from '../../src/services/directorRuntimeRegistry';

const sceneReference = {
  schemaVersion: 1 as const,
  sceneId: 'scene-director-1',
  revision: 1,
  relativePath: 'director/scenes/scene-director-1/revisions/1.json',
  sha256: 'a'.repeat(64),
  bytes: 512,
};

const manifestReference = {
  schemaVersion: 1 as const,
  sceneId: sceneReference.sceneId,
  sceneRevision: sceneReference.revision,
  sceneSha256: sceneReference.sha256,
  manifestRevision: 1,
  relativePath: 'director/results/scene-director-1/manifests/1.json',
  sha256: 'b'.repeat(64),
  bytes: 768,
};

describe('directorRuntimeRegistry', () => {
  let protocolListener: ((message: ProtocolMessage) => void) | null;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    protocolListener = null;
    unsubscribe = vi.fn();
    mocks.isDirectorDeskRuntimeAvailable.mockReturnValue(true);
    mocks.getDirectorDeskRuntimeStatus.mockResolvedValue({ installed: true });
    mocks.openDirectorDeskWindow.mockResolvedValue(undefined);
    mocks.getDirectorBlenderAvailability.mockResolvedValue({ state: 'ready' });
    mocks.prepareDirectorBlenderInstallation.mockResolvedValue({
      installationId: 'blender-installation-1',
    });
    mocks.subscribeDirectorDeskWindow.mockImplementation(
      (_instanceId: string, listener: (message: ProtocolMessage) => void) => {
        protocolListener = listener;
        return unsubscribe;
      },
    );
  });

  it('keeps legacy missing values on the lightweight web runtime', () => {
    for (const value of [undefined, null, '', '   ']) {
      const resolution = resolveDirectorRuntime(value);
      expect(resolution).toMatchObject({
        supported: true,
        kind: 'lightweight-web',
      });
    }
  });

  it('resolves only the two fixed runtime identifiers', () => {
    expect(resolveDirectorRuntime('lightweight-web')).toMatchObject({
      supported: true,
      kind: 'lightweight-web',
    });
    expect(resolveDirectorRuntime('blender')).toMatchObject({
      supported: true,
      kind: 'blender',
      descriptor: {
        label: 'Blender',
        selectable: true,
        capabilities: { open: true, exportFrame: true, exportVideo: true },
      },
    });

    for (const value of ['future-runtime', ' Blender ', 'BLENDER', false, 0, {}, []]) {
      expect(resolveDirectorRuntime(value)).toMatchObject({ supported: false });
    }
  });

  it('reports availability through the selected runtime without cross-calling services', async () => {
    mocks.isDirectorDeskRuntimeAvailable.mockReturnValue(false);
    await expect(getDirectorRuntimeAvailability(undefined)).resolves.toEqual({
      state: 'unavailable',
      reason: '3D 导演台独立窗口仅支持 Tauri 桌面端',
    });

    mocks.isDirectorDeskRuntimeAvailable.mockReturnValue(true);
    mocks.getDirectorDeskRuntimeStatus.mockResolvedValueOnce({ installed: false });
    await expect(getDirectorRuntimeAvailability('lightweight-web')).resolves.toEqual({
      state: 'setup-required',
    });
    await expect(getDirectorRuntimeAvailability('lightweight-web')).resolves.toEqual({
      state: 'ready',
    });

    mocks.getDirectorBlenderAvailability.mockResolvedValueOnce({ state: 'setup-required' });
    await expect(getDirectorRuntimeAvailability('blender')).resolves.toEqual({
      state: 'setup-required',
    });
    expect(mocks.getDirectorDeskRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(mocks.getDirectorBlenderAvailability).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    mocks.getDirectorBlenderAvailability.mockResolvedValue({
      state: 'unavailable',
      reason: BLENDER_RUNTIME_UNAVAILABLE_REASON,
    });
    await expect(getDirectorRuntimeAvailability('blender')).resolves.toEqual({
      state: 'unavailable',
      reason: BLENDER_RUNTIME_UNAVAILABLE_REASON,
    });
    expect(mocks.getDirectorBlenderAvailability).toHaveBeenCalledOnce();
    expect(mocks.getDirectorDeskRuntimeStatus).not.toHaveBeenCalled();
  });

  it('forwards lightweight web open, frame, video and subscription semantics', async () => {
    await openDirectorRuntime(undefined, { instanceId: 'director-1', theme: 'light' });
    expect(mocks.openDirectorDeskWindow).toHaveBeenCalledWith({
      instanceId: 'director-1',
      theme: 'light',
    });

    mocks.requestDirectorWindowAction.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,frame',
      fileName: 'frame.png',
    });
    await expect(exportDirectorRuntimeFrame('lightweight-web', 'director-1', {
      position: 'current',
      quality: '1080p',
      fileName: 'requested.png',
    })).resolves.toEqual({
      dataUrl: 'data:image/png;base64,frame',
      fileName: 'frame.png',
    });
    expect(mocks.requestDirectorWindowAction).toHaveBeenLastCalledWith(
      'director-1',
      'export.frame',
      { position: 'current', quality: '1080p', fileName: 'requested.png' },
    );

    mocks.requestDirectorWindowAction.mockResolvedValueOnce({
      blobUrl: 'blob:director-video',
      fileName: 'reference.mp4',
    });
    await expect(exportDirectorRuntimeVideo('lightweight-web', 'director-1', {
      quality: '720p',
      fps: 24,
      fileName: 'requested.mp4',
    })).resolves.toEqual({
      mediaUrl: 'blob:director-video',
      fileName: 'reference.mp4',
    });
    expect(mocks.requestDirectorWindowAction).toHaveBeenLastCalledWith(
      'director-1',
      'export.video',
      { quality: '720p', fps: 24, fileName: 'requested.mp4' },
      90_000,
    );

    const listener = vi.fn();
    const stop = subscribeDirectorRuntime('lightweight-web', 'director-1', listener);
    await vi.waitFor(() => {
      expect(mocks.subscribeDirectorDeskWindow).toHaveBeenCalledWith(
        'director-1',
        expect.any(Function),
      );
    });
    protocolListener?.({ type: 'storyai:director-desk-ready' });
    protocolListener?.({
      type: 'storyai:director-desk-captures-sent',
      payload: {
        captures: [
          { dataUrl: 'data:image/png;base64,capture', fileName: 'capture.png' },
          { dataUrl: 'https://invalid.example/capture.png' },
        ],
      },
    });
    protocolListener?.({ type: 'storyai:director-desk-close' });
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([
      'ready',
      'captures',
      'closed',
    ]);
    expect(listener.mock.calls[1]?.[0]).toEqual({
      type: 'captures',
      captures: [{ dataUrl: 'data:image/png;base64,capture', fileName: 'capture.png' }],
    });
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('preserves saved-scene current-frame requests and returns actual frame metadata', async () => {
    mocks.runDirectorBlenderOperation.mockResolvedValueOnce({
      manifestReference,
      frame: { mediaUrl: 'asset://saved.png', filePath: 'project/saved.png', fileName: 'saved.png', artifact: { frame: 350 } },
    });
    const blender = { projectId: 'project-1', sceneReference, previousManifestReference: manifestReference, sceneSource: 'saved-blender' as const };
    const result = await exportDirectorRuntimeFrame('blender', 'director-1', {
      position: 'current', quality: '1080p', fileName: 'frame.png', blender,
    });
    expect(result.frame).toBe(350);
    expect(mocks.runDirectorBlenderOperation.mock.lastCall?.[0]).toMatchObject({
      sceneSource: 'saved-blender', previousManifestReference: manifestReference, targetFrame: undefined,
    });
  });

  it('routes Blender prepare, open, frame and video operations only to the native service', async () => {
    const controller = new AbortController();
    const onStatus = vi.fn();
    const blender = {
      projectId: 'project-1',
      sceneReference,
      previousManifestReference: manifestReference,
      signal: controller.signal,
      onStatus,
    };

    await prepareDirectorRuntime('blender');
    expect(mocks.prepareDirectorBlenderInstallation).toHaveBeenCalledOnce();

    mocks.runDirectorBlenderOperation.mockResolvedValueOnce({
      manifestReference,
      frame: {
        mediaUrl: 'asset://saved-frame.png',
        filePath: 'project/saved-frame.png',
        fileName: 'saved-frame.png',
        artifact: { frame: 185 },
      },
      blend: {
        mediaUrl: 'asset://director.blend',
        filePath: 'project/director.blend',
        fileName: 'director.blend',
      },
    });
    await expect(openDirectorRuntime('blender', {
      instanceId: 'director-1',
      theme: 'dark',
      blender,
    })).resolves.toEqual({
      manifestReference,
      blendFilePath: 'project/director.blend',
      capture: {
        mediaUrl: 'asset://saved-frame.png',
        filePath: 'project/saved-frame.png',
        fileName: 'saved-frame.png',
        frame: 185,
        manifestReference,
      },
    });
    expect(mocks.runDirectorBlenderOperation).toHaveBeenLastCalledWith({
      operation: 'open-editor',
      projectId: 'project-1',
      directorInstanceId: 'director-1',
      sceneReference,
      previousManifestReference: manifestReference,
    }, {
      signal: controller.signal,
      onStatus,
    });

    mocks.runDirectorBlenderOperation.mockResolvedValueOnce({
      manifestReference,
      blend: {
        mediaUrl: 'asset://director.blend',
        filePath: 'project/director.blend',
        fileName: 'director.blend',
      },
    });
    await expect(openDirectorRuntime('blender', {
      instanceId: 'director-1',
      theme: 'dark',
      blender,
    })).rejects.toThrow('Blender 保存返回未生成当前镜头图');

    mocks.runDirectorBlenderOperation.mockResolvedValueOnce({
      manifestReference,
      frame: {
        mediaUrl: 'asset://frame.png',
        filePath: 'project/frame.png',
        fileName: 'frame.png',
        artifact: { frame: 42 },
      },
    });
    await expect(exportDirectorRuntimeFrame('blender', 'director-1', {
      position: 'current',
      quality: '1080p',
      fileName: 'requested.png',
      targetFrame: 42,
      blender,
    })).resolves.toEqual({
      mediaUrl: 'asset://frame.png',
      filePath: 'project/frame.png',
      fileName: 'frame.png',
      frame: 42,
      manifestReference,
    });
    expect(mocks.runDirectorBlenderOperation).toHaveBeenLastCalledWith({
      operation: 'render-frame',
      projectId: 'project-1',
      directorInstanceId: 'director-1',
      sceneReference,
      previousManifestReference: manifestReference,
      targetFrame: 42,
    }, {
      signal: controller.signal,
      onStatus,
    });

    mocks.runDirectorBlenderOperation.mockResolvedValueOnce({
      manifestReference,
      video: {
        mediaUrl: 'asset://reference.mp4',
        filePath: 'project/reference.mp4',
        fileName: 'reference.mp4',
        artifact: { startFrame: 100, endFrame: 399, fps: 30 / 1.001 },
      },
    });
    await expect(exportDirectorRuntimeVideo('blender', 'director-1', {
      quality: '720p',
      fps: 24,
      fileName: 'requested.mp4',
      blender,
    })).resolves.toEqual({
      mediaUrl: 'asset://reference.mp4',
      filePath: 'project/reference.mp4',
      fileName: 'reference.mp4',
      timeline: { startFrame: 100, endFrame: 399, fps: 30 / 1.001 },
      manifestReference,
    });
    expect(mocks.runDirectorBlenderOperation).toHaveBeenLastCalledWith({
      operation: 'render-video',
      projectId: 'project-1',
      directorInstanceId: 'director-1',
      sceneReference,
      previousManifestReference: manifestReference,
    }, {
      signal: controller.signal,
      onStatus,
    });

    const listener = vi.fn();
    const stop = subscribeDirectorRuntime('blender', 'director-1', listener);
    stop();
    expect(listener).not.toHaveBeenCalled();

    expect(mocks.openDirectorDeskWindow).not.toHaveBeenCalled();
    expect(mocks.requestDirectorWindowAction).not.toHaveBeenCalled();
    expect(mocks.subscribeDirectorDeskWindow).not.toHaveBeenCalled();
    expect(mocks.getDirectorDeskRuntimeStatus).not.toHaveBeenCalled();
  });

  it('fails closed for unknown runtimes without touching either service', async () => {
    await expect(getDirectorRuntimeAvailability('future-runtime')).resolves.toEqual({
      state: 'unavailable',
      reason: '未知 3D 导演运行时，已拒绝自动回退',
    });
    await expect(prepareDirectorRuntime('future-runtime')).rejects.toThrow(
      '未知 3D 导演运行时，已拒绝自动回退',
    );
    await expect(openDirectorRuntime('future-runtime', {
      instanceId: 'director-1',
      theme: 'dark',
    })).rejects.toThrow();
    await expect(exportDirectorRuntimeFrame('future-runtime', 'director-1', {
      position: 'current',
      quality: '1080p',
      fileName: 'frame.png',
    })).rejects.toThrow();
    await expect(exportDirectorRuntimeVideo('future-runtime', 'director-1', {
      quality: '720p',
      fps: 24,
      fileName: 'reference.mp4',
    })).rejects.toThrow();
    const stop = subscribeDirectorRuntime('future-runtime', 'director-1', vi.fn());
    stop();

    expect(mocks.getDirectorBlenderAvailability).not.toHaveBeenCalled();
    expect(mocks.prepareDirectorBlenderInstallation).not.toHaveBeenCalled();
    expect(mocks.runDirectorBlenderOperation).not.toHaveBeenCalled();
    expect(mocks.openDirectorDeskWindow).not.toHaveBeenCalled();
    expect(mocks.requestDirectorWindowAction).not.toHaveBeenCalled();
    expect(mocks.subscribeDirectorDeskWindow).not.toHaveBeenCalled();
    expect(mocks.getDirectorDeskRuntimeStatus).not.toHaveBeenCalled();
  });
});
