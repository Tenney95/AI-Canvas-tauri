/**
 * 短剧资产提取 — 解析模型 JSON、校验、格式化为可读简介
 */
import type {
  DramaAssetImportance,
  DramaAssetKind,
  DramaCharacter,
  DramaExtractModelResponse,
  DramaProp,
  DramaScene,
} from '../types/dramaAssets';
import { DRAMA_ASSET_KIND_LABEL, DRAMA_EXTRACT_MARKER } from '../types/dramaAssets';

const IMPORTANCE: DramaAssetImportance[] = ['main', 'supporting', 'minor'];

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v.trim();
  if (v == null) return fallback;
  return String(v).trim();
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.map((x) => asString(x)).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function asImportance(v: unknown): DramaAssetImportance {
  const s = asString(v).toLowerCase();
  if (IMPORTANCE.includes(s as DramaAssetImportance)) return s as DramaAssetImportance;
  if (s === '主要' || s === '主角') return 'main';
  if (s === '次要' || s === '配角') return 'supporting';
  return 'minor';
}

export function normalizeAssetKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[^\u4e00-\u9fff\w]/g, '');
}

function makeId(kind: DramaAssetKind, index: number): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${kind.slice(0, 4)}_${Date.now().toString(36)}_${index}_${rand}`;
}

function now(): number {
  return Date.now();
}

/** 从模型自由文本中提取 JSON 对象 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  // ```json ... ```
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    return JSON.parse(fence[1].trim());
  }
  // 首尾大括号
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error('未找到可解析的 JSON 对象');
}

function validateBaseItem(raw: Record<string, unknown>, index: number): {
  name: string;
  summary: string;
  visualNotes: string;
  storyRole?: string;
  importance: DramaAssetImportance;
  firstSeen?: string;
  appearances?: string[];
} {
  const name = asString(raw.name);
  if (!name) throw new Error(`第 ${index + 1} 条缺少 name`);
  return {
    name,
    summary: asString(raw.summary) || name,
    visualNotes: asString(raw.visualNotes) || asString(raw.visual_notes),
    storyRole: asString(raw.storyRole) || asString(raw.story_role) || undefined,
    importance: asImportance(raw.importance),
    firstSeen: asString(raw.firstSeen) || asString(raw.first_seen) || undefined,
    appearances: asStringArray(raw.appearances),
  };
}

export function parseCharacterItems(items: Array<Record<string, unknown>>): DramaCharacter[] {
  const t = now();
  return items.map((raw, i) => {
    const base = validateBaseItem(raw, i);
    const identity = asString(raw.identity) || base.summary;
    return {
      kind: 'character' as const,
      id: makeId('character', i),
      key: normalizeAssetKey(base.name),
      ...base,
      identity,
      aliases: asStringArray(raw.aliases),
      ageBand: asString(raw.ageBand) || asString(raw.age_band) || undefined,
      gender: asString(raw.gender) || undefined,
      personality: asString(raw.personality) || undefined,
      wardrobeDefault:
        asString(raw.wardrobeDefault) || asString(raw.wardrobe_default) || undefined,
      relationships: Array.isArray(raw.relationships)
        ? raw.relationships
            .map((r) => {
              if (!r || typeof r !== 'object') return null;
              const o = r as Record<string, unknown>;
              const targetName = asString(o.targetName) || asString(o.target_name);
              const relation = asString(o.relation);
              if (!targetName || !relation) return null;
              return { targetName, relation };
            })
            .filter((x): x is { targetName: string; relation: string } => !!x)
        : undefined,
      confirmed: false,
      createdAt: t,
      updatedAt: t,
      source: 'ai' as const,
    };
  });
}

export function parseSceneItems(items: Array<Record<string, unknown>>): DramaScene[] {
  const t = now();
  return items.map((raw, i) => {
    const base = validateBaseItem(raw, i);
    return {
      kind: 'scene' as const,
      id: makeId('scene', i),
      key: normalizeAssetKey(base.name),
      ...base,
      placeType: asString(raw.placeType) || asString(raw.place_type) || undefined,
      timeOfDay: asString(raw.timeOfDay) || asString(raw.time_of_day) || undefined,
      atmosphere: asString(raw.atmosphere) || undefined,
      spatialNotes: asString(raw.spatialNotes) || asString(raw.spatial_notes) || undefined,
      confirmed: false,
      createdAt: t,
      updatedAt: t,
      source: 'ai' as const,
    };
  });
}

export function parsePropItems(items: Array<Record<string, unknown>>): DramaProp[] {
  const t = now();
  return items.map((raw, i) => {
    const base = validateBaseItem(raw, i);
    return {
      kind: 'prop' as const,
      id: makeId('prop', i),
      key: normalizeAssetKey(base.name),
      ...base,
      ownerName: asString(raw.ownerName) || asString(raw.owner_name) || undefined,
      category: asString(raw.category) || undefined,
      significance: asString(raw.significance) || undefined,
      confirmed: false,
      createdAt: t,
      updatedAt: t,
      source: 'ai' as const,
    };
  });
}

export function parseDramaExtractResponse(
  text: string,
  expectedKind?: DramaAssetKind,
): { kind: DramaAssetKind; characters: DramaCharacter[]; scenes: DramaScene[]; props: DramaProp[]; notes?: string } {
  const raw = extractJsonObject(text) as Record<string, unknown>;
  const kind = asString(raw.kind) as DramaAssetKind;
  if (!['character', 'scene', 'prop'].includes(kind)) {
    throw new Error(`无效 kind: ${raw.kind}`);
  }
  if (expectedKind && kind !== expectedKind) {
    throw new Error(`期望 kind=${expectedKind}，实际为 ${kind}`);
  }
  const items = Array.isArray(raw.items) ? (raw.items as Array<Record<string, unknown>>) : [];
  if (items.length === 0) {
    throw new Error('items 为空');
  }
  const notes = asString(raw.notes) || undefined;
  if (kind === 'character') {
    return { kind, characters: parseCharacterItems(items), scenes: [], props: [], notes };
  }
  if (kind === 'scene') {
    return { kind, characters: [], scenes: parseSceneItems(items), props: [], notes };
  }
  return { kind, characters: [], scenes: [], props: parsePropItems(items), notes };
}

const IMPORTANCE_LABEL: Record<DramaAssetImportance, string> = {
  main: '主要',
  supporting: '次要',
  minor: '零星',
};

/** 将解析结果格式化为可读简介（写入文本节点） */
export function formatDramaExtractMarkdown(
  kind: DramaAssetKind,
  parsed: ReturnType<typeof parseDramaExtractResponse>,
): string {
  const title = DRAMA_ASSET_KIND_LABEL[kind];
  const lines: string[] = [
    `# ${title}简介表`,
    `> 结构化提取 · 仅简介（非生图提示词）· 共 ${
      kind === 'character' ? parsed.characters.length
        : kind === 'scene' ? parsed.scenes.length
          : parsed.props.length
    } 条`,
    '',
  ];

  if (kind === 'character') {
    parsed.characters.forEach((c, i) => {
      lines.push(`## ${i + 1}. ${c.name}${c.importance === 'main' ? '（主要）' : ''}`);
      lines.push(`- 身份：${c.identity}`);
      if (c.aliases?.length) lines.push(`- 别名：${c.aliases.join('、')}`);
      if (c.ageBand) lines.push(`- 年龄段：${c.ageBand}`);
      if (c.gender) lines.push(`- 性别呈现：${c.gender}`);
      if (c.personality) lines.push(`- 性格：${c.personality}`);
      lines.push(`- 简介：${c.summary}`);
      if (c.visualNotes) lines.push(`- 外形要点：${c.visualNotes}`);
      if (c.wardrobeDefault) lines.push(`- 默认造型：${c.wardrobeDefault}`);
      if (c.storyRole) lines.push(`- 剧情功能：${c.storyRole}`);
      if (c.relationships?.length) {
        lines.push(`- 关系：${c.relationships.map((r) => `${r.targetName}（${r.relation}）`).join('；')}`);
      }
      if (c.firstSeen) lines.push(`- 首次出现：${c.firstSeen}`);
      if (c.appearances?.length) lines.push(`- 出场：${c.appearances.join('；')}`);
      lines.push(`- 重要度：${IMPORTANCE_LABEL[c.importance]}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    });
  } else if (kind === 'scene') {
    parsed.scenes.forEach((s, i) => {
      lines.push(`## ${i + 1}. ${s.name}`);
      lines.push(`- 简介：${s.summary}`);
      if (s.placeType) lines.push(`- 类型：${s.placeType}`);
      if (s.timeOfDay) lines.push(`- 时段：${s.timeOfDay}`);
      if (s.atmosphere) lines.push(`- 氛围：${s.atmosphere}`);
      if (s.visualNotes) lines.push(`- 视觉要点：${s.visualNotes}`);
      if (s.spatialNotes) lines.push(`- 空间：${s.spatialNotes}`);
      if (s.storyRole) lines.push(`- 剧情功能：${s.storyRole}`);
      if (s.firstSeen) lines.push(`- 首次出现：${s.firstSeen}`);
      lines.push(`- 重要度：${IMPORTANCE_LABEL[s.importance]}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    });
  } else {
    parsed.props.forEach((p, i) => {
      lines.push(`## ${i + 1}. ${p.name}`);
      lines.push(`- 简介：${p.summary}`);
      if (p.ownerName) lines.push(`- 归属：${p.ownerName}`);
      if (p.category) lines.push(`- 分类：${p.category}`);
      if (p.visualNotes) lines.push(`- 外观要点：${p.visualNotes}`);
      if (p.significance) lines.push(`- 为何重要：${p.significance}`);
      if (p.storyRole) lines.push(`- 剧情功能：${p.storyRole}`);
      lines.push(`- 重要度：${IMPORTANCE_LABEL[p.importance]}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    });
  }

  if (parsed.notes) {
    lines.push('## 备注');
    lines.push(parsed.notes);
    lines.push('');
  }

  lines.push('> 下一步：对单条资产另做「生成定妆/场景/道具提示词」，再逐个生成资产图。');
  return lines.join('\n').replace(/\n---\n\n$/u, '\n').trim() + '\n';
}

/**
 * 若 prompt 含提取标记，尝试把模型输出规范成简介表。
 * 解析失败则返回原文并附简短说明，避免吞结果。
 */
export type DramaExtractParseResult = ReturnType<typeof parseDramaExtractResponse>;

export function postProcessDramaExtractOutput(
  prompt: string,
  rawOutput: string,
): { output: string; kind?: DramaAssetKind; ok: boolean; parsed?: DramaExtractParseResult } {
  let kind: DramaAssetKind | undefined;
  for (const [k, marker] of Object.entries(DRAMA_EXTRACT_MARKER) as Array<[DramaAssetKind, string]>) {
    if (prompt.includes(marker)) {
      kind = k;
      break;
    }
  }
  if (!kind) return { output: rawOutput, ok: true };

  try {
    const parsed = parseDramaExtractResponse(rawOutput, kind);
    const md = formatDramaExtractMarkdown(kind, parsed);
    return { output: md, kind, ok: true, parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: [
        `# ${DRAMA_ASSET_KIND_LABEL[kind]}提取（未规范化）`,
        `> 无法解析为 JSON：${msg}`,
        `> 以下为模型原文，可手动整理或重试提取。`,
        '',
        rawOutput,
      ].join('\n'),
      kind,
      ok: false,
    };
  }
}

/** 按 key/name 合并入库，保留旧 id 与图片绑定 */
export function mergeDramaExtractIntoLibrary(
  library: import('../types/dramaAssets').DramaAssetLibrary,
  parsed: DramaExtractParseResult,
  meta?: { sourceNodeId?: string; modelId?: string },
): import('../types/dramaAssets').DramaAssetLibrary {
  const mergeList = <T extends { id: string; key: string; name: string; imageNodeId?: string; imageUrl?: string; confirmed: boolean; createdAt: number; source: string }>(
    existing: T[],
    incoming: T[],
  ): T[] => {
    const result = [...existing];
    for (const item of incoming) {
      const idx = result.findIndex((e) => e.key === item.key || e.name === item.name);
      if (idx >= 0) {
        const old = result[idx];
        result[idx] = {
          ...item,
          id: old.id,
          imageNodeId: old.imageNodeId,
          imageUrl: old.imageUrl,
          confirmed: old.confirmed,
          createdAt: old.createdAt,
          updatedAt: Date.now(),
          source: 'merge' as T['source'],
        };
      } else {
        result.push(item);
      }
    }
    return result;
  };

  return {
    version: 1,
    lastExtract: {
      at: Date.now(),
      kinds: [parsed.kind],
      sourceNodeId: meta?.sourceNodeId,
      modelId: meta?.modelId,
    },
    characters:
      parsed.kind === 'character'
        ? mergeList(library.characters, parsed.characters)
        : library.characters,
    scenes:
      parsed.kind === 'scene'
        ? mergeList(library.scenes, parsed.scenes)
        : library.scenes,
    props:
      parsed.kind === 'prop'
        ? mergeList(library.props, parsed.props)
        : library.props,
  };
}

/** 检测 prompt 是否为资产提取任务 */
export function detectDramaExtractKind(prompt: string): DramaAssetKind | null {
  for (const [k, marker] of Object.entries(DRAMA_EXTRACT_MARKER) as Array<[DramaAssetKind, string]>) {
    if (prompt.includes(marker)) return k;
  }
  return null;
}

export type { DramaExtractModelResponse };
