/** Skill 菜单简介只读投影；不改变正文、Manifest 或工具权限。 */
import type { SkillManifest } from '../../types';
import { parseSkillDocument, stripSkillFrontmatter } from './skillManifest';

interface SkillDescriptionSource {
  content: string;
  fileName: string;
  description?: string;
  manifest?: Pick<SkillManifest, 'description' | 'whenToUse'>;
}

const MAX_DESCRIPTION_CHARS = 160;
const descriptionFields = ['description', 'whenToUse', 'when-to-use', 'summary', 'purpose', '简介', '描述', '说明'] as const;

function readableDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(text) || /^\\?(?:`{3}|~{3})/.test(text)
    || /^[{[]\s*(?:"|$)/.test(text)) return undefined;
  return text.slice(0, MAX_DESCRIPTION_CHARS);
}

/** 仅为显示兼容被 Markdown 转义的分隔符，调用方不能将结果当作执行声明。 */
function displayDocument(source: string): string {
  const normalized = source.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== '\\---') return normalized;
  const end = lines.findIndex((line, index) => index > 0 && ['---', '\\---'].includes(line.trim()));
  if (end < 0) return normalized;
  lines[0] = '---';
  lines[end] = '---';
  return lines.join('\n');
}

function markdownDescription(source: string): string | undefined {
  let fence: string | undefined;
  let heading: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const text = line.trim();
    const marker = /^\\?(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || !text || /^!\[/.test(text)) continue;
    const title = /^#{1,6}\s+(.+)$/.exec(text);
    if (title) { heading ??= readableDescription(title[1]); continue; }
    const prose = readableDescription(text.replace(/^(?:[-*+]\s+|>\s*)/, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
    if (prose) return prose;
  }
  return heading;
}

/** 旧记录中的符号占位简介即时重算；有效已有简介保持优先，缺省回退文件名。 */
export function getSkillDescription(skill: SkillDescriptionSource): string {
  const existing = readableDescription(skill.description)
    ?? readableDescription(skill.manifest?.description)
    ?? readableDescription(skill.manifest?.whenToUse);
  if (existing) return existing;

  const source = displayDocument(skill.content);
  if (/^[{[]/.test(source.trimStart())) {
    try {
      const value: unknown = JSON.parse(source);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        for (const field of descriptionFields) {
          const description = readableDescription(record[field]);
          if (description) return description;
        }
      }
    } catch { /* JSON 没有可读元数据时使用文件名，不把结构行当作简介。 */ }
  } else {
    try {
      const parsed = parseSkillDocument(source);
      const description = readableDescription(parsed.manifest?.description) ?? readableDescription(parsed.manifest?.whenToUse);
      if (description) return description;
    } catch { /* 简介展示不改变执行解析的严格校验结果。 */ }
    const description = markdownDescription(stripSkillFrontmatter(source));
    if (description) return description;
  }
  return readableDescription(skill.fileName) ?? 'Skill';
}
