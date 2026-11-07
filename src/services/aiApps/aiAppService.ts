/**
 * aiAppService — 管理 AI 应用节点、项目文件定义与输入资源快照。
 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import type { AiAppDefinition, AiAppReference, AiAppResourceSnapshot } from '../../types/aiApp';
import type { CanvasContext } from '../../types/project';
import { useAppStore } from '../../store/useAppStore';
import { allowAiAppNodeInsertion } from './aiAppCreation';
import { AI_APP_MAX_DEFINITION_BYTES, normalizeAiAppDefinition, normalizeAiAppInputIds, normalizeAiAppJson, normalizeAiAppReference } from './aiAppSchema';
import { readBoundedProjectFile, readVerifiedProjectFile, sha256Hex, writeImmutableProjectFile } from '../fs/projectFiles';
import { arrayBufferToBase64, getProjectDataDir } from '../fileService';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation, registerCanvasImport } from '../canvasDerivationGuard';
import { assertProjectExpectedContextCurrent } from '../projectExecutionContext';

export interface AiAppMutationContext {
  projectId: string;
  baseRevision?: number;
  expectedContext?: Readonly<CanvasContext>;
  signal?: AbortSignal;
}

export function assertAiAppContext(context: AiAppMutationContext): void {
  context.signal?.throwIfAborted();
  const state = useAppStore.getState();
  if (!context.projectId || state.currentProjectId !== context.projectId) throw new Error('目标项目当前未加载');
  if (context.expectedContext !== undefined) {
    assertProjectExpectedContextCurrent(context.expectedContext, state, { checkCanvasRevision: false });
    if (context.expectedContext.kind !== 'canvas' || context.expectedContext.canvasId !== context.projectId) {
      throw new Error('应用目标画布上下文无效');
    }
  }
  if (context.baseRevision !== undefined && state.getCurrentRevision() !== context.baseRevision) {
    throw new Error('画布已变化，请重新读取应用后再操作');
  }
}

export function getAiAppNode(nodeId: string, projectId = useAppStore.getState().currentProjectId) {
  if (!projectId || useAppStore.getState().currentProjectId !== projectId) throw new Error('目标项目当前未加载');
  const node = useAppStore.getState().nodes.find((entry) => entry.id === nodeId);
  if (!node || node.type !== 'ai-app' || node.data.type !== 'ai-app') throw new Error('AI 应用节点不存在');
  const app = normalizeAiAppReference(node.data.aiApp);
  if (app.instanceId !== node.id) throw new Error('AI 应用实例身份不匹配');
  return { node, app, projectId };
}

export function captureAiAppResources(inputNodeIds: string[], appNodeId?: string) {
  const ids = normalizeAiAppInputIds(inputNodeIds);
  const state = useAppStore.getState();
  const snapshots: AiAppResourceSnapshot[] = [];
  const fingerprints: unknown[] = [];
  for (const id of ids) {
    const node = state.nodes.find((entry) => entry.id === id);
    if (!node || id === appNodeId || node.type === 'group') throw new Error('绑定的素材节点已失效，请重新绑定');
    const data = node.data;
    const text = ['ai-text', 'source-text', 'ai-markdown', 'comment'].includes(data.type) ? data.output ?? '' : '';
    const snapshot: AiAppResourceSnapshot = {
      nodeId: id, label: (data.displayLabel || data.label || '').slice(0, 120),
      type: data.type, status: data.status ?? 'idle', text: text.slice(0, 2000), truncated: text.length > 2000,
      hasImage: !!(data.thumbnailUrl || data.imageUrl), hasVideo: !!data.videoUrl, hasAudio: !!data.audioUrl,
    };
    snapshots.push(snapshot);
    // 媒体地址只参与内存指纹，不发给应用、模型或持久化摘要。
    fingerprints.push([snapshot, data.imageUrl, data.thumbnailUrl, data.videoUrl, data.audioUrl, data.mediaVersion]);
  }
  return { snapshots, fingerprint: JSON.stringify(fingerprints) };
}

export async function loadAiAppDefinition(projectId: string, reference: AiAppReference): Promise<AiAppDefinition> {
  const app = normalizeAiAppReference(reference);
  const bytes = await readVerifiedProjectFile({ projectId, reference: app.definition, maxBytes: AI_APP_MAX_DEFINITION_BYTES });
  const definition = normalizeAiAppDefinition(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (definition.title !== app.title || definition.description !== app.description
    || JSON.stringify(definition.actions) !== JSON.stringify(app.actions)) throw new Error('应用定义与节点摘要不匹配');
  return definition;
}

async function writeDefinition(projectId: string, definition: AiAppDefinition) {
  const bytes = new TextEncoder().encode(JSON.stringify(definition));
  const sha256 = await sha256Hex(bytes);
  const reference = { relativePath: `ai-apps/${sha256}.json`, sha256, bytes: bytes.byteLength };
  await writeImmutableProjectFile({ projectId, reference, data: bytes, maxBytes: AI_APP_MAX_DEFINITION_BYTES });
  // 新引用发布前读回同一份不可变文件，磁盘故障不会替换正在使用的版本。
  await readVerifiedProjectFile({ projectId, reference, maxBytes: AI_APP_MAX_DEFINITION_BYTES });
  return reference;
}

export async function createAiAppNode(input: {
  definition: unknown;
  inputNodeIds?: string[];
  position?: { x: number; y: number };
  state?: unknown;
}, context: AiAppMutationContext): Promise<string> {
  assertAiAppContext(context);
  const definition = normalizeAiAppDefinition(input.definition);
  const inputNodeIds = normalizeAiAppInputIds(input.inputNodeIds ?? []);
  const savedState = normalizeAiAppJson(input.state ?? {});
  const guard = registerCanvasImport(useAppStore.getState());
  if (!guard) throw new Error('无法创建应用目标保护');
  try {
    const initialRevision = useAppStore.getState().getCurrentRevision();
    const resources = captureAiAppResources(inputNodeIds);
    const assertFresh = () => {
      assertAiAppContext({ ...context, baseRevision: initialRevision });
      if (!isCanvasDerivationFresh(guard, useAppStore.getState())) throw new Error('应用目标画布已变化');
      if (captureAiAppResources(inputNodeIds).fingerprint !== resources.fingerprint) throw new Error('绑定素材已变化');
    };
    const position = input.position ?? { x: 300, y: 300 };
    if (![position.x, position.y].every((value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000)) {
      throw new Error('应用节点坐标无效');
    }
    const { validateAiAppCandidate } = await import('./aiAppRuntime');
    assertFresh();
    await validateAiAppCandidate({ definition, inputNodeIds, savedState, assertFresh, signal: context.signal });
    assertFresh();
    const reference = await writeDefinition(context.projectId, definition);
    assertFresh();
    const id = `ai-app-${crypto.randomUUID()}`;
    const app: AiAppReference = {
      version: 1, instanceId: id, definition: reference, title: definition.title, description: definition.description,
      revision: 1, actions: definition.actions, inputNodeIds, savedState,
    };
    const node: Node<BaseNodeData> = {
      id, type: 'ai-app', position,
      data: { type: 'ai-app', label: definition.title, aiApp: app, status: 'idle', nodeWidth: 320, nodeHeight: 220 },
    };
    allowAiAppNodeInsertion(node, () => useAppStore.getState().addNode(node));
    useAppStore.getState().incrementRevision();
    return id;
  } finally { completeCanvasDerivation(guard); }
}

export async function updateAiAppNode(nodeId: string, input: {
  definition?: unknown;
  inputNodeIds?: string[];
}, context: AiAppMutationContext): Promise<void> {
  assertAiAppContext(context);
  const { app, projectId } = getAiAppNode(nodeId, context.projectId);
  const inputNodeIds = normalizeAiAppInputIds(input.inputNodeIds ?? app.inputNodeIds);
  const resources = captureAiAppResources(inputNodeIds, nodeId);
  const guard = registerCanvasDerivation(useAppStore.getState(), nodeId);
  if (!guard) throw new Error('无法创建应用更新保护');
  const assertFresh = () => {
    assertAiAppContext(context);
    const live = getAiAppNode(nodeId, projectId).app;
    if (!isCanvasDerivationFresh(guard, useAppStore.getState()) || JSON.stringify(live) !== JSON.stringify(app)
      || captureAiAppResources(inputNodeIds, nodeId).fingerprint !== resources.fingerprint) throw new Error('应用或画布已变化，请重试');
  };
  try {
    const definition = input.definition === undefined ? await loadAiAppDefinition(projectId, app) : normalizeAiAppDefinition(input.definition);
    assertFresh();
    const { validateAiAppCandidate } = await import('./aiAppRuntime');
    await validateAiAppCandidate({ definition, inputNodeIds, savedState: app.savedState, assertFresh, signal: context.signal });
    assertFresh();
    const reference = input.definition === undefined ? app.definition : await writeDefinition(projectId, definition);
    assertFresh();
    useAppStore.getState().updateNodeData(nodeId, {
      label: definition.title, aiApp: { ...app, definition: reference, title: definition.title,
        description: definition.description, actions: definition.actions, inputNodeIds, revision: app.revision + 1 },
    });
    useAppStore.getState().incrementRevision();
  } finally {
    completeCanvasDerivation(guard);
  }
}

export function saveAiAppState(nodeId: string, state: unknown, result: unknown,
  expectedRevision: number, context: AiAppMutationContext): void {
  assertAiAppContext(context);
  const { app } = getAiAppNode(nodeId, context.projectId);
  if (app.revision !== expectedRevision) throw new Error('应用版本已变化，请重新读取后再保存');
  const savedState = normalizeAiAppJson(state);
  const savedResult = result === undefined ? app.savedResult : normalizeAiAppJson(result);
  useAppStore.getState().updateNodeData(nodeId, {
    aiApp: { ...app, revision: app.revision + 1, savedState, ...(savedResult === undefined ? {} : { savedResult }) },
  });
  useAppStore.getState().incrementRevision();
}

function imageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const header = new TextDecoder().decode(bytes.subarray(0, 12));
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  throw new Error('首版应用只支持 PNG、JPEG、GIF 和 WebP 图片');
}

export async function readAiAppImage(projectId: string, inputNodeIds: string[], nodeId: string): Promise<string> {
  if (!inputNodeIds.includes(nodeId) || useAppStore.getState().currentProjectId !== projectId) throw new Error('素材不在本次应用授权范围内');
  const node = useAppStore.getState().nodes.find((entry) => entry.id === nodeId);
  const source = node?.data.thumbnailUrl || node?.data.imageUrl;
  if (!source) throw new Error('绑定节点没有可读取的图片');
  if (source.startsWith('data:')) {
    if (source.length > 3 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/]+=*$/u.test(source)) {
      throw new Error('图片数据格式不支持或超过 2 MiB 读取上限');
    }
    const bytes = Uint8Array.from(atob(source.slice(source.indexOf(',') + 1)), (character) => character.charCodeAt(0));
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('图片超过 2 MiB 读取上限');
    return `data:${imageMime(bytes)};base64,${arrayBufferToBase64(Uint8Array.from(bytes).buffer)}`;
  }
  const root = await getProjectDataDir(projectId);
  const path = (localMediaUrlToPath(source) ?? source).replace(/\\/gu, '/');
  const prefix = `${root?.replace(/\\/gu, '/').replace(/\/$/u, '')}/`;
  if (!root || !path.startsWith(prefix)) throw new Error('图片尚未保存到当前项目，请先保存素材');
  const data = await readBoundedProjectFile({ projectId, relativePath: path.slice(prefix.length), maxBytes: 2 * 1024 * 1024 });
  return `data:${imageMime(data)};base64,${arrayBufferToBase64(Uint8Array.from(data).buffer)}`;
}

export function describeAiApp(nodeId: string) {
  const { app } = getAiAppNode(nodeId);
  return { nodeId, title: app.title, description: app.description, revision: app.revision,
    actions: app.actions, inputNodeIds: app.inputNodeIds, savedState: app.savedState, savedResult: app.savedResult ?? null };
}
