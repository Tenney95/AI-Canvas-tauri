/**
 * videoEditorAiTransitionService — 回归测试：video editor AI transition custom protocols。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  persistMediaUrlToProjectData: vi.fn(),
  pauseMediaTask: vi.fn(),
  storeState: {
    projects: [{
      id: 'project-1',
      settings: {
        generation: {
          videoAspectRatio: '16:9',
          videoResolution: '1080p',
          videoDuration: 10,
        },
      },
    }],
    config: { generalModels: [] },
  },
}));

vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: () => mocks.storeState },
}));
vi.mock('../../src/services/ai/generateVideo', () => ({ generateVideo: mocks.generateVideo }));
vi.mock('../../src/services/pollManager', () => ({ pauseMediaTask: mocks.pauseMediaTask }));
vi.mock('../../src/services/fileService', () => ({
  persistMediaUrlToProjectData: mocks.persistMediaUrlToProjectData,
}));

import { runVideoEditorAiTransition } from '../../src/services/videoEditorAiTransitionService';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateVideo.mockResolvedValue({ url: 'https://cdn.example/result.mp4' });
  mocks.persistMediaUrlToProjectData.mockResolvedValue({
    filePath: '/project/result.mp4',
    assetUrl: 'asset://result.mp4',
    mediaUrl: 'asset://result.mp4',
    sourceUrl: 'https://cdn.example/result.mp4',
  });
});

describe('video editor AI transition custom protocols', () => {
  it('does not inject project video defaults into a direct general model', async () => {
    const outcome = await runVideoEditorAiTransition({
      requestId: 'transition-1',
      prompt: '平滑衔接两个镜头',
      model: 'general/custom-video',
      provider: 'general',
      firstFrameUrl: 'asset://first.png',
      lastFrameUrl: 'asset://last.png',
    }, 'project-1');

    expect(mocks.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      model: 'general/custom-video',
      provider: 'general',
      seedanceRatio: undefined,
      seedanceResolution: undefined,
      seedanceDuration: undefined,
      referenceMedia: [
        expect.objectContaining({ role: 'first_frame', url: 'asset://first.png' }),
        expect.objectContaining({ role: 'last_frame', url: 'asset://last.png' }),
      ],
    }), undefined, undefined);
    // 编辑器建片段用的是落盘后的项目文件，文件名也从真实路径取
    expect(outcome).toMatchObject({
      videoUrl: 'asset://result.mp4',
      filePath: '/project/result.mp4',
      fileName: 'result.mp4',
    });
  });

  it('fails closed instead of handing a temporary media url to the editor', async () => {
    mocks.generateVideo.mockResolvedValue({ url: 'blob:local/transition' });
    mocks.persistMediaUrlToProjectData.mockRejectedValueOnce(new Error('生成媒体未能写入项目目录'));

    await expect(runVideoEditorAiTransition({
      requestId: 'transition-2',
      prompt: '平滑衔接两个镜头',
      model: 'general/custom-video',
      provider: 'general',
      firstFrameUrl: 'asset://first.png',
      lastFrameUrl: 'asset://last.png',
    }, 'project-1')).rejects.toThrow('生成媒体未能写入项目目录');
  });

  it('rechecks the original scope at the real paid submit boundary and never retries', async () => {
    let current = true;
    const assertCurrent = () => { if (!current) throw new Error('原窗口已撤销'); };
    mocks.generateVideo.mockImplementationOnce(async (_params, _signal, beforeSubmit?: () => void) => {
      current = false; beforeSubmit?.(); return { url: 'never' };
    });
    await expect(runVideoEditorAiTransition({ requestId: 'paid-boundary', prompt: '衔接', model: 'general/video', provider: 'general',
      firstFrameUrl: 'asset://first', lastFrameUrl: 'asset://last' }, 'project-1', undefined, assertCurrent)).rejects.toThrow('撤销');
    expect(mocks.generateVideo).toHaveBeenCalledOnce();
    expect(mocks.persistMediaUrlToProjectData).not.toHaveBeenCalled();
  });

  it('retains the exact returned receipt when scope changes and passes original download access when delivered', async () => {
    const taskReceipt = { projectId: 'project-1', nodeId: 'video', taskId: 'original-paid-id', attemptId: 'original-attempt' };
    let current = true;
    const assertCurrent = () => { if (!current) throw new Error('原画布代际变化'); };
    mocks.generateVideo.mockImplementationOnce(async () => { current = false; return { url: 'https://cdn.example/result.mp4', taskReceipt }; });
    const request = { requestId: 'receipt', prompt: '衔接', model: 'general/video', provider: 'general', firstFrameUrl: 'asset://first', lastFrameUrl: 'asset://last' };
    await expect(runVideoEditorAiTransition(request, 'project-1', undefined, assertCurrent)).rejects.toThrow('代际');
    expect(mocks.pauseMediaTask).toHaveBeenCalledWith(taskReceipt, expect.any(Error), 'delivery_pending');
    expect(mocks.persistMediaUrlToProjectData).not.toHaveBeenCalled();
    current = true;
    const mediaDownloadAccess = { providerConfigId: 'original-connection', origin: 'https://cdn.example' };
    mocks.generateVideo.mockResolvedValueOnce({ url: 'https://cdn.example/result.mp4', taskReceipt, mediaDownloadAccess });
    expect((await runVideoEditorAiTransition(request, 'project-1', undefined, assertCurrent)).taskReceipt).toBe(taskReceipt);
    expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledWith('https://cdn.example/result.mp4', 'project-1', 'ai-video',
      expect.any(String), expect.objectContaining({ mediaDownloadAccess, assertCurrent }));
  });
});
