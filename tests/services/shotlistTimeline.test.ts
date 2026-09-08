import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const windowMocks = vi.hoisted(() => ({
  openVideoEditorWindow: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/videoEditorWindowService', () => ({
  openVideoEditorWindow: windowMocks.openVideoEditorWindow,
}));

import { getVideoEditorProject } from '../../src/services/indexedDb/videoEditorRepository';
import {
  hasShotlistTimeline,
  openVideoEditorForShotlist,
  resolveShotlistTimelineRows,
} from '../../src/services/videoEditorService';
import { computeTimelineDuration, getActiveClips, getOverlayTracks, getVideoTrack, needsCompositing } from '../../src/types/videoEditor';
import { createShotRow } from '../../src/types/shotlist';
import type { ShotRow } from '../../src/types/shotlist';

// openDB() 在模块级缓存连接，各用例靠独立的 nodeId 保持互不干扰
globalThis.indexedDB = new IDBFactory();

function shot(id: string, overrides: Partial<ShotRow> = {}): ShotRow {
  return { ...createShotRow(id, id), ...overrides };
}

async function pushAndLoad(nodeId: string, rows: ShotRow[]) {
  await openVideoEditorForShotlist({ projectId: 'proj-1', nodeId, label: '第一场', rows });
  const record = await getVideoEditorProject(`proj-1::${nodeId}`);
  return getVideoTrack(record!.tracks)!.clips;
}

beforeEach(() => {
  windowMocks.openVideoEditorWindow.mockClear();
});

describe('分镜表推送时间轴', () => {
  it('绑了图的行按表里的时长出图片片段', async () => {
    const clips = await pushAndLoad('n-image', [
      shot('a', {
        duration: 6,
        frame: { nodeId: 'src-1', kind: 'image', url: 'asset://a.png', filePath: '/data/a.png' },
      }),
    ]);
    expect(clips).toHaveLength(1);
    expect(clips[0].kind).toBe('image');
    expect(clips[0].nodeId).toBe('src-1');
    expect(clips[0].filePath).toBe('/data/a.png');
    // 关键差异：不吃图片固定停留时长，用分镜表填的秒数
    expect(clips[0].sourceOut - clips[0].sourceIn).toBe(6);
  });

  it('绑了视频的行出视频片段', async () => {
    const clips = await pushAndLoad('n-video', [
      shot('a', { duration: 4, frame: { nodeId: 'src-v', kind: 'video', url: 'asset://a.mp4' } }),
    ]);
    expect(clips[0].kind).toBe('video');
    expect(clips[0].sourceUrl).toBe('asset://a.mp4');
  });

  it('没画面但有文字的行出文字占位片段', async () => {
    const clips = await pushAndLoad('n-text', [
      shot('a', { shotNo: '1', shotSize: '全景', content: '警察松动警戒线', duration: 3 }),
    ]);
    expect(clips[0].kind).toBe('text');
    expect(clips[0].textStyle?.content).toContain('警察松动警戒线');
    expect(clips[0].sourceOut - clips[0].sourceIn).toBe(3);
  });

  it('全空的行直接跳过，不占时间轴', async () => {
    const clips = await pushAndLoad('n-blank', [
      shot('a', { content: '有内容', duration: 2 }),
      createShotRow('blank', 2),
      shot('c', { content: '也有内容', duration: 3 }),
    ]);
    expect(clips).toHaveLength(2);
    expect(computeTimelineDuration([{ id: 'v', kind: 'video', name: 'v', clips }])).toBe(5);
  });

  it('片段首尾相接，起点按前面累加', async () => {
    const clips = await pushAndLoad('n-layout', [
      shot('a', { content: '甲', duration: 2 }),
      shot('b', { content: '乙', duration: 3 }),
    ]);
    expect(clips[0].timelineStart).toBe(0);
    expect(clips[1].timelineStart).toBe(2);
  });

  it('转场落在后一个片段上，首镜不带转场', async () => {
    const clips = await pushAndLoad('n-transition', [
      shot('a', { content: '甲', duration: 3, transition: '叠化' }),
      shot('b', { content: '乙', duration: 3, transition: '叠化' }),
      shot('c', { content: '丙', duration: 3, transition: '划像' }),
    ]);
    expect(clips[0].transitionIn).toBeUndefined();
    expect(clips[1].transitionIn?.kind).toBe('dissolve');
    // 剪辑器不支持的写法退成硬切，硬切不写 transitionIn
    expect(clips[2].transitionIn).toBeUndefined();
  });

  it('转场时长不会超过镜头本身', async () => {
    const clips = await pushAndLoad('n-short', [
      shot('a', { content: '甲', duration: 3 }),
      shot('b', { content: '乙', duration: 0.2, transition: '淡入淡出' }),
    ]);
    expect(clips[1].transitionIn?.duration).toBe(0.2);
  });

  it('没有可推的镜头时报错而不是建空工程', async () => {
    await expect(openVideoEditorForShotlist({
      projectId: 'proj-1', nodeId: 'n-empty', label: '空表', rows: [createShotRow('x', 1)],
    })).rejects.toThrow('还没有可推送的镜头');
    expect(await getVideoEditorProject('proj-1::n-empty')).toBeNull();
  });

  it('没有打开项目时拒绝推送', async () => {
    await expect(openVideoEditorForShotlist({
      projectId: '', nodeId: 'n-x', label: '表', rows: [shot('a', { content: '甲' })],
    })).rejects.toThrow('请先打开一个项目');
  });

  it('再次推送按当前表重建，不追加旧片段', async () => {
    const first = await pushAndLoad('n-rebuild', [
      shot('a', { content: '甲', duration: 2 }),
      shot('b', { content: '乙', duration: 2 }),
    ]);
    expect(first).toHaveLength(2);

    const second = await pushAndLoad('n-rebuild', [shot('a', { content: '甲改', duration: 5 })]);
    expect(second).toHaveLength(1);
    expect(second[0].sourceOut - second[0].sourceIn).toBe(5);
  });

  it('推送过的分镜表能被查出来，供覆盖前确认', async () => {
    expect(await hasShotlistTimeline('proj-1', 'n-probe')).toBe(false);
    await pushAndLoad('n-probe', [shot('a', { content: '甲' })]);
    expect(await hasShotlistTimeline('proj-1', 'n-probe')).toBe(true);
  });

  it('推送后打开剪辑窗口', async () => {
    await pushAndLoad('n-open', [shot('a', { content: '甲' })]);
    expect(windowMocks.openVideoEditorWindow).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'proj-1::n-open', nodeId: 'n-open' }),
    );
  });

  it('对白可选、保留无对白镜头空档，文字轨参与预览和合成', async () => {
    const rows = [shot('a', { dialogue: '第一句', duration: 2 }), shot('b', { content: '停顿', duration: 4 }),
      shot('c', { dialogue: '甲：第三句\n乙：回应', duration: 3, transition: '叠化' })];
    await openVideoEditorForShotlist({ projectId: 'proj-1', nodeId: 'n-captions', label: '对白', rows, includeDialogueCaptions: true });
    const record = (await getVideoEditorProject('proj-1::n-captions'))!;
    const overlays = getOverlayTracks(record.tracks);
    expect(overlays).toHaveLength(1);
    expect(needsCompositing(record.tracks)).toBe(true);
    expect(overlays[0].overlay).toBe(true);
    expect(overlays[0].clips.map((clip) => [clip.timelineStart, clip.sourceOut])).toEqual([[0, 2], [6, 3]]);
    expect(getActiveClips(overlays[0], 3)).toEqual([]);
    expect(getActiveClips(overlays[0], 6.1)[0].textStyle?.content).toBe('甲：第三句\n乙：回应');
    expect(overlays[0].clips.every((clip) => clip.transform?.y === 0.88 && !clip.transitionIn)).toBe(true);
    await openVideoEditorForShotlist({ projectId: 'proj-1', nodeId: 'n-captions', label: '对白', rows });
    expect((await getVideoEditorProject('proj-1::n-captions'))!.tracks).toHaveLength(1);
  });

  it('无对白时不创建空字幕轨，也不把音效列当对白', async () => {
    await openVideoEditorForShotlist({ projectId: 'proj-1', nodeId: 'n-no-dialogue', label: '音效',
      rows: [shot('a', { dialogue: '  ', audio: '雷声' })], includeDialogueCaptions: true });
    expect((await getVideoEditorProject('proj-1::n-no-dialogue'))!.tracks).toHaveLength(1);
  });

  it('读取工程后来源过期则不落盘或开窗', async () => {
    const assertCurrent = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('已切项目'); });
    await expect(openVideoEditorForShotlist({ projectId: 'proj-1', nodeId: 'n-stale', label: '旧表',
      rows: [shot('a', { dialogue: '旧对白' })], assertCurrent })).rejects.toThrow('已切项目');
    expect(await getVideoEditorProject('proj-1::n-stale')).toBeNull();
    expect(windowMocks.openVideoEditorWindow).not.toHaveBeenCalled();
  });

  it('画面取实时视频地址，清空后不复用旧成果，删除来源时才退回快照', () => {
    const rows = [shot('a', { frame: { nodeId: 'v', kind: 'video', url: 'old.mp4' } })];
    const latest = resolveShotlistTimelineRows(rows, [{ id: 'v', type: 'ai-video', data: {
      type: 'ai-video', label: '新版', videoUrl: 'new.mp4', thumbnailUrl: 'cover.png', videoDuration: 9,
    } }]);
    expect(latest[0].frame).toMatchObject({ url: 'new.mp4', sourceDuration: 9 });
    expect(resolveShotlistTimelineRows(rows, [{ id: 'v', type: 'ai-video', data: { type: 'ai-video', label: '已清空' } }])[0].frame).toBeNull();
    expect(resolveShotlistTimelineRows(rows, [])[0].frame?.url).toBe('old.mp4');
    expect(rows[0].frame?.url).toBe('old.mp4');
  });
});
