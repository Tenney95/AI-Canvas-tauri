import { describe, expect, it } from 'vitest';
import { getSkillDescription } from '../../../src/services/chat/skillDescription';
import { parseSkillDocument } from '../../../src/services/chat/skillManifest';

describe('Skill 菜单简介', () => {
  it('保留有效的已有简介，不用正文覆盖用户记录', () => {
    expect(getSkillDescription({ description: '已有的简短说明', fileName: 'SKILL.md',
      content: '{"description":"正文中的另一段说明"}' })).toBe('已有的简短说明');
  });

  it.each(['description', 'whenToUse', 'when-to-use', 'summary', 'purpose', '简介', '描述', '说明'])(
    '从 JSON 顶层 %s 修复旧记录的括号简介', (field) => {
      const content = JSON.stringify({ name: 'story-planner', [field]: '梳理故事主线与人物动机。' }, null, 2);
      expect(getSkillDescription({ description: '{', content, fileName: 'story.json' })).toBe('梳理故事主线与人物动机。');
      expect(getSkillDescription({ content, fileName: 'story.json' })).toBe('梳理故事主线与人物动机。');
      expect(parseSkillDocument(content)).toEqual({ content });
    },
  );

  it('转义的 Markdown 分隔符仅用于简介展示，不变成权限声明', () => {
    const content = ['\\---', 'name: story-planner', 'description: >', '  梳理故事主线。',
      '  适用于角色动机分析。', 'allowed-tools: [canvas_query]', 'user-invocable: false', '\\---',
      '# 故事规划', '正文保持原样。'].join('\n');
    const skill = { description: '\\---', content, fileName: 'SKILL.md' };

    expect(getSkillDescription(skill)).toBe('梳理故事主线。 适用于角色动机分析。');
    expect(parseSkillDocument(content)).toEqual({ content });
    expect(skill.description).toBe('\\---');
    expect(skill.content).toBe(content);
  });

  it('Markdown 优先使用真实文字，跳过标题、分隔符和代码块', () => {
    expect(getSkillDescription({ description: '```json', fileName: 'SKILL.md', content: [
      '# 标题', '---', '```json', '{"example":"代码示例"}', '```', '', '帮助整理分镜节奏与镜头衔接。',
    ].join('\n') })).toBe('帮助整理分镜节奏与镜头衔接。');
  });

  it.each(['{', '\\---\n---', '```json\n{}\n```', '{"instructions":[]}'])(
    '没有可读简介时回退文件名，不显示结构占位符', (content) => {
      expect(getSkillDescription({ description: '{', content, fileName: '故事规划.json' })).toBe('故事规划.json');
    },
  );

  it('简介压为有界单行，不把长正文放进菜单', () => {
    const description = getSkillDescription({ content: '第一段\n第二段', fileName: 'SKILL.md', description: '说明\n\t'.repeat(100) });
    expect(description).toHaveLength(160);
    expect(description).not.toMatch(/[\r\n\t]/);
  });
});
