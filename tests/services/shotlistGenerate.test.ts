import { describe, expect, it } from 'vitest';
import {
  buildShotlistGenerationPrompt,
  carryOverShotFrames,
  parseShotlistRows,
} from '../../src/services/shotlistGenerate';
import { DEFAULT_SHOT_DURATION, createShotRow, resolveShotlistColumns } from '../../src/types/shotlist';
import type { ShotRow } from '../../src/types/shotlist';

describe('分镜表出题', () => {
  it('只问表上显示的列，不问画面列', () => {
    const prompt = buildShotlistGenerationPrompt('拆第一集', resolveShotlistColumns(undefined));
    expect(prompt).toContain('拆第一集');
    for (const key of ['shotNo', 'shotSize', 'camera', 'content', 'dialogue', 'duration']) {
      expect(prompt).toContain(key);
    }
    expect(prompt).not.toContain('frame');
    // 默认列没开备注/音效/转场，就不该出现在题面里
    expect(prompt).not.toContain('note');
    expect(prompt).not.toContain('audio');
  });

  it('开了可选列就把它加进题面', () => {
    const prompt = buildShotlistGenerationPrompt('拆第一集', resolveShotlistColumns(['note']));
    expect(prompt).toContain('note');
  });
});

describe('分镜表解析模型回答', () => {
  it('解析 ```json 围栏并按列对号入座', () => {
    const rows = parseShotlistRows(`好的：
\`\`\`json
{"shots":[{"shotNo":"1","shotSize":"全景","camera":"固定","content":"深夜工作室","dialogue":"","duration":4.5}]}
\`\`\``);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shotNo: '1', shotSize: '全景', camera: '固定', content: '深夜工作室', duration: 4.5, frame: null,
    });
    expect(rows[0].id).toMatch(/^shot-/);
  });

  it('缺字段补空、时长非法回退默认值、镜号缺失按序号补', () => {
    const rows = parseShotlistRows('{"shots":[{"content":"A"},{"content":"B","duration":"三秒"}]}');
    expect(rows.map((row) => row.shotNo)).toEqual(['1', '2']);
    expect(rows[0].dialogue).toBe('');
    expect(rows[1].duration).toBe(DEFAULT_SHOT_DURATION);
  });

  it('转场原文照留，编辑器认不出也不抹掉', () => {
    const rows = parseShotlistRows('{"shots":[{"content":"A","transition":"闪白"}]}');
    expect(rows[0].transition).toBe('闪白');
  });

  it('不是 JSON、没有 shots、shots 为空都要抛', () => {
    expect(() => parseShotlistRows('抱歉，我做不到')).toThrow();
    expect(() => parseShotlistRows('{"rows":[{"content":"A"}]}')).toThrow();
    expect(() => parseShotlistRows('{"shots":[]}')).toThrow();
  });
});

describe('重生成接续画面', () => {
  const frame = { nodeId: 'node-1', kind: 'image' as const, url: 'file:///a.png' };

  function row(shotNo: string, overrides: Partial<ShotRow> = {}): ShotRow {
    return { ...createShotRow(`shot-${shotNo}`, shotNo), ...overrides };
  }

  it('镜号相同的行把已绑画面接回去', () => {
    const next = carryOverShotFrames([row('1', { frame }), row('2')], [row('1'), row('2'), row('3')]);
    expect(next[0].frame).toEqual(frame);
    expect(next[1].frame).toBeNull();
    expect(next[2].frame).toBeNull();
  });

  it('镜号对不上就从零开始', () => {
    const next = carryOverShotFrames([row('9', { frame })], [row('1')]);
    expect(next[0].frame).toBeNull();
  });
});
