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

import {
  BLENDER_RUNTIME_UNAVAILABLE_REASON,
  exportDirectorRuntimeFrame,
  exportDirectorRuntimeVideo,
  getDirectorRuntimeAvailability,
  openDirectorRuntime,
  resolveDirectorRuntime,
  subscribeDirectorRuntime,
} from '../../src/services/directorRuntimeRegistry';

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
        selectable: false,
        capabilities: { open: false, exportFrame: false, exportVideo: false },
      },
    });

    for (const value of ['future-runtime', ' Blender ', 'BLENDER', false, 0, {}, []]) {
      expect(resolveDirectorRuntime(value)).toMatchObject({ supported: false });
    }
  });

  it('reports desktop setup state only for the lightweight web runtime', async () => {
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

    await expect(getDirectorRuntimeAvailability('blender')).resolves.toEqual({
      state: 'unavailable',
      reason: BLENDER_RUNTIME_UNAVAILABLE_REASON,
    });
    expect(mocks.getDirectorDeskRuntimeStatus).toHaveBeenCalledTimes(2);
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

  it('fails closed for Blender and unknown runtimes without touching web services', async () => {
    for (const runtime of ['blender', 'future-runtime']) {
      await expect(openDirectorRuntime(runtime, {
        instanceId: 'director-1',
        theme: 'dark',
      })).rejects.toThrow();
      await expect(exportDirectorRuntimeFrame(runtime, 'director-1', {
        position: 'current',
        quality: '1080p',
        fileName: 'frame.png',
      })).rejects.toThrow();
      await expect(exportDirectorRuntimeVideo(runtime, 'director-1', {
        quality: '720p',
        fps: 24,
        fileName: 'reference.mp4',
      })).rejects.toThrow();
      const stop = subscribeDirectorRuntime(runtime, 'director-1', vi.fn());
      stop();
    }

    expect(mocks.openDirectorDeskWindow).not.toHaveBeenCalled();
    expect(mocks.requestDirectorWindowAction).not.toHaveBeenCalled();
    expect(mocks.subscribeDirectorDeskWindow).not.toHaveBeenCalled();
    expect(mocks.getDirectorDeskRuntimeStatus).not.toHaveBeenCalled();
  });
});
