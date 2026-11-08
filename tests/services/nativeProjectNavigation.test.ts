import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ selection: vi.fn(), shared: vi.fn(), episode: vi.fn() }));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', () => ({
  readNativeProjectSelection: mocks.selection,
  readNativeProjectContent: mocks.shared,
  readNativeEpisodeContent: mocks.episode,
}));

import { readNativeProjectView } from '../../src/services/nativeProjectNavigation';

const project = { id: 'project', epoch: 3 };
const selectedEpisode = { id: 'episode', revision: 2 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.selection.mockResolvedValue({ project, episode: selectedEpisode, canvas: { id: 'canvas' }, changeRevision: 7 });
  mocks.shared.mockResolvedValue({ project, content: { script: '共享稿' }, changeRevision: 7 });
  mocks.episode.mockResolvedValue({ project, episode: selectedEpisode, content: { script: '本集稿' }, changeRevision: 7 });
});

describe('新项目单画布视图', () => {
  it('组合相同提交的共享资料与当前分集正文', async () => {
    const view = await readNativeProjectView('project', 'canvas');
    expect(view).toMatchObject({ selection: { canvas: { id: 'canvas' } }, content: { script: '共享稿' },
      episodeContent: { script: '本集稿' } });
    expect(mocks.episode).toHaveBeenCalledWith('project', 'episode', {});
  });

  it('零集剧集不伪造画布或分集正文', async () => {
    mocks.selection.mockResolvedValue({ project, episode: null, canvas: null, changeRevision: 7 });
    expect(await readNativeProjectView('project')).toMatchObject({ selection: { canvas: null }, episodeContent: null });
    expect(mocks.episode).not.toHaveBeenCalled();
  });

  it('任何读取结果属于不同提交时拒绝混合内容', async () => {
    mocks.shared.mockResolvedValueOnce({ project, content: {}, changeRevision: 8 });
    await expect(readNativeProjectView('project')).rejects.toThrow('打开期间发生变化');
    mocks.episode.mockResolvedValueOnce({ project, episode: { ...selectedEpisode, revision: 3 }, content: {}, changeRevision: 7 });
    await expect(readNativeProjectView('project')).rejects.toThrow('打开期间发生变化');
  });
});
