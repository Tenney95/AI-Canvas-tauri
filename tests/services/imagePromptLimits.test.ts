import { describe, expect, it } from 'vitest';
import { assertImagePromptLength, ImagePromptOverflowError, imagePromptCharacterCount, imagePromptCharacterLimit, truncateImagePrompt } from '../../src/services/ai/imagePromptLimits';

describe('图片提示词长度边界', () => {
  it('接受恰好 32000 字符，并保留服务端报错的实际长度', () => {
    expect(() => assertImagePromptLength('gpt-image-2.6', '图'.repeat(32_000), 32_000)).not.toThrow();
    const prompt = '图'.repeat(38_956);
    const error = (() => {
      try { assertImagePromptLength('gpt-image-2.6', prompt, 32_000, 12); }
      catch (reason) { return reason as ImagePromptOverflowError; }
      throw new Error('Expected overflow');
    })();
    expect(error).toMatchObject({ name: 'ImagePromptOverflowError', characters: 38_956, maxCharacters: 32_000, inputCharacters: 12 });
    expect(error.message).toContain('6956');
    expect(error.message).not.toContain(prompt);
    expect(JSON.stringify(error)).not.toContain(prompt);
  });

  it('按 Unicode 码点计算并裁剪，不拆开表情字符', () => {
    const prompt = '图'.repeat(31_999) + '🎨尾';
    expect(imagePromptCharacterCount(prompt)).toBe(32_001);
    const cropped = truncateImagePrompt(prompt, 32_000);
    expect(cropped.endsWith('🎨')).toBe(true);
    expect(imagePromptCharacterCount(cropped)).toBe(32_000);
    expect(() => assertImagePromptLength('gpt-image-2.6', cropped, 32_000)).not.toThrow();
  });

  it('仅约束 GPT Images 合同，不把限制套到其他模型', () => {
    expect(imagePromptCharacterLimit('gpt-image-2.6-sunburst')).toBe(32_000);
    expect(imagePromptCharacterLimit('custom-id', 'openai-gpt-image')).toBe(32_000);
    expect(imagePromptCharacterLimit('custom-id', 'gpt-image-gateway-json')).toBe(32_000);
    expect(imagePromptCharacterLimit('image-2.6-flare', 'custom', 'aigc-si')).toBe(32_000);
    expect(imagePromptCharacterLimit('image-2.6-flare', 'custom', 'custom-openai')).toBeUndefined();
    expect(imagePromptCharacterLimit('gemini-3-pro-image-preview', 'custom', 'google')).toBeUndefined();
    expect(() => assertImagePromptLength('unknown', '图'.repeat(38_956))).not.toThrow();
  });
});
