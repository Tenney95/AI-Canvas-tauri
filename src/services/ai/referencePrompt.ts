/**
 * referencePrompt — 将视频参考媒体编译为请求提示词。
 */
import type { MediaReference } from '../../types/aiTypes';
import type { PromptCharacterBinding, PromptMediaReferences } from './promptResolver';
import { getMediaReferenceUrl } from './connectedReferenceMedia';

const CHARACTER_REFERENCE_USAGE: Record<PromptCharacterBinding['usage'], string> = {
  appearance: '外观参考', action: '动作参考', timbre: '音色参考',
  line: '台词参考', emotion: '情绪参考', other: '声音参考',
};

/** 只编译 @ 产生的位置；角色归属独立于媒体去重，以最终传参顺序为准。 */
export function compileVideoReferencePrompt(
  input: PromptMediaReferences,
  references: readonly MediaReference[],
  options: { target?: 'remote' | 'local'; imageLayout?: 'frames-first' | 'frame-fields'; imageLabel?: (ordinal: number) => string } = {},
): string {
  if (!input.segments) return input.prompt;
  const urlOf = (reference: MediaReference) => options.target === 'local'
    ? reference.url.trim() : getMediaReferenceUrl(reference).trim();
  const frame = (reference: MediaReference) => reference.kind === 'image'
    && (reference.role === 'first_frame' || reference.role === 'last_frame');
  const ordered = options.imageLayout === 'frames-first'
    ? [...references.filter(frame), ...references.filter((reference) => !frame(reference))]
    : options.imageLayout === 'frame-fields' ? references.filter((reference) => !frame(reference)) : references;
  const urls = (kind: MediaReference['kind']) => [...new Set(ordered.filter((reference) => reference.kind === kind).map(urlOf))];
  const indexes = { image: urls('image'), video: urls('video'), audio: urls('audio') };
  const characters = new Map<string, { alias: string; name: string; usages: Map<string, Set<string>> }>();
  const prompt = input.segments.map((segment) => {
    if (typeof segment === 'string') return segment;
    const source = segment.reference;
    // 先用本地媒体身份找到去重后的条目，再使用该条目最终选定的远端或本地 URL。
    const reference = references.find((candidate) => candidate.kind === source.kind && candidate.url.trim() === source.url.trim())
      ?? references.find((candidate) => candidate.kind === source.kind && urlOf(candidate) === urlOf(source));
    if (!reference) throw new Error('引用素材未进入视频请求，请重新选择素材');
    const index = indexes[reference.kind].indexOf(urlOf(reference));
    const label = options.imageLayout === 'frame-fields' && frame(reference)
      ? reference.role === 'first_frame' ? '首帧图片' : '尾帧图片'
      : index >= 0 && reference.kind === 'image' && options.imageLabel ? options.imageLabel(index + 1)
        : index >= 0 ? `${reference.kind === 'image' ? '图片' : reference.kind === 'video' ? '视频' : '音频'}${index + 1}` : undefined;
    if (!label) throw new Error('引用素材编号与视频参数不一致');
    if (!segment.character) return label;
    const binding = segment.character;
    let character = characters.get(binding.id);
    if (!character) {
      character = {
        alias: `角色${characters.size + 1}`,
        name: binding.name.replace(/[\r\n\t]+/g, ' ').trim() || '未命名角色',
        usages: new Map(),
      };
      characters.set(binding.id, character);
    }
    const usage = CHARACTER_REFERENCE_USAGE[binding.usage];
    const labels = character.usages.get(usage) ?? new Set<string>();
    labels.add(label);
    character.usages.set(usage, labels);
    return `${character.name}〔${character.alias}，${label}〕`;
  }).join('').trim();
  if (characters.size === 0) return prompt;
  const notes = [...characters.values()].map((character) => {
    const usages = [...character.usages].map(([usage, labels]) => `${usage}：${[...labels].join('、')}`);
    return `- ${character.alias}「${character.name}」：${usages.join('；')}。`;
  });
  const hasVoice = [...characters.values()].some((character) =>
    [...character.usages.keys()].some((usage) => ['音色参考', '台词参考', '情绪参考', '声音参考'].includes(usage)),
  );
  return `${prompt}\n\n角色参考对应：\n${notes.join('\n')}\n各角色的外观、动作和声音按以上对应关系使用，避免互换。`
    + (hasVoice ? '\n音色和情绪样本中的台词不自动作为本次对白；对白内容以正文的明确要求为准。' : '');
}
