import { beforeEach, describe, expect, it } from 'vitest';
import { clearSkillReadTask, createSkillReadBudget, readSkillPage, takeSkillCompactionRequest } from '../../../src/services/chat/skillReadService';
import { estimateTokens } from '../../../src/services/chat/tokenEstimate';

beforeEach(() => clearSkillReadTask('task'));

describe('bounded Skill pages', () => {
  it('reads beyond the old lifetime limit without cutting emoji', () => {
    const text = '中😀文'.repeat(10000);
    let cursor: string | undefined;
    let reconstructed = '';
    do {
      const page = readSkillPage('task', 'SKILL.md', text, { skillId: 'skill', cursor, maxChars: 257 });
      expect(page.content).not.toMatch(/[\uD800-\uDBFF]$/);
      reconstructed += page.content;
      cursor = page.nextCursor;
    } while (cursor);
    expect(reconstructed).toBe(text);
  });
  it('binds cursors to current content, Skill, path and query', () => {
    const input = { skillId: 'a', maxChars: 256 };
    const text = 'long '.repeat(500);
    const cursor = readSkillPage('task', 'ref.md', text, input).nextCursor;
    for (const [path, body, skillId] of [['other.md', text, 'a'], ['ref.md', text + 'change', 'a'], ['ref.md', text, 'b']]) {
      expect(() => readSkillPage('task', path, body, { ...input, skillId, cursor })).toThrow('游标');
    }
  });
  it('deduplicates only the current context and permits explicit rereads', () => {
    const read = (reread = false) => readSkillPage('task', 'SKILL.md', 'useful body', { skillId: 'a', reread });
    expect(read().content).toBe('useful body');
    expect(read()).toMatchObject({ content: '', alreadyRead: true });
    expect(read(true).content).toBe('useful body');
    clearSkillReadTask('task');
    expect(read().content).toBe('useful body');
  });
  it('shares serialized token reservations across parallel reads', async () => {
    const budget = createSkillReadBudget(600);
    const result = await Promise.all(['a', 'b', 'c'].map(async (skillId) => readSkillPage('task', 'ref.md', '中文'.repeat(5000), { skillId }, budget)));
    expect(budget.remainingTokens).toBeGreaterThanOrEqual(0);
    expect(result.some((page) => page.limited)).toBe(true);
    expect(result[0].content.length).toBeLessThan(600);
    expect(estimateTokens(JSON.stringify(result[0]))).toBeLessThanOrEqual(600);
    expect(takeSkillCompactionRequest('task')).toBe(true);
    expect(takeSkillCompactionRequest('task')).toBe(false);
  });
  it('finds a late keyword and returns no body for absent keywords', () => {
    const text = '无关'.repeat(15000) + 'needle 最后规则';
    expect(readSkillPage('task', 'ref.md', text, { skillId: 'a', query: 'needle' }).content).toContain('needle');
    expect(readSkillPage('task', 'ref.md', text, { skillId: 'a', query: 'absent' })).toMatchObject({ content: '', matched: false, complete: true });
  });
});
