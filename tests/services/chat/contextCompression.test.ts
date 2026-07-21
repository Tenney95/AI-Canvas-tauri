import { describe, expect, it } from 'vitest';
import {
  SUMMARY_REQUIRED_SECTIONS,
  validateConversationSummary,
} from '../../../src/services/chat/contextCompressionService';

function validSummary(extra = ''): string {
  return SUMMARY_REQUIRED_SECTIONS.map((section) => `【${section}】\n${section}内容`).join('\n') + extra;
}

describe('conversation context compression validation', () => {
  it('accepts every required section and preserved anchor', () => {
    const source = '请继续处理 @{node-1:主角}、#3，并参考 @model{image-1|图像} https://example.com/a';
    const summary = `${validSummary()}\n@{node-1:主角} #3 @model{image-1|图像} https://example.com/a`;
    expect(validateConversationSummary(summary, source)).toEqual({
      valid: true,
      missingSections: [],
      missingAnchors: [],
    });
  });

  it('rejects missing sections and dropped anchors', () => {
    const result = validateConversationSummary('【目标与背景】\n目标', '节点 #8');
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('约束与偏好');
    expect(result.missingAnchors).toEqual(['#8']);
  });
});
