import { describe, expect, it } from 'vitest';
import {
  analyzeEpisodeScript,
  buildCreativeFieldPolishPrompt,
  buildEpisodeCreativePrompt,
  buildSplitDraftPrompt,
} from '../../src/services/seriesCreativeService';

describe('seriesCreativeService', () => {
  it('给空正文返回非阻断式创作提示', () => {
    const result = analyzeEpisodeScript('', { targetDurationSec: 90 });

    expect(result.metrics).toEqual({
      characterCount: 0,
      sceneCount: 0,
      dialogueRatio: null,
      estimatedDurationSec: null,
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      id: 'empty-script',
      level: 'info',
    }));
  });

  it('统计场景和对白并定位可确定的格式风险', () => {
    const longDialogue = '你'.repeat(101);
    const script = [
      '1-1 车站 外 夜',
      '人物：林夏、周野',
      `林夏：${longDialogue}`,
      '△她攥紧车票——其实早已知道真相。',
      '1-2 车厢 内 夜',
      '周野：列车不会再回来。',
      '林夏愣住。',
    ].join('\n');

    const result = analyzeEpisodeScript(script, { targetDurationSec: 60 });

    expect(result.metrics.sceneCount).toBe(2);
    expect(result.metrics.characterCount).toBeGreaterThan(100);
    expect(result.diagnostics.map((item) => item.id)).toEqual(expect.arrayContaining([
      'long-dialogue',
      'explanatory-dash',
      'static-ending',
      'target-length',
    ]));
    expect(result.diagnostics.every((item) => !('blocked' in item))).toBe(true);
  });

  it('分集创作请求只生成草案且绑定当前分集', () => {
    const prompt = buildEpisodeCreativePrompt('polish-dialogue', {
      seriesName: '月球列车',
      episodeId: 'ep-2',
      episodeName: '第 2 集',
    });

    expect(prompt).toContain('episodeId: ep-2');
    expect(prompt).toContain('先调用 episode_read');
    expect(prompt).toContain('不要调用任何写入工具');
    expect(prompt).toContain('等待我确认');
  });

  it('拆分请求明确禁止直接创建分集', () => {
    const prompt = buildSplitDraftPrompt({
      seriesName: '月球列车',
      source: 'script',
      targetEpisodeCount: 24,
      targetDurationSec: 90,
      existingEpisodeCount: 2,
    });

    expect(prompt).toContain('目标总集数：24 集');
    expect(prompt).toContain('part=script');
    expect(prompt).toContain('不要调用 series_split_episodes');
    expect(prompt).toContain('尚未覆盖的原文范围');
  });

  it('单字段润色先给候选，确认后只允许精确回写目标字段', () => {
    const prompt = buildCreativeFieldPolishPrompt('openingHook', {
      seriesName: '月球列车',
      episodeId: 'ep-2',
      episodeName: '第 2 集',
    }, true);

    expect(prompt).toContain('“开场钩子”字段');
    expect(prompt).toContain('润色现有');
    expect(prompt).toContain('给出 3 个');
    expect(prompt).toContain('本轮先不要调用写入工具');
    expect(prompt).toContain('episode_update_creative_field');
    expect(prompt).toContain('field=openingHook');
    expect(prompt).toContain('不得改写其他字段');
  });

  it('空情节点字段请求生成三组逐行候选', () => {
    const prompt = buildCreativeFieldPolishPrompt('beats', {
      seriesName: '月球列车',
      episodeId: 'ep-1',
      episodeName: '第 1 集',
    }, false);

    expect(prompt).toContain('生成“主要情节点”');
    expect(prompt).toContain('3 组候选');
    expect(prompt).toContain('field=beats');
  });
});
