import { t } from '../../i18n';

export function imagePromptCharacterLimit(modelId: string, preset?: string, providerId?: string): number | undefined {
  return /^gpt-image-\d/i.test(modelId) || preset === 'openai-gpt-image' || preset === 'gpt-image-gateway-json'
    || providerId === 'aigc-si' && /^image-2(?:[.-]|$)/i.test(modelId) ? 32_000 : undefined;
}

export function imagePromptCharacterCount(prompt: string): number {
  return Array.from(prompt).length;
}

export function truncateImagePrompt(prompt: string, maxCharacters: number): string {
  return Array.from(prompt).slice(0, maxCharacters).join('');
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
