/**
 * shotlistTimeline — 回归测试：分镜表推送时间轴。
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const windowMocks = vi.hoisted(() => ({
  openVideoEditorWindow: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/videoEditorWindowService', () => ({
  openVideoEditorWindow: windowMocks.openVideoEditorWindow,
}));

import { getVideoEditorProject } from '../../src/services/indexedDb/videoEditorRepository';
import { openDB, STORE_PROJECTS } from '../../src/services/indexedDb/schema';
import { useAppStore } from '../../src/store/useAppStore';
import {
  hasShotlistTimeline,
  openVideoEditorForShotlist,
  resolveShotlistTimelineRows,
  resolveShotlistVoiceoverNodes,
} from '../../src/services/videoEditorService';
import { computeTimelineDuration, getActiveClips, getOverlayTracks, getVideoTrack, needsCompositing } from '../../src/types/videoEditor';
import { createShotRow } from '../../src/types/shotlist';
import type { ShotRow } from '../../src/types/shotlist';

// openDB() 在模块级缓存连接，各用例靠独立的 nodeId 保持互不干扰
globalThis.indexedDB = new IDBFactory();

function shot(id: string, overrides: Partial<ShotRow> = {}): ShotRow {
  return { ...createShotRow(id, id), video: { nodeId: `video-${id}`, kind: 'video', url: `asset://video-${id}.mp4` }, ...overrides };
}

async function pushAndLoad(nodeId: string, rows: ShotRow[]) {
  await openVideoEditorForShotlist({ projectId: 'proj-1', nodeId, label: '第一场', rows });
  const record = await getVideoEditorProject(`proj-1::${nodeId}`);
  return getVideoTrack(record!.tracks)!.clips;
}

beforeEach(async () => {
  windowMocks.openVideoEditorWindow.mockClear();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'proj-1', projectLoadStatus: 'ready',
    projects: [{ id: 'proj-1', name: '项目', createdAt: 1, updatedAt: 1 }] });
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_PROJECTS, 'readwrite');
    transaction.objectStore(STORE_PROJECTS).put({ id: 'proj-1', name: '项目', createdAt: 1, updatedAt: 1 });
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
});

describe('分镜表推送时间轴', () => {
  it('生成视频按表内时长入轨，画面列的参考图片不进入成片', async () => {
    const clips = await pushAndLoad('n-image', [
      shot('a', {
        duration: 6,
        frame: { nodeId: 'src-1', kind: 'image', url: 'asset://a.png', filePath: '/data/a.png' },
        video: { nodeId: 'generated-1', kind: 'video', url: 'asset://generated.mp4', filePath: '/data/generated.mp4' },
      }),
    ]);
    expect(clips).toHaveLength(1);
    expect(clips[0].kind).toBe('video');
    expect(clips[0].nodeId).toBe('generated-1');
    expect(clips[0].filePath).toBe('/data/generated.mp4');
    expect(clips[0].sourceOut - clips[0].sourceIn).toBe(6);
  });

  it('回填视频的行出视频片段', async () => {
    const clips = await pushAndLoad('n-video', [
      shot('a', { duration: 4, video: { nodeId: 'src-v', kind: 'video', url: 'asset://a.mp4' } }),
    ]);
    expect(clips[0].kind).toBe('video');
    expect(clips[0].sourceUrl).toBe('asset://a.mp4');
  });

  it.each(['image', 'video'] as const)('只有 %s 画面或文字的行跳过，不作成片或文字占位', async (kind) => {
    const clips = await pushAndLoad('n-text', [
      shot('a', { shotNo: '1', shotSize: '全景', content: '警察松动警戒线', duration: 3,
        video: null, frame: { nodeId: 'reference', kind, url: 'asset://reference' } }),
      shot('ready', { duration: 2 }),
    ]);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ kind: 'video', nodeId: 'video-ready', timelineStart: 0, sourceOut: 2 });
    expect(clips[0].textStyle).toBeUndefined();
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
    })).rejects.toThrow('还没有可推送的生成视频');
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

  it('仅装配匹配镜头的已就绪配音，保留时间空档并触发混音导出', async () => {
    const nodes = [{ id: 'voice', type: 'ai-audio', data: { type: 'ai-audio' as const, label: '配音', audioUrl: 'voice.wav',
      shotlistProductionSource: { nodeId: 'n-audio', rowId: 'c', kind: 'voiceover' as const } } },
    { id: 'pending', type: 'ai-audio', data: { type: 'ai-audio' as const, label: '待生成',
      shotlistProductionSource: { nodeId: 'n-audio', rowId: 'a', kind: 'voiceover' as const } } },
    { id: 'unrelated', type: 'source-audio', data: { type: 'source-audio' as const, label: '其他音频', audioUrl: 'other.wav' } }];
    const rows = [shot('a', { content: '甲', duration: 2 }), shot('b', { content: '乙', duration: 4 }), shot('c', { dialogue: '丙', duration: 3 })];
    await openVideoEditorForShotlist({ projectId: 'proj-1', nodeId: 'n-audio', label: '带配音', rows, voiceoverNodes: nodes });
    const record = (await getVideoEditorProject('proj-1::n-audio'))!;
    const audio = record.tracks.find((track) => track.kind === 'audio')!;
    expect(audio.clips).toHaveLength(1);
    expect(audio.clips[0]).toMatchObject({ nodeId: 'voice', sourceUrl: 'voice.wav', timelineStart: 6, sourceOut: 3 });
    expect(audio.overlay).toBe(true);
    expect(record.nodeIds).toContain('voice');
    expect(needsCompositing(record.tracks)).toBe(true);
    expect(resolveShotlistVoiceoverNodes('other-sheet', nodes)).toEqual([]);
  });

  it('零可用配音或同镜头多个来源时明确拒绝，不覆盖旧工程', async () => {
    const rows = [shot('a', { content: '甲' })];
    await pushAndLoad('n-ambiguous-audio', rows);
    const original = await getVideoEditorProject('proj-1::n-ambiguous-audio');
    await expect(openVideoEditorForShotlist({ projectId: 'proj-1', nodeId: 'n-ambiguous-audio', label: '重复', rows, voiceoverNodes: [] })).rejects.toThrow('没有可用配音');
    const voice = { id: 'one', type: 'ai-audio', data: { type: 'ai-audio' as const, label: '配音', audioUrl: 'voice.wav',
      shotlistProductionSource: { nodeId: 'n-ambiguous-audio', rowId: 'a', kind: 'voiceover' as const } } };
    await expect(openVideoEditorForShotlist({ projectId: 'proj-1', nodeId: 'n-ambiguous-audio', label: '重复', rows,
      voiceoverNodes: [voice, { ...voice, id: 'two' }] })).rejects.toThrow('多个配音节点');
    expect(await getVideoEditorProject('proj-1::n-ambiguous-audio')).toEqual(original);
  });

  it('跳过缺视频镜头后主轨、字幕和配音使用同一镜头顺序与时长', async () => {
    const rows = [shot('a', { duration: 2, dialogue: '第一句' }),
      shot('missing', { video: null, duration: 8, dialogue: '没有成片的对白', frame: { nodeId: 'reference', kind: 'image', url: 'reference.png' } }),
      shot('c', { duration: 3, dialogue: '第三句' })];
    const voices = ['missing', 'c'].map((rowId) => ({ id: `voice-${rowId}`, type: 'ai-audio', data: {
      type: 'ai-audio' as const, label: '配音', audioUrl: `${rowId}.wav`,
      shotlistProductionSource: { nodeId: 'n-filtered', rowId, kind: 'voiceover' as const },
    } }));
    await openVideoEditorForShotlist({ projectId: 'proj-1', nodeId: 'n-filtered', label: '仅成片', rows,
      includeDialogueCaptions: true, voiceoverNodes: voices });
    const record = (await getVideoEditorProject('proj-1::n-filtered'))!;
    expect(getVideoTrack(record.tracks)!.clips.map((clip) => [clip.nodeId, clip.timelineStart, clip.sourceOut]))
      .toEqual([['video-a', 0, 2], ['video-c', 2, 3]]);
    const captions = record.tracks.find((track) => track.id === 'shotlist-dialogue')!;
    expect(captions.clips.map((clip) => [clip.textStyle?.content, clip.timelineStart, clip.sourceOut]))
      .toEqual([['第一句', 0, 2], ['第三句', 2, 3]]);
    const audio = record.tracks.find((track) => track.id === 'shotlist-voiceover')!;
    expect(audio.clips).toMatchObject([{ nodeId: 'voice-c', timelineStart: 2, sourceOut: 3 }]);
    expect(record.nodeIds).toEqual(['video-a', 'video-c', 'voice-c']);
  });

  it('所有镜头都缺少回填视频时保留旧工程，不退回画面列的视频', async () => {
    await pushAndLoad('n-no-video-preserve', [shot('ready', { duration: 2 })]);
    const original = await getVideoEditorProject('proj-1::n-no-video-preserve');
    windowMocks.openVideoEditorWindow.mockClear();
    await expect(openVideoEditorForShotlist({ projectId: 'proj-1', nodeId: 'n-no-video-preserve', label: '缺失', rows: [
      shot('old-frame', { video: null, frame: { nodeId: 'old-video', kind: 'video', url: 'old.mp4' }, content: '旧画面视频' }),
      shot('empty-video', { video: { nodeId: 'empty', kind: 'video', url: ' ', filePath: ' ' } }),
    ] })).rejects.toThrow('没有可推送的生成视频');
    expect(await getVideoEditorProject('proj-1::n-no-video-preserve')).toEqual(original);
    expect(windowMocks.openVideoEditorWindow).not.toHaveBeenCalled();
  });

  it('未填计划时长时使用回填视频真实时长，参考画面的旧时长不影响成片', async () => {
    const clips = await pushAndLoad('n-video-duration', [shot('actual', { duration: undefined,
      frame: { nodeId: 'reference', kind: 'video', url: 'reference.mp4', sourceDuration: 99 },
      video: { nodeId: 'result', kind: 'video', url: 'result.mp4', sourceDuration: 4.25 },
    })]);
    expect(clips[0].sourceOut).toBe(4.25);
  });

  it('读取工程后来源过期则不落盘或开窗', async () => {
    const assertCurrent = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('已切项目'); });
    await expect(openVideoEditorForShotlist({ projectId: 'proj-1', nodeId: 'n-stale', label: '旧表',
      rows: [shot('a', { dialogue: '旧对白' })], assertCurrent })).rejects.toThrow('已切项目');
    expect(await getVideoEditorProject('proj-1::n-stale')).toBeNull();
    expect(windowMocks.openVideoEditorWindow).not.toHaveBeenCalled();
  });

  it('回填视频取实时地址，活源清空后不复用旧成果，删除来源时才退回快照', () => {
    const rows = [shot('a', { frame: { nodeId: 'reference', kind: 'image', url: 'reference.png' },
      video: { nodeId: 'v', kind: 'video', url: 'old.mp4' } })];
    const latest = resolveShotlistTimelineRows(rows, [{ id: 'v', type: 'ai-video', data: {
      type: 'ai-video', label: '新版', videoUrl: 'new.mp4', thumbnailUrl: 'cover.png', videoDuration: 9,
    } }]);
    expect(latest[0].video).toMatchObject({ url: 'new.mp4', sourceDuration: 9 });
    expect(latest[0].frame).toBe(rows[0].frame);
    expect(resolveShotlistTimelineRows(rows, [{ id: 'v', type: 'ai-video', data: {
      type: 'ai-video', label: '已清空', videoUrl: '', filePath: '/data/old.mp4',
    } }])).toEqual([]);
    expect(resolveShotlistTimelineRows(rows, [])[0].video?.url).toBe('old.mp4');
    expect(rows[0].video?.url).toBe('old.mp4');
  });

  it('过滤没有回填、空快照及类型已改变的活源，保持有效行顺序供缺镜提示比较', () => {
    const rows = [shot('missing', { video: null }),
      shot('empty', { video: { nodeId: 'empty', kind: 'video' } }),
      shot('wrong', { video: { nodeId: 'retyped', kind: 'video', url: 'old.mp4' } }),
      shot('ready', { video: { nodeId: 'ready', kind: 'video', url: 'saved.mp4' } }),
      shot('deleted', { video: { nodeId: 'gone', kind: 'video', filePath: '/data/saved.mp4' } })];
    const resolved = resolveShotlistTimelineRows(rows, [
      { id: 'retyped', type: 'source-image', data: { type: 'source-image', label: '图片', imageUrl: 'reference.png' } },
      { id: 'ready', type: 'source-video', data: { type: 'source-video', label: '视频', videoUrl: 'current.mp4' } },
    ]);
    expect(resolved.map((row) => row.id)).toEqual(['ready', 'deleted']);
    expect(resolved[0].video?.url).toBe('current.mp4');
    expect(resolved[1].video?.filePath).toBe('/data/saved.mp4');
    expect(rows.filter((row) => !resolved.some((ready) => ready.id === row.id)).map((row) => row.id))
      .toEqual(['missing', 'empty', 'wrong']);
  });
});
