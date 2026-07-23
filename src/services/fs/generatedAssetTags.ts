import { getAllAssetMeta, putAssetMeta } from '../indexedDbService';
import { identifyAsset } from './assetIndex';

const MAX_GENERATED_TAGS = 6;
const MAX_TAG_LENGTH = 20;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'create', 'during', 'for', 'from', 'generate', 'has', 'have', 'in', 'into',
  'is', 'make', 'of', 'on', 'or', 'that', 'the', 'these', 'this', 'those',
  'to', 'under', 'use', 'using', 'was', 'were', 'while', 'with', 'without',
  '一个', '一只', '一张', '一幅', '以及', '了', '从', '以', '使用', '到', '制作',
  '和', '图片', '图像', '在', '场景', '带着', '并且', '把', '戴着', '是', '有',
  '照片', '生成', '画面', '的', '被', '请', '与', '为', '下', '上', '中', '里',
  '创建', '及', '呈现', '展示', '将', '或', '具有', '对', '一',
]);

const HAN_RE = /^\p{Script=Han}+$/u;
const WORD_CONTENT_RE = /[\p{L}\p{N}]/u;
const PURE_NUMBER_RE = /^\p{N}+(?:[.,]\p{N}+)?$/u;

interface PromptWord {
  value: string;
  index: number;
  end: number;
}

function sanitizePrompt(prompt: string): string {
  return prompt
    .replace(/@model\{[^}]*\}/gi, ' ')
    .replace(/@\{[^}]*\}/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ');
}

function normalizeWord(value: string): string {
  const normalized = value
    .trim()
    .replace(/^[\p{P}\p{S}_]+|[\p{P}\p{S}_]+$/gu, '');
  const isAscii = Array.from(normalized).every((character) => character.charCodeAt(0) <= 0x7f);
  return isAscii ? normalized.toLowerCase() : normalized;
}

function isUsableWord(value: string): boolean {
  return Boolean(
    value
      && value.length <= MAX_TAG_LENGTH
      && WORD_CONTENT_RE.test(value)
      && !PURE_NUMBER_RE.test(value)
      && !STOP_WORDS.has(value.toLowerCase()),
  );
}

function segmentPrompt(prompt: string): PromptWord[] {
  const cleanPrompt = sanitizePrompt(prompt);
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    return Array.from(segmenter.segment(cleanPrompt))
      .filter((part) => part.isWordLike)
      .map((part) => ({
        value: normalizeWord(part.segment),
        index: part.index,
        end: part.index + part.segment.length,
      }));
  }

  return Array.from(cleanPrompt.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu), (match) => ({
    value: normalizeWord(match[0]),
    index: match.index,
    end: match.index + match[0].length,
  }));
}

function mergeConciseChineseWords(words: PromptWord[]): string[] {
  const merged: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const current = words[index];
    if (!isUsableWord(current.value)) continue;

    const next = words[index + 1];
    const canMergeHan = next
      && current.end === next.index
      && isUsableWord(next.value)
      && HAN_RE.test(current.value)
      && HAN_RE.test(next.value)
      && (current.value.length === 1 || next.value.length === 1);
    if (canMergeHan) {
      merged.push(`${current.value}${next.value}`);
      index += 1;
      continue;
    }
    merged.push(current.value);
  }
  return merged;
}

/** 从实际生成提示词中提取有限、稳定、可搜索的本地标签。 */
export function extractGeneratedAssetTags(prompt: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const word of mergeConciseChineseWords(segmentPrompt(prompt))) {
    const key = word.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(word);
    if (tags.length >= MAX_GENERATED_TAGS) break;
  }
  return tags;
}

export interface TagGeneratedProjectAssetInput {
  filePath: string;
  projectId: string;
  prompt: string;
}

/** 为新生成且尚无标签的项目资产写入提示词标签。 */
export async function tagGeneratedProjectAsset({
  filePath,
  projectId,
  prompt,
}: TagGeneratedProjectAssetInput): Promise<boolean> {
  const tags = extractGeneratedAssetTags(prompt);
  if (tags.length === 0) return false;

  const identity = await identifyAsset(filePath, { projectId, source: 'project' });
  const existing = (await getAllAssetMeta()).find((meta) => meta.assetId === identity.assetId);
  if (existing?.tags?.length) return false;

  await putAssetMeta({
    ...existing,
    assetId: identity.assetId,
    path: filePath,
    tags,
    updatedAt: Date.now(),
  });
  return true;
}

/** 自动标签是生成后的附加能力，失败不得改变媒体生成结果。 */
export async function tagGeneratedProjectAssetSafely(
  input: TagGeneratedProjectAssetInput,
): Promise<void> {
  try {
    await tagGeneratedProjectAsset(input);
  } catch {
    console.warn('[generatedAssetTags] 自动标签写入失败');
  }
}
