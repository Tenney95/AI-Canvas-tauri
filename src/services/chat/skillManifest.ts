import type { SkillManifest } from '../../types';

const FRONTMATTER_BOUNDARY = '---';
const TOOL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

export interface ParsedSkillDocument {
  manifest?: SkillManifest;
  content: string;
}

function unwrapQuotedValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function parseBoolean(value: string, key: string): boolean {
  const normalized = unwrapQuotedValue(value).toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Skill Manifest 的 ${key} 必须是 true 或 false`);
}

function parseAllowedTools(values: string[]): string[] {
  const tools = values
    .flatMap((value) => {
      const unwrapped = unwrapQuotedValue(value).trim();
      const listValue = unwrapped.startsWith('[') && unwrapped.endsWith(']')
        ? unwrapped.slice(1, -1)
        : unwrapped;
      return listValue.split(',');
    })
    .map(unwrapQuotedValue)
    .filter(Boolean);

  const invalid = tools.find((toolId) => !TOOL_ID_PATTERN.test(toolId));
  if (invalid) {
    throw new Error(`Skill Manifest 包含无效工具 ID: ${invalid}`);
  }
  return [...new Set(tools)];
}

function findFrontmatterEnd(lines: string[]): number {
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === FRONTMATTER_BOUNDARY) return index;
  }
  return -1;
}

/** 只移除文档开头的 frontmatter，不解释或执行其中的任何内容。 */
export function stripSkillFrontmatter(source: string): string {
  const normalized = source.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_BOUNDARY) return normalized;
  const end = findFrontmatterEnd(lines);
  if (end < 0) return normalized;
  return lines.slice(end + 1).join('\n').replace(/^\s+/, '');
}

/**
 * 解析 Skill 入口文件的轻量 Manifest。
 *
 * 仅支持本项目声明的标量字段，以及 allowed-tools 的行内/列表写法；
 * 未知字段会被忽略，避免把 frontmatter 当作可执行配置。
 */
export function parseSkillDocument(source: string): ParsedSkillDocument {
  const normalized = source.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_BOUNDARY) {
    return { content: normalized };
  }

  const end = findFrontmatterEnd(lines);
  if (end < 0) throw new Error('Skill Manifest 缺少结束分隔符 ---');

  const values = new Map<string, string[]>();
  let listKey: string | undefined;
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (listKey && trimmed.startsWith('- ')) {
      values.get(listKey)?.push(trimmed.slice(2).trim());
      continue;
    }

    const separator = line.indexOf(':');
    if (separator < 1) {
      throw new Error(`Skill Manifest 第 ${index + 1} 行格式无效`);
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    values.set(key, value ? [value] : []);
    listKey = value ? undefined : key;
  }

  const scalar = (key: string): string | undefined => {
    const value = values.get(key)?.[0];
    if (value == null || value === '') return undefined;
    return unwrapQuotedValue(value);
  };
  const manifest: SkillManifest = {
    name: scalar('name'),
    description: scalar('description'),
    whenToUse: scalar('when-to-use'),
    allowedTools: values.has('allowed-tools')
      ? parseAllowedTools(values.get('allowed-tools') ?? [])
      : undefined,
    userInvocable: values.has('user-invocable')
      ? parseBoolean(values.get('user-invocable')?.[0] ?? '', 'user-invocable')
      : undefined,
    disableModelInvocation: values.has('disable-model-invocation')
      ? parseBoolean(
        values.get('disable-model-invocation')?.[0] ?? '',
        'disable-model-invocation',
      )
      : undefined,
    version: scalar('version'),
  };
  const hasManifestValue = Object.values(manifest).some((value) => value !== undefined);

  return {
    manifest: hasManifestValue ? manifest : undefined,
    content: lines.slice(end + 1).join('\n').replace(/^\s+/, ''),
  };
}
