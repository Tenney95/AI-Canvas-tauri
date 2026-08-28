import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  downloadUrlAndSave: vi.fn(),
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
vi.mock('../../src/services/fileService', () => ({
  downloadUrlAndSave: mocks.downloadUrlAndSave,
  saveBinaryToProjectData: vi.fn(),
}));

import { runVideoEditorAiTransition } from '../../src/services/videoEditorAiTransitionService';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateVideo.mockResolvedValue({ url: 'https://cdn.example/result.mp4' });
  mocks.downloadUrlAndSave.mockResolvedValue({
    filePath: '/project/result.mp4',
    assetUrl: 'asset://result.mp4',
  });
});

describe('video editor AI transition custom protocols', () => {
  it('does not inject project video defaults into a direct general model', async () => {
    await runVideoEditorAiTransition({
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
    }), undefined);
  });
});
