/**
 * 注册短剧资产（人物/场景/道具）与角色库工具：读取让 Agent 先发现已有设定，
 * 再用 @drama{id:name} 引用它们；写入（新增/修改/删除）一律经 Policy 审批后才落库。
 *
 * scope=project 操作当前项目资产库，scope=global 操作跨项目角色库（只有角色）。
 */
import { useAppStore } from '../../../store/useAppStore';
import type { CharacterLibraryScope } from '../../../store/store.dramaAssets';
import { isEligibleCharacterReferenceNode, isEligibleCharacterVoiceNode } from '../../../store/store.dramaAssets';
import type {
  CharacterReferenceKind,
  CharacterVoiceKind,
  DramaAsset,
  DramaAssetImportance,
  DramaAssetKind,
  DramaCharacter,
} from '../../../types/dramaAssets';
import { buildDramaMentionId, buildDramaVoiceMentionId, formatDramaMention, normalizeDramaCharacter } from '../../../types/dramaAssets';
import { findDramaAsset, formatDramaAssetTextBrief, listDramaAssetsFlat, resolveDramaAssetImageRef } from '../../dramaAssetPrompt';
import {
  registerAgentTool,
  type AgentToolExecutionResult,
  type AgentToolContext,
} from '../toolRegistry';
import type { AgentToolSchema } from '../agentToolSchemas';

const DRAMA_ASSET_KINDS: DramaAssetKind[] = ['character', 'scene', 'prop'];
const DRAMA_ASSET_IMPORTANCES: DramaAssetImportance[] = ['main', 'supporting', 'minor'];
const SCOPES: CharacterLibraryScope[] = ['project', 'global'];
/** 各类资产可写的专属字段；写入时用它拦截跨类型字段。 */
const KIND_FIELDS: Record<DramaAssetKind, string[]> = {
  character: ['identity', 'personality', 'wardrobeDefault', 'voiceNotes'],
  scene: ['placeType', 'timeOfDay', 'atmosphere', 'spatialNotes'],
  prop: ['ownerName', 'category', 'significance'],
};
const SHARED_FIELDS = ['name', 'summary', 'visualNotes', 'storyRole', 'importance'];

function authorizeCurrentProject(context: { projectId: string }) {
  return useAppStore.getState().currentProjectId === context.projectId
    ? { allowed: true }
    : { allowed: false, reason: '目标项目当前未加载，不能读取其他项目的短剧资产' };
}

/** 全局角色库不属于任何项目，只有 project 作用域需要校验当前项目。 */
function authorizeScope(context: { projectId: string }, input: { scope?: CharacterLibraryScope }) {
  return input.scope === 'global' ? { allowed: true } : authorizeCurrentProject(context);
}

function listScopedAssets(scope: CharacterLibraryScope | undefined): DramaAsset[] {
  const store = useAppStore.getState();
  return scope === 'global'
    ? store.globalCharacters
    : listDramaAssetsFlat(store.dramaAssets);
}

function findScopedAsset(
  scope: CharacterLibraryScope | undefined,
  assetId: string,
): DramaAsset | undefined {
  const store = useAppStore.getState();
  return scope === 'global'
    ? store.globalCharacters.find((item) => item.id === assetId)
    : findDramaAsset(store.dramaAssets, assetId);
}

/** 全局角色的引用必须携带作用域，不能与项目内同 ID 的资产混淆。 */
function assetMention(asset: DramaAsset, scope?: CharacterLibraryScope, pick?: string): string {
  return formatDramaMention(buildDramaMentionId(scope === 'global' ? `global/${asset.id}` : asset.id, pick), asset.name);
}

/** 列表只返回选取所需信息，完整简报留给 drama_asset_get。 */
function summarizeAsset(asset: DramaAsset, scope?: CharacterLibraryScope) {
  const character = asset.kind === 'character' ? asset as DramaCharacter : undefined;
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    summary: asset.summary || undefined,
    importance: asset.importance,
    mention: assetMention(asset, scope),
    imageReady: Boolean(resolveDramaAssetImageRef(asset, useAppStore.getState().nodes)),
    ...(scope !== 'global' ? { imageNodeId: asset.imageNodeId } : {}),
    referenceImageCount: character?.referenceImages?.length ?? (asset.imageUrl ? 1 : 0),
    voiceClipCount: character?.voiceClips?.length ?? 0,
    hasVoice: Boolean(character?.primaryVoiceClipId),
  };
}

const scopeProperty = { type: 'string' as const, enum: [...SCOPES] };

const listInputSchema: AgentToolSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: DRAMA_ASSET_KINDS },
    scope: scopeProperty,
  },
};

const getInputSchema: AgentToolSchema = {
  type: 'object',
  required: ['assetId'],
  additionalProperties: false,
  properties: {
    assetId: { type: 'string', minLength: 1, maxLength: 160 },
    scope: scopeProperty,
  },
};

const textField = { type: 'string' as const, maxLength: 2000 };

interface BindAssetMediaInput {
  assetId: string;
  nodeId: string;
  scope?: CharacterLibraryScope;
  kind?: CharacterReferenceKind | CharacterVoiceKind;
  makePrimary?: boolean;
  label?: string;
  transcript?: string;
  prompt?: string;
}

function characterMediaSchema(audio: boolean): AgentToolSchema {
  return {
    type: 'object', required: ['assetId', 'nodeId'], additionalProperties: false,
    properties: {
      assetId: { type: 'string', minLength: 1, maxLength: 160 },
      nodeId: { type: 'string', minLength: 1, maxLength: 160 },
      scope: scopeProperty,
      makePrimary: { type: 'boolean' },
      kind: { type: 'string', enum: audio
        ? ['timbre', 'line', 'emotion', 'other']
        : ['primary', 'avatar', 'full_body', 'expression', 'turnaround', 'outfit', 'other'] },
      ...(audio ? {
        label: { type: 'string' as const, maxLength: 120 },
        transcript: { type: 'string' as const, maxLength: 4000 },
      } : { prompt: { type: 'string' as const, maxLength: 4000 } }),
    },
  };
}

async function bindAssetMedia(
  context: AgentToolContext, input: BindAssetMediaInput, audio: boolean,
): Promise<AgentToolExecutionResult> {
  const fail = (message: string): AgentToolExecutionResult => ({ status: 'error', summary: message, modelContent: message });
  const store = useAppStore.getState();
  // 即使目标为全局角色，源节点也必须来自本次调用的当前画布。
  if (store.currentProjectId !== context.projectId) return fail('目标项目当前未加载');
  if (context.baseRevision !== undefined && context.baseRevision !== store.getCurrentRevision()) {
    return fail('画布已变更，请重新查询源节点后绑定');
  }
  if (context.signal?.aborted) return fail('操作已取消');
  const scope = input.scope ?? 'project';
  const asset = findScopedAsset(scope, input.assetId);
  if (!asset || (audio && asset.kind !== 'character')) return fail('目标资产不存在或类型不匹配，请先查询资产库');
  const node = store.nodes.find((item) => item.id === input.nodeId);
  if (!node || !(audio ? isEligibleCharacterVoiceNode(node) : isEligibleCharacterReferenceNode(node))) {
    return fail(audio ? '源节点没有可用音频，请先导入音频到画布' : '源节点没有可用图片，请先导入图片到画布');
  }
  const mediaUrl = audio ? node.data.audioUrl : node.data.imageUrl ?? node.data.thumbnailUrl;
  if (!mediaUrl?.trim()) return fail('源节点没有可用媒体');
  if (!audio && asset.kind !== 'character') {
    const reused = asset.imageNodeId === node.id && asset.imageUrl === mediaUrl;
    if (!reused) store.bindDramaAssetImage(asset.kind, asset.id, node.id, mediaUrl);
    return {
      status: 'success', summary: '已绑定资产参考图',
      modelContent: JSON.stringify({ assetId: asset.id, kind: asset.kind, scope, nodeId: node.id,
        imageReady: true, reused, mention: assetMention(asset, scope) }),
    };
  }
  const character = asset as DramaCharacter;
  // 全局库不保留项目 sourceNodeId；稳定 ID 仍保证同源节点重复绑定不增殖。
  const stableId = `mcp-${audio ? 'voice' : 'image'}-${encodeURIComponent(context.projectId)}-${encodeURIComponent(node.id)}`;
  const entries = audio ? character.voiceClips : character.referenceImages;
  const existing = entries?.find((item) => item.id === stableId
    || (scope === 'project' && item.sourceNodeId === node.id)
    || Boolean(node.data.assetId && item.assetId === node.data.assetId));
  const now = Date.now();
  const media = {
    id: existing?.id ?? stableId,
    assetId: node.data.assetId, relativePath: node.data.relativePath, filePath: node.data.filePath,
    sourceNodeId: scope === 'project' ? node.id : undefined,
    createdAt: existing?.createdAt ?? now, updatedAt: now,
  };
  try {
    const saved = audio
      ? await store.addCharacterVoiceClip(scope, character.id, {
        ...existing, ...media, audioUrl: mediaUrl,
        kind: (input.kind ?? existing?.kind ?? 'timbre') as CharacterVoiceKind,
        label: input.label?.trim() || character.voiceClips?.find((item) => item.id === media.id)?.label || node.data.label,
        transcript: input.transcript ?? character.voiceClips?.find((item) => item.id === media.id)?.transcript ?? '',
      }, { makePrimary: input.makePrimary })
      : await store.addCharacterReferenceImage(scope, character.id, {
        ...existing, ...media, imageUrl: mediaUrl,
        kind: (input.kind ?? existing?.kind ?? 'other') as CharacterReferenceKind,
        prompt: input.prompt ?? character.referenceImages?.find((item) => item.id === media.id)?.prompt ?? '',
      }, { makePrimary: input.makePrimary === true || input.kind === 'primary' });
    if (!saved) return fail('角色素材保存失败');
    const mentionAssetId = scope === 'global' ? `global/${character.id}` : character.id;
    const mentionId = audio ? buildDramaVoiceMentionId(mentionAssetId, media.id) : buildDramaMentionId(mentionAssetId, media.id);
    return {
      status: 'success', summary: audio ? '已添加角色参考音频' : '已添加角色参考图',
      modelContent: JSON.stringify({ assetId: character.id, scope, nodeId: node.id,
        ...(audio ? { clipId: media.id } : { referenceImageId: media.id }),
        reused: Boolean(existing), mention: formatDramaMention(mentionId, character.name) }),
    };
  } catch {
    return fail('角色素材保存失败，请查询角色详情核对，勿自动重试');
  }
}

const upsertInputSchema: AgentToolSchema = {
  type: 'object',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    scope: scopeProperty,
    kind: { type: 'string', enum: DRAMA_ASSET_KINDS },
    assetId: { type: 'string', minLength: 1, maxLength: 160 },
    name: { type: 'string', minLength: 1, maxLength: 60 },
    summary: textField,
    visualNotes: textField,
    storyRole: textField,
    importance: { type: 'string', enum: [...DRAMA_ASSET_IMPORTANCES] },
    identity: textField,
    personality: textField,
    wardrobeDefault: textField,
    voiceNotes: textField,
    placeType: textField,
    timeOfDay: textField,
    atmosphere: textField,
    spatialNotes: textField,
    ownerName: textField,
    category: textField,
    significance: textField,
  },
};

const deleteInputSchema: AgentToolSchema = {
  type: 'object',
  required: ['assetId'],
  additionalProperties: false,
  properties: {
    scope: scopeProperty,
    assetId: { type: 'string', minLength: 1, maxLength: 160 },
  },
};

interface UpsertAssetInput extends Record<string, unknown> {
  scope?: CharacterLibraryScope;
  kind: DramaAssetKind;
  assetId?: string;
  name?: string;
}

function createAssetId(kind: DramaAssetKind): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 收集本次要写入的字段，并拦截与 kind 不符的专属字段。 */
function collectAssetPatch(
  input: UpsertAssetInput,
): { patch: Record<string, unknown> } | { error: string } {
  const allowed = new Set([...SHARED_FIELDS, ...KIND_FIELDS[input.kind]]);
  const foreign = Object.keys(input).filter((field) => (
    !allowed.has(field)
    && !['scope', 'kind', 'assetId'].includes(field)
  ));
  if (foreign.length > 0) {
    return { error: `字段 ${foreign.join('、')} 不属于${input.kind}类资产` };
  }
  const patch: Record<string, unknown> = {};
  for (const field of allowed) {
    const value = input[field];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) patch[field] = trimmed;
    } else if (value !== undefined) {
      patch[field] = value;
    }
  }
  return { patch };
}

export function registerDramaAssetAgentTools(): Array<() => void> {
  return [
    registerAgentTool<{ kind?: DramaAssetKind; scope?: CharacterLibraryScope }>({
      id: 'drama_asset_list',
      title: '查询短剧资产',
      description:
        '列出已入库的人物、场景与道具，含可直接写进提示词的 @drama 引用串。'
        + '优先使用库引用，不为这些素材重新导入节点或连线；imageReady=false 表示只有设定，须先生成/绑定图片再用于 Picture 参考。'
        + 'scope=project（默认）查当前项目资产库，scope=global 查跨项目角色库。'
        + '需要某个资产的完整设定时再调用 drama_asset_get。',
      inputSchema: listInputSchema,
      effect: 'read',
      authorize: authorizeScope,
      summarizeInput: (input) => input.kind
        ? `查询短剧资产（${input.kind}）`
        : '查询短剧资产',
      execute: async (_context, input): Promise<AgentToolExecutionResult> => {
        const assets = listScopedAssets(input.scope)
          .filter((asset) => !input.kind || asset.kind === input.kind)
          .map((asset) => summarizeAsset(asset, input.scope));
        return {
          status: 'success',
          summary: `找到 ${assets.length} 个短剧资产`,
          modelContent: JSON.stringify({ scope: input.scope ?? 'project', assets }),
        };
      },
    }),
    registerAgentTool<{ assetId: string; scope?: CharacterLibraryScope }>({
      id: 'drama_asset_get',
      title: '读取短剧资产',
      description:
        '按 ID 读取一个人物、场景或道具的完整设定简报（身份、外形、声音、关系等），'
        + '用于生成提示词或分镜时保持设定一致。',
      inputSchema: getInputSchema,
      effect: 'read',
      authorize: authorizeScope,
      summarizeInput: (input) => `读取短剧资产 ${input.assetId}`,
      execute: async (_context, input): Promise<AgentToolExecutionResult> => {
        const asset = findScopedAsset(input.scope, input.assetId);
        if (!asset) {
          return {
            status: 'error',
            summary: '未找到该短剧资产',
            modelContent: `短剧资产 ${input.assetId} 不存在，请先调用 drama_asset_list 获取可用 ID`,
          };
        }
        const character = asset.kind === 'character' ? asset as DramaCharacter : undefined;
        return {
          status: 'success',
          summary: `已读取「${asset.name}」`,
          modelContent: JSON.stringify({
            id: asset.id,
            kind: asset.kind,
            name: asset.name,
            mention: assetMention(asset, input.scope),
            imageReady: Boolean(resolveDramaAssetImageRef(asset, useAppStore.getState().nodes)),
            ...(input.scope !== 'global' ? { imageNodeId: asset.imageNodeId } : {}),
            brief: formatDramaAssetTextBrief(asset),
            referenceImageCount: character?.referenceImages?.length ?? (asset.imageUrl ? 1 : 0),
            referenceImages: character?.referenceImages?.map((reference) => ({
              id: reference.id, kind: reference.kind,
              isPrimary: reference.id === character.primaryReferenceImageId,
              mention: assetMention(asset, input.scope, reference.id),
            })) ?? [],
            voiceClips: character?.voiceClips?.map((clip) => ({
              id: clip.id,
              kind: clip.kind,
              label: clip.label,
              transcript: clip.transcript || undefined,
              isPrimary: clip.id === character.primaryVoiceClipId,
            })) ?? [],
          }),
        };
      },
    }),
    registerAgentTool<UpsertAssetInput>({
      id: 'drama_asset_upsert',
      title: '新增或修改资产',
      description: [
        '新增或修改人物、场景、道具设定。给 assetId 表示改已有资产，省略则新建。',
        'scope=project（默认）写当前项目资产库；scope=global 写跨项目角色库，只能是 character。',
        '专属字段按类型区分：人物 identity/personality/wardrobeDefault/voiceNotes，',
        '场景 placeType/timeOfDay/atmosphere/spatialNotes，道具 ownerName/category/significance。',
        '人物/场景/道具的已有参考图通过 drama_reference_image_add 从画布节点绑定；新建 ai-image 时传 dramaAssetId，生成后自动回填。人物音色用 drama_voice_add。返回的 mention 应优先用于下游提示词，减少节点连线。',
      ].join(''),
      inputSchema: upsertInputSchema,
      effect: 'asset_write',
      authorize: (context, input) => {
        if (input.scope === 'global' && input.kind !== 'character') {
          return { allowed: false, reason: '全局角色库只保存人物资产' };
        }
        return authorizeScope(context, input);
      },
      summarizeInput: (input) => {
        const target = input.name || input.assetId || '新资产';
        return `${input.assetId ? '修改' : '新增'}${input.scope === 'global' ? '全局' : '项目'}资产「${target}」`;
      },
      execute: async (_context, input): Promise<AgentToolExecutionResult> => {
        const collected = collectAssetPatch(input);
        if ('error' in collected) {
          return { status: 'error', summary: collected.error, modelContent: collected.error };
        }
        const existing = input.assetId ? findScopedAsset(input.scope, input.assetId) : undefined;
        if (input.assetId && !existing) {
          const message = `资产 ${input.assetId} 不存在，新建时请省略 assetId`;
          return { status: 'error', summary: message, modelContent: message };
        }
        if (existing && existing.kind !== input.kind) {
          const message = `资产 ${input.assetId} 是${existing.kind}，不能改成${input.kind}`;
          return { status: 'error', summary: message, modelContent: message };
        }
        if (!existing && !input.name) {
          return { status: 'error', summary: '新建资产必须提供 name', modelContent: '新建资产必须提供 name' };
        }

        const now = Date.now();
        const merged = {
          // 已有资产保留参考图、音色、绑定节点等这里管不到的字段
          ...(existing ?? {
            id: createAssetId(input.kind),
            kind: input.kind,
            key: input.name,
            summary: '',
            visualNotes: '',
            importance: 'supporting' as DramaAssetImportance,
            confirmed: true,
            createdAt: now,
            source: 'manual' as const,
            ...(input.kind === 'character' ? { identity: '' } : {}),
          }),
          ...collected.patch,
          updatedAt: now,
        } as DramaAsset;

        const store = useAppStore.getState();
        if (input.scope === 'global' || merged.kind === 'character') {
          const saved = await store.saveCharacterCard(
            input.scope ?? 'project',
            normalizeDramaCharacter(merged as DramaCharacter),
          );
          if (!saved) {
            return { status: 'error', summary: '角色保存失败', modelContent: '角色保存失败' };
          }
        } else {
          store.upsertDramaAsset(merged);
        }
        return {
          status: 'success',
          summary: `${existing ? '已修改' : '已新增'}资产「${merged.name}」`,
          modelContent: JSON.stringify({
            id: merged.id,
            kind: merged.kind,
            name: merged.name,
            scope: input.scope ?? 'project',
            mention: assetMention(merged, input.scope),
            created: !existing,
          }),
        };
      },
    }),
    registerAgentTool<{ assetId: string; scope?: CharacterLibraryScope }>({
      id: 'drama_asset_delete',
      title: '删除资产',
      description:
        '从项目资产库或全局角色库删除一个资产。资产库没有撤销，删除后只能重新录入，'
        + '每次都需要用户二次确认。画布上已生成的图像节点不会被删除。',
      inputSchema: deleteInputSchema,
      effect: 'permanent_delete',
      authorize: authorizeScope,
      summarizeInput: (input) => {
        const asset = findScopedAsset(input.scope, input.assetId);
        return `删除${input.scope === 'global' ? '全局' : '项目'}资产「${asset?.name ?? input.assetId}」`;
      },
      execute: async (_context, input): Promise<AgentToolExecutionResult> => {
        const asset = findScopedAsset(input.scope, input.assetId);
        if (!asset) {
          const message = `资产 ${input.assetId} 不存在`;
          return { status: 'error', summary: message, modelContent: message };
        }
        const store = useAppStore.getState();
        if (input.scope === 'global') {
          const deleted = await store.deleteGlobalCharacter(input.assetId);
          if (!deleted) {
            return { status: 'error', summary: '全局角色删除失败', modelContent: '全局角色删除失败' };
          }
        } else {
          store.deleteDramaAsset(asset.kind, input.assetId);
        }
        return {
          status: 'success',
          summary: `已删除资产「${asset.name}」`,
          modelContent: JSON.stringify({
            id: input.assetId,
            kind: asset.kind,
            scope: input.scope ?? 'project',
          }),
        };
      },
    }),
    ...([false, true] as const).map((audio) => registerAgentTool<BindAssetMediaInput>({
      id: audio ? 'drama_voice_add' : 'drama_reference_image_add',
      title: audio ? '添加角色参考音频' : '绑定创作资产参考图',
      description: (audio ? '把当前画布中已有音频产物绑定到指定角色。' : '把当前画布中已有图片绑定到人物、场景或道具；已生成的场景/道具也必须调用本工具关联，不能只录入文字。')
        + '本机文件先用 file_import_media_to_canvas 导入，再传 nodeId；不接受路径或 URL。'
        + (audio ? 'scope 支持 project/global，仅绑定角色声音，重复绑定复用素材 ID，makePrimary 可设主音色。'
          : 'scope=project 支持人物、场景、道具，global 仅角色；角色重复绑定复用素材 ID，makePrimary 可设主素材，场景/道具只有一张主参考图。')
        + '不生成媒体，不隐藏或修改源节点。返回可直接写进下游提示词的库引用；库引用不需要额外连线。',
      inputSchema: characterMediaSchema(audio), effect: 'asset_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `为资产 ${input.assetId} 绑定${audio ? '声音' : '图片'}节点 ${input.nodeId}`,
      execute: (context, input) => bindAssetMedia(context, input, audio),
    })),
    registerAgentTool<{ assetId: string; clipId: string; scope?: CharacterLibraryScope; kind?: CharacterVoiceKind; label?: string; transcript?: string }>({
      id: 'drama_voice_update',
      title: '更新角色声音',
      description: '更新已有角色声音片段的用途、名称或台词描述；不接受音频路径或 URL。',
      inputSchema: { type: 'object', required: ['assetId', 'clipId'], additionalProperties: false, properties: {
        assetId: { type: 'string', minLength: 1, maxLength: 160 }, clipId: { type: 'string', minLength: 1, maxLength: 160 }, scope: scopeProperty,
        kind: { type: 'string', enum: ['timbre', 'line', 'emotion', 'other'] }, label: { type: 'string', maxLength: 120 }, transcript: { type: 'string', maxLength: 4000 },
      } },
      effect: 'asset_write',
      authorize: authorizeScope,
      execute: async (_context, input) => {
        const asset = findScopedAsset(input.scope, input.assetId);
        if (asset?.kind !== 'character' || !asset.voiceClips?.some((clip) => clip.id === input.clipId)) {
          return { status: 'error', summary: '角色声音片段不存在', modelContent: '角色声音片段不存在' };
        }
        const saved = await useAppStore.getState().updateCharacterVoiceClip(input.scope ?? 'project', asset.id, input.clipId, { kind: input.kind, label: input.label?.trim(), transcript: input.transcript });
        return saved ? { status: 'success', summary: '已更新角色声音片段', modelContent: JSON.stringify({ assetId: asset.id, clipId: input.clipId }) } : { status: 'error', summary: '角色声音更新失败', modelContent: '角色声音更新失败' };
      },
    }),
    registerAgentTool<{ assetId: string; clipId: string; scope?: CharacterLibraryScope }>({
      id: 'drama_voice_set_primary',
      title: '设置角色主声音',
      description: '将一个已有声音片段设为角色默认主音色。',
      inputSchema: { type: 'object', required: ['assetId', 'clipId'], additionalProperties: false, properties: { assetId: { type: 'string', minLength: 1, maxLength: 160 }, clipId: { type: 'string', minLength: 1, maxLength: 160 }, scope: scopeProperty } },
      effect: 'asset_write',
      authorize: authorizeScope,
      execute: async (_context, input) => {
        const saved = await useAppStore.getState().setCharacterPrimaryVoice(input.scope ?? 'project', input.assetId, input.clipId);
        return saved ? { status: 'success', summary: '已设置角色主声音', modelContent: JSON.stringify({ assetId: input.assetId, clipId: input.clipId }) } : { status: 'error', summary: '角色或声音片段不存在', modelContent: '角色或声音片段不存在' };
      },
    }),
    registerAgentTool<{ assetId: string; clipId: string; scope?: CharacterLibraryScope }>({
      id: 'drama_voice_delete',
      title: '删除角色声音',
      description: '永久移除一个角色声音片段；不删除画布音频节点和共用文件。',
      inputSchema: { type: 'object', required: ['assetId', 'clipId'], additionalProperties: false, properties: { assetId: { type: 'string', minLength: 1, maxLength: 160 }, clipId: { type: 'string', minLength: 1, maxLength: 160 }, scope: scopeProperty } },
      effect: 'permanent_delete',
      authorize: authorizeScope,
      execute: async (_context, input) => {
        const deleted = await useAppStore.getState().removeCharacterVoiceClip(input.scope ?? 'project', input.assetId, input.clipId);
        return deleted ? { status: 'success', summary: '已删除角色声音片段', modelContent: JSON.stringify({ deleted: true, assetId: input.assetId, clipId: input.clipId }) } : { status: 'error', summary: '角色或声音片段不存在', modelContent: '角色或声音片段不存在' };
      },
    }),
  ];
}
