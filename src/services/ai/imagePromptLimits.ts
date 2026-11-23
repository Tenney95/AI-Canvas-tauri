import { t } from '../../i18n';
import type { ImageModelCapability } from '../../types/aiTypes';

type PromptLimits = Pick<ImageModelCapability, 'promptMaxCharacters' | 'promptMaxNonAsciiCharacters'>;

function limitToPublished(configured: number | undefined, published: number | undefined): number | undefined {
  if (published === undefined) return configured;
  if (configured === undefined || !Number.isSafeInteger(configured) || configured < 1) return published;
  return Math.min(configured, published);
}

/** 已核实的合同为硬约束。连接设置可以缩小预算。 */
export function resolveEffectivePromptLimits(published: PromptLimits, configured?: PromptLimits): PromptLimits {
  const promptMaxCharacters = limitToPublished(configured?.promptMaxCharacters, published.promptMaxCharacters);
  const nonAsciiMaximum = limitToPublished(configured?.promptMaxNonAsciiCharacters, published.promptMaxNonAsciiCharacters);
  return {
    promptMaxCharacters,
    promptMaxNonAsciiCharacters: nonAsciiMaximum === undefined || promptMaxCharacters === undefined
      ? nonAsciiMaximum : Math.min(nonAsciiMaximum, promptMaxCharacters),
  };
}

export function imagePromptCharacterLimit(modelId: string, preset?: string, providerId?: string,
  capability?: PromptLimits,
  prompt?: string): number | undefined {
  const maximum = capability?.promptMaxCharacters ?? (/^gpt-image-\d/i.test(modelId) || preset === 'openai-gpt-image' || preset === 'gpt-image-gateway-json'
    || providerId === 'aigc-si' && /^image-2(?:[.-]|$)/i.test(modelId) ? 32_000 : undefined);
  const nonAsciiMaximum = capability?.promptMaxNonAsciiCharacters;
  if (maximum === undefined || nonAsciiMaximum === undefined || prompt === undefined) return maximum;
  return mixedPromptPrefixLimit(prompt, maximum, nonAsciiMaximum);
}

export function mixedPromptPrefixLimit(prompt: string, maximum: number, nonAsciiMaximum: number): number {
  // 返回可保留前缀的长度，复用用户明确确认的超限处理；不会自动截断提交。
  let ascii = 0;
  let nonAscii = 0;
  let length = 0;
  for (let index = 0; index < prompt.length; index += 1) {
    const point = prompt.codePointAt(index)!;
    if (point <= 0x7f) ascii += 1;
    else nonAscii += 1;
    if (point > 0xffff) index += 1;
    if (ascii * nonAsciiMaximum + nonAscii * maximum > maximum * nonAsciiMaximum) return length;
    length += 1;
  }
  return Math.max(maximum, length);
}

export function imagePromptCharacterCount(prompt: string): number {
  let count = prompt.length;
  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt.codePointAt(index)! > 0xffff) {
      count -= 1;
      index += 1;
    }
  }
  return count;
}

export function truncateImagePrompt(prompt: string, maxCharacters: number): string {
  const limit = Math.max(0, Math.trunc(maxCharacters) || 0);
  let end = 0;
  for (let count = 0; count < limit && end < prompt.length; count += 1) {
    end += prompt.codePointAt(end)! > 0xffff ? 2 : 1;
  }
  return prompt.slice(0, end);
}

export class ImagePromptOverflowError extends Error {
  readonly modelId: string;
  readonly prompt: string;
  readonly characters: number;
  readonly maxCharacters: number;
  readonly inputCharacters: number;

  constructor(modelId: string, prompt: string, maxCharacters: number,
    inputCharacters = imagePromptCharacterCount(prompt)) {
    const characters = imagePromptCharacterCount(prompt);
    super(t('图片提示词共 {count} 字符，上限 {limit}，超出 {excess}。请精简正文、文本引用或项目附加提示词后重试。', {
      count: characters, limit: maxCharacters, excess: characters - maxCharacters,
    }));
    this.name = 'ImagePromptOverflowError';
    this.modelId = modelId;
    this.prompt = prompt;
    this.characters = characters;
    this.maxCharacters = maxCharacters;
    this.inputCharacters = inputCharacters;
    Object.defineProperty(this, 'prompt', { enumerable: false });
  }
}

export function assertImagePromptLength(modelId: string, prompt: string, maxCharacters?: number, inputCharacters?: number): void {
  if (maxCharacters !== undefined && imagePromptCharacterCount(prompt) > maxCharacters) {
    throw new ImagePromptOverflowError(modelId, prompt, maxCharacters, inputCharacters);
  }
}
