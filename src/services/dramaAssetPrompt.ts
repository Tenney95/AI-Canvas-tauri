/**
 * 短剧资产 → 生图提示词（定妆 / 场景板 / 道具参考）
 * 纯模板拼装，不依赖模型调用，保证可测、可离线。
 */
import type {
  DramaAsset,
  DramaAssetKind,
  DramaAssetLibrary,
  DramaCharacter,
  DramaProp,
  DramaScene,
} from '../types/dramaAssets';
import { DRAMA_ASSET_KIND_LABEL } from '../types/dramaAssets';

export type DramaAssetPromptPurpose = 'lookbook' | 'scene_plate' | 'prop_ref';

export function defaultPurposeForKind(kind: DramaAssetKind): DramaAssetPromptPurpose {
  if (kind === 'character') return 'lookbook';
  if (kind === 'scene') return 'scene_plate';
  return 'prop_ref';
}

export function listDramaAssetsFlat(library: DramaAssetLibrary): DramaAsset[] {
  return [...library.characters, ...library.scenes, ...library.props];
}

export function findDramaAsset(
  library: DramaAssetLibrary,
  id: string,
): DramaAsset | undefined {
  return listDramaAssetsFlat(library).find((a) => a.id === id);
}

export function findDramaAssetByKind(
  library: DramaAssetLibrary,
  kind: DramaAssetKind,
  id: string,
): DramaAsset | undefined {
  if (kind === 'character') return library.characters.find((a) => a.id === id);
  if (kind === 'scene') return library.scenes.find((a) => a.id === id);
  return library.props.find((a) => a.id === id);
}

/**
 * 无图时 @ 资产插入的单条简介（对齐提取节点输出的条目格式）。
 * 只含这一条，不带整表其它人/场景/道具。
 */
export function formatDramaAssetTextBrief(asset: DramaAsset): string {
  const imp =
    asset.importance === 'main' ? '（主要）'
      : asset.importance === 'supporting' ? '（次要）'
        : '';
  const lines: string[] = [
    `## ${DRAMA_ASSET_KIND_LABEL[asset.kind]}：${asset.name}${imp}`,
  ];

  if (asset.kind === 'character') {
    const c = asset as DramaCharacter;
    if (c.identity) lines.push(`- 身份：${c.identity}`);
    if (c.aliases?.length) lines.push(`- 别名：${c.aliases.join('、')}`);
    if (c.ageBand) lines.push(`- 年龄段：${c.ageBand}`);
    if (c.gender) lines.push(`- 性别呈现：${c.gender}`);
    if (c.personality) lines.push(`- 性格：${c.personality}`);
    if (c.summary) lines.push(`- 简介：${c.summary}`);
    if (c.visualNotes) lines.push(`- 外形要点：${c.visualNotes}`);
    if (c.wardrobeDefault) lines.push(`- 默认造型：${c.wardrobeDefault}`);
    if (c.storyRole) lines.push(`- 剧情功能：${c.storyRole}`);
    if (c.relationships?.length) {
      lines.push(
        `- 关系：${c.relationships.map((r) => `${r.targetName}（${r.relation}）`).join('；')}`,
      );
    }
  } else if (asset.kind === 'scene') {
    const s = asset as DramaScene;
    if (s.summary) lines.push(`- 简介：${s.summary}`);
    if (s.placeType) lines.push(`- 类型：${s.placeType}`);
    if (s.timeOfDay) lines.push(`- 时段：${s.timeOfDay}`);
    if (s.atmosphere) lines.push(`- 氛围：${s.atmosphere}`);
    if (s.visualNotes) lines.push(`- 视觉要点：${s.visualNotes}`);
    if (s.spatialNotes) lines.push(`- 空间：${s.spatialNotes}`);
    if (s.storyRole) lines.push(`- 剧情功能：${s.storyRole}`);
  } else {
    const p = asset as DramaProp;
    if (p.summary) lines.push(`- 简介：${p.summary}`);
    if (p.ownerName) lines.push(`- 归属：${p.ownerName}`);
    if (p.category) lines.push(`- 分类：${p.category}`);
    if (p.visualNotes) lines.push(`- 外观要点：${p.visualNotes}`);
    if (p.significance) lines.push(`- 为何重要：${p.significance}`);
    if (p.storyRole) lines.push(`- 剧情功能：${p.storyRole}`);
  }

  return lines.join('\n');
}

/** 已绑图像节点且该节点已有图时，才视为「可引图」 */
export function resolveDramaAssetImageRef(
  asset: DramaAsset,
  nodes: Array<{ id: string; data?: Record<string, unknown> }>,
): { imageNodeId: string; imageUrl: string } | null {
  if (!asset.imageNodeId) return null;
  const node = nodes.find((n) => n.id === asset.imageNodeId);
  const imageUrl =
    (node?.data?.imageUrl as string | undefined)
    || (node?.data?.thumbnailUrl as string | undefined)
    || asset.imageUrl;
  if (!imageUrl || !String(imageUrl).trim()) return null;
  return { imageNodeId: asset.imageNodeId, imageUrl };
}

function joinParts(parts: Array<string | undefined | false>): string {
  return parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join('，');
}

/** 人物定妆 lookbook prompt */
export function buildCharacterLookbookPrompt(c: DramaCharacter, styleHint?: string): string {
  const subject = joinParts([
    c.identity || c.summary,
    c.gender,
    c.ageBand,
    c.personality ? `${c.personality}气质` : undefined,
  ]);
  const look = joinParts([
    c.visualNotes,
    c.wardrobeDefault ? `服装：${c.wardrobeDefault}` : undefined,
  ]);
  const style = styleHint?.trim() || '电影感写实人像，柔和棚拍光';
  return [
    `角色定妆参考图（lookbook），单人全身，白色或浅灰干净背景，无文字无水印。`,
    `角色名：${c.name}。`,
    subject ? `人物：${subject}。` : '',
    look ? `外形与着装：${look}。` : '',
    `姿态自然站立，正对镜头或微侧，表情中性克制。`,
    `画面清晰、五官与服装细节可辨，适合作为后续分镜一致性参考。`,
    `风格：${style}。`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 场景概念板 prompt */
export function buildScenePlatePrompt(s: DramaScene, styleHint?: string): string {
  const env = joinParts([
    s.placeType,
    s.timeOfDay,
    s.atmosphere,
    s.spatialNotes,
  ]);
  const style = styleHint?.trim() || '电影感场景概念图，写实光影';
  return [
    `空镜场景概念图（scene plate），无人或仅远景剪影，无文字无水印。`,
    `场景名：${s.name}。`,
    s.summary ? `场景简介：${s.summary}。` : '',
    s.visualNotes ? `视觉要点：${s.visualNotes}。` : '',
    env ? `环境：${env}。` : '',
    `构图强调空间层次与光影氛围，适合作为分镜环境参考。`,
    `风格：${style}。`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 道具参考图 prompt */
export function buildPropRefPrompt(p: DramaProp, styleHint?: string): string {
  const meta = joinParts([
    p.category,
    p.ownerName ? `归属${p.ownerName}` : undefined,
    p.significance,
  ]);
  const style = styleHint?.trim() || '产品摄影质感，柔和棚光';
  return [
    `关键道具参考图（prop reference），静物特写，干净背景，无文字无水印。`,
    `道具名：${p.name}。`,
    p.summary ? `简介：${p.summary}。` : '',
    p.visualNotes ? `外观：${p.visualNotes}。` : '',
    meta ? `补充：${meta}。` : '',
    `材质与磨损细节清晰，适合作为戏用道具一致性参考。`,
    `风格：${style}。`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildDramaAssetImagePrompt(
  asset: DramaAsset,
  _purpose?: DramaAssetPromptPurpose,
  styleHint?: string,
): string {
  // purpose 预留；一期按资产 kind 映射 lookbook / scene_plate / prop_ref
  if (asset.kind === 'character') return buildCharacterLookbookPrompt(asset, styleHint);
  if (asset.kind === 'scene') return buildScenePlatePrompt(asset, styleHint);
  return buildPropRefPrompt(asset, styleHint);
}

export function defaultAspectRatioForAsset(kind: DramaAssetKind): string {
  if (kind === 'character') return '3:4';
  if (kind === 'scene') return '16:9';
  return '1:1';
}

export function purposeLabel(purpose: DramaAssetPromptPurpose): string {
  if (purpose === 'lookbook') return '定妆图';
  if (purpose === 'scene_plate') return '场景板';
  return '道具参考';
}
