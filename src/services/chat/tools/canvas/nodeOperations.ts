import type { Edge, Node } from '@xyflow/react';
import { invoke } from '@tauri-apps/api/core';
import { getLastCanvasPointerPosition } from '../../../canvasPointerService';
import { workflowExecution } from '../../../workflowExecutionService';
import { useAppStore } from '../../../../store/useAppStore';
import { pickImageOutputParameters } from '../../../ai/imageOutputParameters';
import { generateId } from '../../../../store/store.utils';
import type { BaseNodeData, NodeType } from '../../../../types';
import type { DramaAsset } from '../../../../types/dramaAssets';
import { parseDramaMentionId } from '../../../../types/dramaAssets';
import { parseShotlistRowMentionId, resolveShotVideoDuration } from '../../../../types/shotlist';
import type { CommandId, CommandPlan } from '../../../../types/chat';
import { getProjectModelKind, parseProjectModelRef } from '../../../projectSettingsService';
import { nodeHeightForAspectRatio, videoNodeDimensionsForAspectRatio } from '../../../../utils/nodeBounds';
import { textNodeHeight } from '../../../../utils/num';
import { executeCommand, logOperation } from '../../commandRegistry';
import { getCanvasNodeHash, matchesCanvasNodeSnapshot } from '../../canvasNodeVersion';
import { type AgentToolContext, type AgentToolExecutionResult } from '../../toolRegistry';
import { listConfiguredModels } from '../appTools';
import { normalizeAiAppReference } from '../../../aiApps/aiAppSchema';
import { findDramaAsset, listGlobalDramaAssets, preferDramaLibraryReferences, preferredDramaMentionForNode } from '../../../dramaAssetPrompt';
import { AGENT_NODE_LAYOUT } from '../../agentCanvasLayout';
import { getProjectDataDir, isTauriEnv, readAssetTextFile, saveAssetTextFile, stripVerbatimPrefix, type AssetTextSnapshot } from '../../../fileService';
import { findMissingSingleCloudOutputFields, type ArchiveAssetDigest } from '../../../projectExchangeDomain';
import { registerCanvasImport, isCanvasDerivationFresh, completeCanvasDerivation } from '../../../canvasDerivationGuard';
import {
  VISUAL_NODE_TYPES,
  isSourceNodeType,
  resolveNodeBody,
  TEXT_OUTPUT_NODE_TYPES,
  TEXT_FILE_NODE_TYPES,
  videoResolutionPatch,
  visibleVideoResolution,
  imageOutputNodePatch,
  mediaSettingsIssue,
  DETAIL_TEXT_LIMIT,
  DETAIL_NODE_LIMIT,
  TEXT_READ_LIMIT,
  TEXT_READ_CONTENT_LIMIT,
  type NodeTargetInput,
  type CreateNodeInput,
  type CanvasPoint,
  type CanvasRect,
  DEFAULT_NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  COMMENT_NODE_HEIGHT,
  MAX_LOCAL_LAYOUT_CANDIDATES,
  NODE_REFERENCE_PATTERN,
  type QueryNodesInput,
  type NodeUpdatePatch,
  type NodeAuditSnapshot,
  captureNodeAudit,
  isSourceOnlyNode,
} from './nodeInputs';

export function isCurrentProject(projectId: string): boolean {
  return useAppStore.getState().currentProjectId === projectId;
}

export function authorizeCurrentProject(context: { projectId: string }) {
  return isCurrentProject(context.projectId)
    ? { allowed: true }
    : { allowed: false, reason: '目标项目当前未加载，不能操作其他项目的画布' };
}

export function assertCanvasRevision(context: AgentToolContext): void {
  const currentRevision = useAppStore.getState().getCurrentRevision();
  if (
    context.baseRevision !== undefined
    && currentRevision !== context.baseRevision
  ) {
    throw new Error(
      `画布已变更（rev ${currentRevision} ≠ ${context.baseRevision}），请重新规划`,
    );
  }
}

/** 只移除明确指定、父项目资产已不存在的 token，完整提示词始终由宿主读取。 */
export function removeMissingDramaMentions(context: AgentToolContext, targetIds: string[], mentionIds: string[]): AgentToolExecutionResult {
  const store = useAppStore.getState();
  if (context.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
  if (store.currentProjectId !== context.projectId || store.projectLoadStatus !== 'ready'
    || store.switchingProjectName !== null || store.isCreatingProject || store.isReturningToStartPage) {
    throw new Error('目标项目尚未加载完成，不能清理资产引用');
  }
  assertCanvasRevision(context);
  const requested = new Set(mentionIds);
  if (!requested.size || [...requested].some((id) => {
    const { assetId } = parseDramaMentionId(id);
    return !/^[^:{}\r\n]+$/.test(id) || !assetId || assetId.startsWith('global/') || !!findDramaAsset(store.dramaAssets, assetId);
  })) {
    const message = '只能清理父项目资产已不存在的指定引用；有效资产和全局资产引用未修改';
    return { status: 'error', summary: message, modelContent: message };
  }
  const changes = store.nodes.filter((node) => targetIds.includes(node.id)).flatMap((node) => {
    if (typeof node.data.prompt !== 'string') return [];
    let removedCount = 0;
    const prompt = node.data.prompt.replace(/@drama\{([^:{}\r\n]+):([^{}\r\n]*)\}/g, (token, id: string, label: string) => {
      if (!requested.has(id)) return token;
      removedCount += 1;
      return label;
    });
    return removedCount ? [{ node, prompt, removedCount }] : [];
  });
  if (changes.length) {
    store.commitToHistory();
    for (const { node, prompt } of changes) store.updateNodeDataTransient(node.id, { prompt });
    store.incrementRevision();
  }
  const removedCount = changes.reduce((sum, change) => sum + change.removedCount, 0);
  return {
    status: 'success',
    summary: removedCount ? `已移除 ${changes.length} 个节点的 ${removedCount} 处失效资产引用，保留显示名称和其余提示词`
      : '目标提示词中未发现指定失效引用，未修改节点',
    modelContent: JSON.stringify({ affectedNodeIds: changes.map(({ node }) => node.id), removedCount,
      revision: useAppStore.getState().getCurrentRevision(),
      nodes: changes.map(({ node, removedCount: count }) => ({ nodeId: node.id, removedCount: count })) }),
  };
}

/** 原生清单仅用于核对既有缓存，不允许调用方提供路径或任意节点数据。 */
export async function repairMissingCloudOutputs(context: AgentToolContext, targetIds: string[]): Promise<AgentToolExecutionResult> {
  if (!isTauriEnv()) {
    const message = '缺失云工作流产物缓存修复仅在桌面端可用';
    return { status: 'error', summary: message, modelContent: message };
  }
  const initial = useAppStore.getState();
  if (initial.currentProjectId !== context.projectId || initial.projectLoadStatus !== 'ready') {
    throw new Error('目标项目尚未加载完成，不能修复产物缓存');
  }
  const targets = initial.nodes.filter((node) => targetIds.includes(node.id));
  const guard = registerCanvasImport(initial);
  if (!guard) throw new Error('无法锁定当前项目，请重新查询后操作');
  const assertFresh = () => {
    const current = useAppStore.getState();
    if (context.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (!isCanvasDerivationFresh(guard, current) || current.projectLoadStatus !== 'ready'
      || targets.some((target) => current.nodes.find((node) => node.id === target.id)?.data !== target.data)) {
      throw new Error('项目、画布或节点素材已变化，请重新查询后修复');
    }
    assertCanvasRevision(context);
  };
  const counts = (data: BaseNodeData) => ({
    runninghubOutputs: Array.isArray(data.runninghubOutputs) ? data.runninghubOutputs.length : 0,
    workflowApiOutputs: Array.isArray(data.workflowApiOutputs) ? data.workflowApiOutputs.length : 0,
  });
  try {
    assertFresh();
    const directory = await getProjectDataDir(context.projectId).catch(() => {
      throw new Error('无法读取当前项目素材目录，未修改节点');
    });
    assertFresh();
    if (!directory) throw new Error('无法读取当前项目素材目录，未修改节点');
    // 原生命令再次限定主窗口与受授权的项目目录。
    const assets = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: directory }).catch(() => {
      throw new Error('无法读取项目真实素材清单，未修改节点');
    });
    assertFresh();
    const byPath = new Map(assets.map((asset) => [asset.path, asset]));
    const portablePaths = new Set(assets.map((asset) => asset.path.normalize('NFC').toLowerCase()));
    const repairs = targets.map((node) => ({ node,
      fields: findMissingSingleCloudOutputFields(node.data as Record<string, unknown>, byPath, directory, portablePaths) }));
    const changed = repairs.filter((repair) => repair.fields.length > 0);
    assertFresh();
    if (changed.length) {
      const current = useAppStore.getState();
      current.commitToHistory();
      for (const { node, fields } of changed) {
        current.updateNodeDataTransient(node.id, Object.fromEntries(fields.map((field) => [field, undefined])));
      }
      current.incrementRevision();
    }
    const current = useAppStore.getState();
    return {
      status: 'success',
      summary: changed.length ? `已修复 ${changed.length} 个节点的缺失单产物缓存，当前主图保持不变`
        : '未发现可安全清理的缺失单产物缓存，未修改节点',
      modelContent: JSON.stringify({
        affectedNodeIds: changed.map(({ node }) => node.id), revision: current.getCurrentRevision(),
        nodes: repairs.map(({ node, fields }) => ({
          nodeId: node.id, label: node.data.label, clearedFields: fields,
          primaryStatus: fields.length ? 'exists' : 'not_confirmed',
          beforeCounts: counts(node.data),
          afterCounts: counts(current.nodes.find((entry) => entry.id === node.id)?.data ?? node.data),
        })),
      }),
    };
  } finally {
    completeCanvasDerivation(guard);
  }
}

export interface TextFileTarget {
  nodeId: string;
  nodeType: NodeType;
  filePath: string | undefined;
  previousOutput: string | undefined;
  content: string;
}

interface TextFileUpdate extends TextFileTarget {
  filePath: string;
  baseline?: AssetTextSnapshot;
  state: 'write' | 'unchanged' | 'conflict' | 'read_failed';
}

/** 与 saveAssetTextFile 的同窗口串行键一致；原始路径仍只交给文件层。 */
export function textFileSaveKey(path: string): string {
  const normalized = stripVerbatimPrefix(path).replace(/\\/g, '/');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

export function textFileTargetsFresh(context: AgentToolContext, revision: number, targets: TextFileTarget[], committed = false): boolean {
  const current = useAppStore.getState();
  return !context.signal.aborted && current.currentProjectId === context.projectId
    && current.getCurrentRevision() === revision && targets.every((target) => {
      const node = current.nodes.find((item) => item.id === target.nodeId);
      return node?.data.type === target.nodeType && node.data.filePath === target.filePath
        && node.data.output === (committed ? target.content : target.previousOutput);
    });
}

/** 真实磁盘基线先整批读完；只准备状态，由入口决定是否保留新草稿。 */
export async function prepareTextFileUpdates(context: AgentToolContext, targets: TextFileTarget[], revision: number): Promise<TextFileUpdate[]> {
  const updates: TextFileUpdate[] = targets
    .filter((target) => TEXT_FILE_NODE_TYPES.has(target.nodeType) && target.filePath)
    .map((target): TextFileUpdate => ({ ...target, filePath: target.filePath!, state: 'read_failed' }));
  const assertFresh = () => {
    if (!textFileTargetsFresh(context, revision, targets)) throw new Error('项目、画布或文本文件关联已变化，请重新查询后操作');
  };
  for (const update of updates) {
    assertFresh();
    try {
      update.baseline = await readAssetTextFile(update.filePath, context.signal);
      const previous = (update.previousOutput || '').replace(/\r\n/g, '\n');
      update.state = update.baseline.content === update.content.replace(/\r\n/g, '\n') ? 'unchanged'
        : update.baseline.content === previous ? 'write' : 'conflict';
    } catch {
      update.state = 'read_failed';
    }
    assertFresh();
  }
  return updates;
}

/** 画布只提交一次；各文件沿用已有摘要 CAS，失败不重试、不回滚草稿或已写入的文件。 */
export type TextFilePersistenceStatus = 'saved' | 'unchanged' | 'conflict' | 'read_failed' | 'save_failed' | 'stale';
export async function persistTextFileUpdates(context: AgentToolContext, updates: TextFileUpdate[], targets: TextFileTarget[],
  onProgress?: (nodeId: string, status: TextFilePersistenceStatus | 'saving') => Promise<void>) {
  const revision = useAppStore.getState().getCurrentRevision();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const guard = registerCanvasImport(useAppStore.getState(), abort);
  const fresh = () => !!guard && isCanvasDerivationFresh(guard, useAppStore.getState())
    && textFileTargetsFresh(context, revision, targets, true);
  context.signal.addEventListener('abort', abort, { once: true });
  const unsubscribe = useAppStore.subscribe(() => { if (!fresh()) abort(); });
  const results: Array<{ nodeId: string; status: TextFilePersistenceStatus }> = [];
  const savedPaths = new Set<string>();
  try {
    for (const update of updates) {
      let status: TextFilePersistenceStatus;
      if (!fresh() || controller.signal.aborted) {
        status = 'stale';
      } else if (update.state !== 'write') status = update.state;
      else if (savedPaths.has(textFileSaveKey(update.filePath))) status = 'saved';
      else {
        // keyed调用的保存意图先持久化；新增等待后再次检查原文稿/项目租约。
        if (onProgress) await onProgress(update.nodeId, 'saving');
        if (!fresh() || controller.signal.aborted) status = 'stale';
        else {
          try {
            await saveAssetTextFile(update.filePath, update.baseline!, update.content, controller.signal);
            savedPaths.add(textFileSaveKey(update.filePath));
            status = 'saved';
          } catch { status = fresh() && !controller.signal.aborted ? 'save_failed' : 'stale'; }
        }
      }
      results.push({ nodeId: update.nodeId, status });
      if (onProgress) await onProgress(update.nodeId, status);
    }
    const stale = !fresh() || controller.signal.aborted;
    return { results, stale,
      savedCount: results.filter((item) => item.status === 'saved').length,
      unchangedCount: results.filter((item) => item.status === 'unchanged').length,
      failedCount: results.filter((item) => item.status !== 'saved' && item.status !== 'unchanged').length };
  } finally {
    unsubscribe();
    context.signal.removeEventListener('abort', abort);
    if (guard) completeCanvasDerivation(guard);
  }
}

export async function readGlobalReferenceAssets(context: AgentToolContext): Promise<DramaAsset[]> {
  const owner = useAppStore.getState();
  const revision = owner.getCurrentRevision();
  if (owner.currentProjectId !== context.projectId) throw new Error('目标项目当前未加载');
  let assets: DramaAsset[];
  try { assets = await (await import('../../../globalDramaAssetService')).loadGlobalDramaAssetCards(); }
  catch { assets = []; } // 目录不可读时保留原节点引用，普通画布查询仍可用。
  if (context.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
  const current = useAppStore.getState();
  if (current.currentProjectId !== owner.currentProjectId || current.getCurrentRevision() !== revision) {
    throw new Error('项目或画布已变化，请重新查询后操作');
  }
  return assets;
}

export function hasActualNodeReference(prompt: string): boolean {
  const nodes = useAppStore.getState().nodes;
  return [...prompt.matchAll(/@\{([^:}\r\n]+):[^}\r\n]*\}/g)]
    .some((match) => nodes.some((node) => node.id === match[1]));
}

export function resolveTargetIds(input: NodeTargetInput): string[] {
  const store = useAppStore.getState();
  const matched = new Set<string>();
  const hasFilter = Boolean(
    input.nodeIds?.length
    || input.displayIds?.length
    || input.nodeType
    || input.status
    || input.selected,
  );
  if (!hasFilter) return [];

  for (const node of store.nodes) {
    const matches = [
      input.nodeIds?.length ? input.nodeIds.includes(node.id) : true,
      input.displayIds?.length ? input.displayIds.includes(Number(node.data.displayId)) : true,
      input.nodeType ? node.type === input.nodeType : true,
      input.status ? node.data.status === input.status : true,
      input.selected ? store.selectedNodeIds.includes(node.id) : true,
    ].every(Boolean);
    if (matches) matched.add(node.id);
  }
  return [...matched];
}

export function queryNodes(input: QueryNodesInput): Node<BaseNodeData>[] {
  const state = useAppStore.getState();
  if (input.nodeIds?.length === 0 || input.displayIds?.length === 0) return [];
  const hasTargets = input.nodeIds !== undefined || input.displayIds !== undefined
    || input.nodeType !== undefined || input.status !== undefined || input.selected === true;
  const targetIds = hasTargets ? new Set(resolveTargetIds(input)) : undefined;
  const normalizeName = (value: string) => value.normalize('NFKC').trim().toLowerCase();
  const name = input.name === undefined ? undefined : normalizeName(input.name);
  return state.nodes.filter((node) => (!targetIds || targetIds.has(node.id))
    && (name === undefined || [node.data.displayLabel, node.data.fileName, node.data.label].some((value) => {
      if (!value) return false;
      const candidate = normalizeName(value);
      return input.nameMatch === 'exact' ? candidate === name : candidate.includes(name);
    })));
}

export function captureNodeVersionContext(projectId: string) {
  const state = useAppStore.getState();
  const settings = state.projects.find((project) => project.id === projectId)?.settings;
  return { revision: state.getCurrentRevision(), settings, settingsSnapshot: JSON.stringify(settings) };
}
type NodeVersionContext = ReturnType<typeof captureNodeVersionContext>;

export function assertNodeVersionSnapshot(context: AgentToolContext, nodes: Node<BaseNodeData>[], version: NodeVersionContext): void {
  if (context.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
  const state = useAppStore.getState();
  const settings = state.projects.find((project) => project.id === context.projectId)?.settings;
  if (state.currentProjectId !== context.projectId || state.getCurrentRevision() !== version.revision
    || JSON.stringify(settings) !== version.settingsSnapshot
    || nodes.some((node) => !matchesCanvasNodeSnapshot(node, state.nodes.find((item) => item.id === node.id)))) {
    throw new Error('项目、节点或项目设置已变化，请重新读取后操作');
  }
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length
    && text.charCodeAt(offset - 1) >= 0xD800 && text.charCodeAt(offset - 1) <= 0xDBFF
    && text.charCodeAt(offset) >= 0xDC00 && text.charCodeAt(offset) <= 0xDFFF;
}

export async function readCanvasText(context: AgentToolContext, input: QueryNodesInput, matched: Node<BaseNodeData>[]): Promise<AgentToolExecutionResult> {
  const reject = (message: string): AgentToolExecutionResult => ({ status: 'error', summary: message, modelContent: message, retryable: false });
  if (input.textField !== 'prompt' && input.textField !== 'output') return reject('textField 仅允许 prompt 或 output');
  if (!(input.nodeIds?.length || input.displayIds?.length) || matched.length !== 1) {
    return reject('读取长文字必须用 nodeIds 或 displayIds 明确定位且恰好匹配一个节点');
  }
  const node = matched[0];
  if (input.textField === 'output' && !TEXT_OUTPUT_NODE_TYPES.has(node.data.type)) {
    return reject('output 续读只支持文本类节点，不能读取媒体节点的路径或 URL');
  }
  const value = node.data[input.textField];
  const text = typeof value === 'string' ? value : '';
  const offset = input.textOffset ?? 0;
  const limit = input.textLimit ?? TEXT_READ_LIMIT;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > TEXT_READ_LIMIT) {
    return reject('textOffset 必须是非负安全整数，textLimit 必须是 1 至 4000 的整数');
  }
  if (splitsSurrogatePair(text, offset)) return reject('textOffset 不能位于 Unicode 字符的代理项对中间，请使用上次 nextOffset');
  let end = Math.min(text.length, offset + limit);
  if (splitsSurrogatePair(text, end)) end -= 1;
  if (end === offset && offset < text.length) return reject('textLimit 过小，无法完整返回当前字符，请至少使用 2');
  const version = captureNodeVersionContext(context.projectId);
  const nodeHash = await getCanvasNodeHash(node, context.projectId, version.settings);
  assertNodeVersionSnapshot(context, matched, version);
  while (true) {
    const modelContent = JSON.stringify({
      projectId: context.projectId, nodeId: node.id, textField: input.textField,
      text: text.slice(offset, end), offset, totalLength: text.length,
      nextOffset: end < text.length ? end : null,
      revision: version.revision, nodeHash,
    });
    if (modelContent.length <= TEXT_READ_CONTENT_LIMIT) {
      return { status: 'success', summary: `读取节点${input.textField === 'prompt' ? '提示词' : '正文'}片段`, modelContent };
    }
    end = offset + Math.floor((end - offset) / 2);
    if (splitsSurrogatePair(text, end)) end -= 1;
    if (end <= offset) return reject('节点标识数据超过单次文字读取预算，无法返回完整片段');
  }
}

/** 唯一片段替换不能切入现有引用令牌或 Unicode 代理项对。 */
function promptEditRange(prompt: string, oldText: string): { start: number; end: number } | { error: string } {
  const start = prompt.indexOf(oldText);
  if (start < 0 || prompt.indexOf(oldText, start + 1) !== -1) {
    return { error: '某个目标提示词中的 oldText 不存在或不唯一，请重新读取后明确片段；未修改任何节点' };
  }
  const end = start + oldText.length;
  if (splitsSurrogatePair(prompt, start) || splitsSurrogatePair(prompt, end)) {
    return { error: 'oldText 不能切入 Unicode 字符的代理项对；未修改任何节点' };
  }
  for (const token of prompt.matchAll(/@(?:asset|drama)?\{[^{}\r\n]*\}/g)) {
    const tokenStart = token.index;
    const tokenEnd = tokenStart + token[0].length;
    if ((start > tokenStart && start < tokenEnd) || (end > tokenStart && end < tokenEnd)) {
      return { error: 'oldText 不能切入节点、资产或剧集引用令牌，请替换完整引用或引用外的文字；未修改任何节点' };
    }
  }
  return { start, end };
}

function truncateText(value: string | undefined, limit = DETAIL_TEXT_LIMIT): {
  text: string;
  truncated: boolean;
} | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > limit
    ? { text: text.slice(0, limit), truncated: true }
    : { text, truncated: false };
}

/**
 * 节点详情。绝不回传 imageUrl / filePath / sourceUrl 等字段：
 * 它们带本机绝对路径，而这份内容会经模型和 MCP 客户端离开本机。
 */
function describeNode(node: Node<BaseNodeData>, globalAssets?: readonly DramaAsset[]): Record<string, unknown> {
  const data = node.data;
  const store = useAppStore.getState();
  let aiApp: Record<string, unknown> | undefined;
  if (node.type === 'ai-app') {
    try {
      const app = normalizeAiAppReference(data.aiApp);
      aiApp = { title: app.title, revision: app.revision,
        actions: app.actions.map((action) => ({ id: action.id, title: action.title })), inputNodeIds: app.inputNodeIds };
    } catch { aiApp = { unavailable: true }; }
  }
  // 缩略图仅作为没有主产物时的图片预览，不能盖过视频、音频或正文。
  const outputKind = data.videoUrl
    ? 'video'
    : data.audioUrl
      ? 'audio'
      : data.imageUrl
        ? 'image'
        : TEXT_OUTPUT_NODE_TYPES.has(data.type) && data.output
          ? 'text'
          : data.thumbnailUrl ? 'image' : null;
  return {
    id: node.id,
    displayId: data.displayId,
    type: node.type,
    label: data.label,
    displayLabel: data.displayLabel || data.fileName || data.label,
    dramaAssetId: data.dramaAssetId,
    dramaAssetKind: data.dramaAssetKind,
    preferredMention: preferredDramaMentionForNode(node.id, store.nodes, store.dramaAssets, globalAssets ?? listGlobalDramaAssets(store)),
    role: data.role,
    status: data.status ?? 'idle',
    position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    size: {
      width: Math.round(Number(data.nodeWidth) || node.measured?.width || DEFAULT_NODE_WIDTH),
      height: Math.round(Number(data.nodeHeight) || node.measured?.height || DEFAULT_NODE_HEIGHT),
    },
    parentId: node.parentId,
    model: data.model,
    aspectRatio: data.type === 'ai-video' ? data.seedanceRatio : data.aspectRatio,
    imageSize: data.imageSize,
    imageQuality: data.imageQuality,
    imageBackground: data.imageBackground,
    ...pickImageOutputParameters(data),
    batchCount: data.batchCount,
    videoResolution: visibleVideoResolution(data),
    videoLongSide: data.videoResolution,
    videoResolutionPreset: data.seedanceResolution,
    videoDuration: data.seedanceDuration,
    videoFps: data.videoFps,
    generateAudio: data.generateAudio,
    audioPurpose: data.audioPurpose,
    audioVoice: data.audioVoice,
    audioFormat: data.audioFormat,
    audioSpeed: data.audioSpeed,
    audioSpeechSettings: data.audioSpeechSettings && {
      voiceStyle: data.audioSpeechSettings.voiceStyle,
      pace: data.audioSpeechSettings.pace,
      duration: data.audioSpeechSettings.duration,
    },
    musicDuration: data.musicDuration,
    musicBpm: data.musicBpm,
    musicTitle: data.musicTitle,
    musicLyrics: truncateText(data.musicLyrics),
    autoGenerateLyrics: data.autoGenerateLyrics,
    workflowId: data.workflowId,
    prompt: truncateText(data.prompt),
    outputKind,
    outputText: outputKind === 'text' ? truncateText(data.output) : undefined,
    ...(aiApp ? { aiApp } : {}),
  };
}

export function buildCanvasDetail(scoped: Node<BaseNodeData>[], input: QueryNodesInput, globalAssets?: readonly DramaAsset[]): Record<string, unknown> {
  const store = useAppStore.getState();
  const offset = input.offset ?? 0;
  const maxNodes = Math.min(input.limit ?? DETAIL_NODE_LIMIT, DETAIL_NODE_LIMIT);
  const nodes = scoped.slice(offset, offset + maxNodes);
  const nextOffset = offset + nodes.length;
  const hasMore = nextOffset < scoped.length;
  const visibleIds = new Set(nodes.map((node) => node.id));
  return {
    projectId: store.currentProjectId,
    revision: store.getCurrentRevision(),
    nodeCount: store.nodes.length,
    edgeCount: store.edges.length,
    matchedCount: scoped.length,
    offset,
    returned: nodes.length,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
    selectedNodeIds: store.selectedNodeIds,
    nodes: nodes.map((node) => input.detail ? describeNode(node, globalAssets) : {
      id: node.id, displayId: node.data.displayId, type: node.type,
      label: node.data.label, displayLabel: node.data.displayLabel || node.data.fileName || node.data.label,
      status: node.data.status ?? 'idle',
    }),
    // 只给出与返回节点相关的连线，避免整张图铺满上下文
    ...(input.detail ? {
      edges: store.edges
        .filter((edge) => visibleIds.has(edge.source) || visibleIds.has(edge.target))
        .map((edge) => ({
          id: edge.id, source: edge.source, target: edge.target,
          sourceHandle: edge.sourceHandle ?? null, targetHandle: edge.targetHandle ?? null,
          layout: describeConnectionLayout(edge.source, edge.target, store.nodes),
        })),
    } : {}),
    truncated: offset > 0 || hasMore,
  };
}

/** 校验模型引用是否已配置且与目标节点类型匹配，返回可直接合并的节点补丁。 */
export function resolveModelPatch(
  modelRef: string,
  targets: Node<BaseNodeData>[],
): { patch: Partial<BaseNodeData> } | { error: string } {
  const option = listConfiguredModels(useAppStore.getState())
    .find((model) => model.id === modelRef);
  if (!option) {
    return { error: `模型“${modelRef}”未配置；先用 app_get_state 查询可用模型 ID` };
  }
  const mismatched = targets.filter(
    (node) => getProjectModelKind(node.type) !== option.category,
  );
  if (mismatched.length > 0) {
    return {
      error: `模型“${option.name}”是${option.category}模型，与 ${mismatched.length} 个目标节点的类型不匹配`,
    };
  }
  // ComfyUI 工作流靠 workflowId 走本地执行路径，只写 model 会在生成时找不到工作流
  if (option.provider === 'runninghubwf' || option.provider === 'workflow-api') {
    const workflow = useAppStore.getState().workflows.find((item) => `${option.provider}/${item.id}` === option.id);
    if (!workflow) return { error: '云工作流未导入' };
    return { patch: { ...workflowExecution(workflow), workflowInputs: undefined } };
  }
  if (option.provider === 'comfyui') {
    return {
      patch: { model: 'comfyui/workflow', provider: 'comfyui', workflowId: option.id.slice('comfyui/'.length) },
    };
  }
  return {
    patch: {
      model: option.id,
      provider: parseProjectModelRef(option.id)?.provider ?? option.provider,
    },
  };
}

function buildCommandPlan(
  commandId: CommandId,
  targetNodeIds: string[],
  context: AgentToolContext,
  summary: string,
): CommandPlan {
  return {
    id: `agent-plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: context.projectId,
    baseRevision: context.baseRevision ?? useAppStore.getState().getCurrentRevision(),
    commandId,
    targetNodeIds,
    params: {},
    summary,
    risk: commandId === 'query' || commandId === 'select' ? 'read' : 'low',
    requiresConfirm: false,
  };
}

export async function executeCanvasCommand(
  commandId: CommandId,
  targetNodeIds: string[],
  context: AgentToolContext,
  summary: string,
): Promise<AgentToolExecutionResult> {
  const result = await executeCommand(buildCommandPlan(
    commandId,
    targetNodeIds,
    context,
    summary,
  ));
  const succeeded = result.status === 'success' || result.status === 'partial';
  if (
    succeeded
    && !['query', 'select'].includes(commandId)
    && result.status === 'success'
  ) {
    useAppStore.getState().incrementRevision();
  }
  logOperation({
    projectId: context.projectId,
    conversationId: context.conversationId,
    commandId,
    summary,
    targetNodeIds: result.affectedNodeIds,
    parseSource: 'llm',
    status: result.status === 'rejected' ? 'failed' : result.status,
    undoable: !['query', 'select'].includes(commandId),
    historyIndex: result.historyIndex,
    errorCode: result.errorCode,
    timestamp: Date.now(),
  });
  return {
    status: succeeded ? 'success' : 'error',
    summary: result.message,
    modelContent: JSON.stringify({
      affectedNodeIds: result.affectedNodeIds,
      message: result.message,
      revision: useAppStore.getState().getCurrentRevision(),
    }),
    errorCode: result.errorCode,
  };
}

/**
 * 节点框大小按内容推断，避免一批节点全是同样的 280x160：
 * 分镜表使用专属默认尺寸，视觉节点按比例撑开，文本节点按正文行数撑高。
 * 布局排布和真正落库的节点共用这里，两边尺寸必须一致，否则会算错碰撞。
 */
function getNodeDimensions(input: CreateNodeInput): { width: number; height: number } {
  // 为摄影、景别/运镜和正文列预留空间；排布、落库与返回尺寸使用同一值。
  if (input.type === 'ai-shotlist') return { width: 1920, height: 640 };
  if (input.type === 'ai-video') {
    const dimensions = videoNodeDimensionsForAspectRatio(input.aspectRatio, DEFAULT_NODE_WIDTH);
    return dimensions
      ? { width: dimensions.nodeWidth, height: dimensions.nodeHeight }
      : { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
  }
  if (input.aspectRatio && VISUAL_NODE_TYPES.has(input.type)) {
    return {
      width: DEFAULT_NODE_WIDTH,
      height: nodeHeightForAspectRatio(input.aspectRatio, DEFAULT_NODE_WIDTH),
    };
  }
  const content = resolveNodeBody(input);
  if (content) {
    return {
      width: DEFAULT_NODE_WIDTH,
      height: textNodeHeight(content.split('\n').length),
    };
  }
  return {
    width: DEFAULT_NODE_WIDTH,
    height: input.type === 'comment' ? COMMENT_NODE_HEIGHT : DEFAULT_NODE_HEIGHT,
  };
}

function getAbsoluteNodePosition(node: Node<BaseNodeData>, nodes: Node<BaseNodeData>[]): CanvasPoint {
  const position = { ...node.position };
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodes.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    position.x += parent.position.x;
    position.y += parent.position.y;
    parentId = parent.parentId;
  }
  return position;
}

function getExistingNodeRect(node: Node<BaseNodeData>, nodes: Node<BaseNodeData>[]): CanvasRect {
  const position = getAbsoluteNodePosition(node, nodes);
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : undefined;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : undefined;
  return {
    ...position,
    width: Number(node.data?.nodeWidth) || node.measured?.width || styleWidth || DEFAULT_NODE_WIDTH,
    height: Number(node.data?.nodeHeight) || node.measured?.height || styleHeight || DEFAULT_NODE_HEIGHT,
  };
}

function getRectBounds(rects: CanvasRect[]): CanvasRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function rectsOverlap(first: CanvasRect, second: CanvasRect): boolean {
  return first.x < second.x + second.width + AGENT_NODE_LAYOUT.collisionGap
    && first.x + first.width + AGENT_NODE_LAYOUT.collisionGap > second.x
    && first.y < second.y + second.height + AGENT_NODE_LAYOUT.collisionGap
    && first.y + first.height + AGENT_NODE_LAYOUT.collisionGap > second.y;
}

function resolveReferencedNodes(taskId: string, nodes: Node<BaseNodeData>[], inputs: CreateNodeInput[]): Node<BaseNodeData>[] {
  const task = useAppStore.getState().agentTasks.find((candidate) => candidate.id === taskId);
  // MCP 任务标题不含 prompt；与自动连线保持一致，只把生成指令里的引用视作依赖。
  const referenceTexts = [task?.goal ?? '', ...inputs
    .filter((input) => !isSourceNodeType(input.type) && !input.content?.trim())
    .map((input) => input.prompt ?? '')];
  const referencedIds = new Set(
    referenceTexts.flatMap((text) => [...text.matchAll(NODE_REFERENCE_PATTERN)]
      .map((match) => resolvePromptReferenceSourceId(match[1].trim()))),
  );
  return nodes.filter((node) => referencedIds.has(node.id));
}

export function resolveCreateNodePositions(
  context: AgentToolContext,
  inputs: CreateNodeInput[],
): CanvasPoint[] {
  const store = useAppStore.getState();
  const existingNodes = store.nodes;
  const obstacles = existingNodes.map((node) => getExistingNodeRect(node, existingNodes));
  const entries = inputs.map((input, index) => ({ input, index, dimensions: getNodeDimensions(input) }));
  const autoEntries = entries.filter(({ input }) => input.x === undefined || input.y === undefined);
  for (const { input, dimensions } of entries) {
    if (input.x !== undefined && input.y !== undefined) {
      obstacles.push({ x: input.x, y: input.y, ...dimensions });
    }
  }
  const positions = inputs.map((input) => ({
    x: input.x ?? 0,
    y: input.y ?? 0,
  }));
  if (autoEntries.length === 0) return positions;

  const columns = Math.min(3, autoEntries.length);
  const rows = Math.ceil(autoEntries.length / columns);
  const columnWidths = Array<number>(columns).fill(0);
  const rowHeights = Array<number>(rows).fill(0);
  autoEntries.forEach(({ dimensions }, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(columnWidths[column], dimensions.width);
    rowHeights[row] = Math.max(rowHeights[row], dimensions.height);
  });
  const columnOffsets = columnWidths.map((_, index) => columnWidths.slice(0, index)
    .reduce((sum, width) => sum + width + AGENT_NODE_LAYOUT.columnGap, 0));
  const rowOffsets = rowHeights.map((_, index) => rowHeights.slice(0, index)
    .reduce((sum, height) => sum + height + AGENT_NODE_LAYOUT.rowGap, 0));
  const clusterWidth = columnOffsets[columns - 1] + columnWidths[columns - 1];
  const clusterHeight = rowOffsets[rows - 1] + rowHeights[rows - 1];

  const buildLayout = (anchor: CanvasPoint) => autoEntries.map(({ input, index, dimensions }, layoutIndex) => {
    const column = layoutIndex % columns;
    const row = Math.floor(layoutIndex / columns);
    return {
      index,
      position: {
        x: input.x ?? Math.round(anchor.x + columnOffsets[column]),
        y: input.y ?? Math.round(anchor.y + rowOffsets[row]),
      },
      dimensions,
    };
  });

  const isLayoutFree = (anchor: CanvasPoint) => {
    const layoutRects = buildLayout(anchor).map(({ position, dimensions }) => ({
      ...position,
      width: dimensions.width,
      height: dimensions.height,
    }));
    return layoutRects.every((rect, index) => (
      obstacles.every((obstacle) => !rectsOverlap(rect, obstacle))
      && layoutRects.slice(index + 1).every((other) => !rectsOverlap(rect, other))
    ));
  };

  const referencedNodes = resolveReferencedNodes(context.taskId, existingNodes, inputs);
  const referencedBounds = getRectBounds(
    referencedNodes.map((node) => getExistingNodeRect(node, existingNodes)),
  );
  const canvasBounds = getRectBounds(obstacles);
  const candidates: CanvasPoint[] = [];

  if (referencedBounds) {
    const centeredX = referencedBounds.x + (referencedBounds.width - clusterWidth) / 2;
    const centeredY = referencedBounds.y + (referencedBounds.height - clusterHeight) / 2;
    candidates.push(
      { x: referencedBounds.x + referencedBounds.width + AGENT_NODE_LAYOUT.anchorGap, y: centeredY },
      { x: centeredX, y: referencedBounds.y + referencedBounds.height + AGENT_NODE_LAYOUT.anchorGap },
      { x: centeredX, y: referencedBounds.y - clusterHeight - AGENT_NODE_LAYOUT.anchorGap },
      { x: referencedBounds.x - clusterWidth - AGENT_NODE_LAYOUT.anchorGap, y: centeredY },
    );
  } else {
    const pointerPosition = getLastCanvasPointerPosition();
    if (pointerPosition) candidates.push(pointerPosition);
  }

  if (canvasBounds) {
    candidates.push({
      x: canvasBounds.x + canvasBounds.width + AGENT_NODE_LAYOUT.anchorGap,
      y: referencedBounds?.y ?? canvasBounds.y,
    });
  }
  if (candidates.length === 0) candidates.push({ x: 300, y: 200 });

  // 就近列被占用时先尝试上下空位，避免因无关远端节点把整批推到画布最右。
  const preferredAnchor = candidates[0];
  if (!isLayoutFree(preferredAnchor)) {
    const nearbyByPosition = new Map<string, CanvasPoint>();
    const addNearby = (position: CanvasPoint) => {
      if (referencedBounds && position.x < preferredAnchor.x) return;
      nearbyByPosition.set(`${position.x}:${position.y}`, position);
    };
    // 用真实布局找障碍；只传 x 或 y 时，名义锚点与节点实际位置可能不同。
    for (const entry of buildLayout(preferredAnchor)) {
      const { input } = entries[entry.index];
      const offsetX = entry.position.x - preferredAnchor.x;
      const offsetY = entry.position.y - preferredAnchor.y;
      for (const obstacle of obstacles) {
        if (input.y === undefined && entry.position.x < obstacle.x + obstacle.width + AGENT_NODE_LAYOUT.collisionGap
          && entry.position.x + entry.dimensions.width + AGENT_NODE_LAYOUT.collisionGap > obstacle.x) {
          addNearby({ x: preferredAnchor.x, y: obstacle.y + obstacle.height + AGENT_NODE_LAYOUT.rowGap - offsetY });
          addNearby({ x: preferredAnchor.x, y: obstacle.y - entry.dimensions.height - AGENT_NODE_LAYOUT.rowGap - offsetY });
        }
        if (input.x === undefined && entry.position.y < obstacle.y + obstacle.height + AGENT_NODE_LAYOUT.collisionGap
          && entry.position.y + entry.dimensions.height + AGENT_NODE_LAYOUT.collisionGap > obstacle.y) {
          addNearby({ x: obstacle.x + obstacle.width + AGENT_NODE_LAYOUT.columnGap - offsetX, y: preferredAnchor.y });
          addNearby({ x: obstacle.x - entry.dimensions.width - AGENT_NODE_LAYOUT.columnGap - offsetX, y: preferredAnchor.y });
        }
      }
    }
    const distance = (position: CanvasPoint) => (position.x - preferredAnchor.x) ** 2 + (position.y - preferredAnchor.y) ** 2;
    const nearby = [...nearbyByPosition.values()]
      .sort((first, second) => distance(first) - distance(second))
      .slice(0, MAX_LOCAL_LAYOUT_CANDIDATES);
    candidates.splice(1, 0, ...nearby);
  }

  const anchor = candidates.find(isLayoutFree);
  if (!anchor) throw new Error('无法在保留指定坐标的同时避免节点重叠，请省略 x/y 自动排布，或调整指定坐标后重试。');
  for (const entry of buildLayout(anchor)) positions[entry.index] = entry.position;
  return positions;
}

export function createCanvasNode(
  input: CreateNodeInput,
  index: number,
  position: CanvasPoint,
): Node<BaseNodeData> {
  const id = `node-agent-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 7)}`;
  const type = input.type;
  const body = resolveNodeBody(input);
  const isSource = isSourceNodeType(type) || Boolean(input.content?.trim());
  const prompt = isSourceNodeType(type) && !input.content ? undefined : input.prompt?.trim();
  const dimensions = getNodeDimensions(input);
  const dramaAsset = input.dramaAssetId ? findDramaAsset(useAppStore.getState().dramaAssets, input.dramaAssetId) : undefined;
  return {
    id,
    type,
    position,
    data: {
      label: input.label.trim(),
      type,
      role: isSource ? 'source' : 'generator',
      ...(body ? { output: body } : {}),
      ...(prompt ? { prompt } : {}),
      ...(dramaAsset ? { dramaAssetId: dramaAsset.id, dramaAssetKind: dramaAsset.kind } : {}),
      ...(input.imageSize !== undefined ? { imageSize: input.imageSize } : {}),
      ...(input.imageQuality !== undefined ? { imageQuality: input.imageQuality } : {}),
      ...(input.imageBackground !== undefined ? { imageBackground: input.imageBackground } : {}),
      ...imageOutputNodePatch(input),
      ...(input.batchCount !== undefined ? { batchCount: input.batchCount } : {}),
      ...(type === 'ai-video' ? videoResolutionPatch(input) : {}),
      ...(type === 'ai-video' && input.videoDuration !== undefined
        ? { seedanceDuration: input.videoDuration < 0 ? input.videoDuration : resolveShotVideoDuration(input.videoDuration) } : {}),
      ...(input.videoFps !== undefined ? { videoFps: input.videoFps } : {}),
      ...(input.generateAudio !== undefined ? { generateAudio: input.generateAudio } : {}),
      ...(type === 'ai-audio' ? {
        ...(input.audioPurpose !== undefined ? { audioPurpose: input.audioPurpose } : {}),
        ...(input.audioVoice !== undefined ? { audioVoice: input.audioVoice } : {}),
        ...(input.audioFormat !== undefined ? { audioFormat: input.audioFormat } : {}),
        ...(input.audioSpeed !== undefined ? { audioSpeed: input.audioSpeed } : {}),
        ...(input.audioSpeechSettings !== undefined ? { audioSpeechSettings: input.audioSpeechSettings } : {}),
        ...(input.musicDuration !== undefined ? { musicDuration: input.musicDuration } : {}),
        ...(input.musicBpm !== undefined ? { musicBpm: input.musicBpm } : {}),
        ...(input.musicTitle !== undefined ? { musicTitle: input.musicTitle } : {}),
        ...(input.musicLyrics !== undefined ? { musicLyrics: input.musicLyrics } : {}),
        ...(input.autoGenerateLyrics !== undefined ? { autoGenerateLyrics: input.autoGenerateLyrics } : {}),
      } : {}),
      ...(input.aspectRatio && VISUAL_NODE_TYPES.has(type)
        ? { aspectRatio: input.aspectRatio, ...(type === 'ai-video' ? { seedanceRatio: input.aspectRatio } : {}) }
        : {}),
      status: body ? 'success' : 'idle',
      nodeWidth: dimensions.width,
      nodeHeight: dimensions.height,
    },
  };
}

/** 端口方向正确不代表布局顺向；按绝对坐标检查分组内外节点的水平间距。 */
export function describeConnectionLayout(sourceId: string, targetId: string, nodes: Node<BaseNodeData>[]) {
  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  if (!source || !target) return null;
  const sourceRect = getExistingNodeRect(source, nodes);
  const targetRect = getExistingNodeRect(target, nodes);
  const sourceRightX = sourceRect.x + sourceRect.width;
  const horizontalGap = targetRect.x - sourceRightX;
  return {
    sourceRightX, targetLeftX: targetRect.x, horizontalGap, recommendedMinGap: AGENT_NODE_LAYOUT.columnGap,
    warning: horizontalGap < AGENT_NODE_LAYOUT.columnGap
      ? `上游应放左、下游应放右，并预留至少 ${AGENT_NODE_LAYOUT.columnGap} 画布单位间距；当前连线可能回绕或过于拥挤，请用 canvas_update_nodes 调整位置后再次查询。`
      : null,
  };
}

/** 宫格与精确镜头都是虚拟引用，画布边仍连接真实的来源节点。 */
function resolvePromptReferenceSourceId(rawNodeId: string): string {
  const nodeId = rawNodeId.trim();
  const shot = parseShotlistRowMentionId(nodeId);
  if (shot) return shot.nodeId;
  if (!nodeId.includes('/cell/')) return nodeId;
  const parts = nodeId.split('/cell/');
  const sourceId = parts[0]?.trim();
  const cellIndex = Number.parseInt(parts[1] ?? '', 10);
  return sourceId && !Number.isNaN(cellIndex) ? sourceId : nodeId;
}

/**
 * 把新生成节点 prompt 中的稳定引用物化为画布边。
 * 必须在 Store 写入前完成全部校验，避免坏引用留下孤立节点或部分连线。
 */
export function buildPromptReferenceEdges(
  createdNodes: Node<BaseNodeData>[],
  existingNodes: Node<BaseNodeData>[],
): { edges: Edge[]; error?: string } {
  const existingById = new Map(existingNodes.map((node) => [node.id, node]));
  const seenConnections = new Set<string>();
  const edges: Edge[] = [];

  for (const targetNode of createdNodes) {
    // 正文节点里的 @ 只是正文；只有会实际运行生成的 prompt 才表达画布依赖。
    if (isSourceOnlyNode(targetNode)) continue;
    const prompt = typeof targetNode.data.prompt === 'string' ? targetNode.data.prompt : '';
    for (const match of prompt.matchAll(NODE_REFERENCE_PATTERN)) {
      const rawSourceId = match[1]?.trim() ?? '';
      const sourceId = resolvePromptReferenceSourceId(rawSourceId);
      const sourceNode = existingById.get(sourceId);
      if (!sourceNode) {
        const message = `新节点「${targetNode.data.label}」引用的节点「${rawSourceId}」不存在，请重新查询画布后再创建`;
        return { edges: [], error: message };
      }
      if (rawSourceId.includes('/shot/')) {
        const reference = parseShotlistRowMentionId(rawSourceId);
        if (!reference || sourceNode.data.type !== 'ai-shotlist'
          || !sourceNode.data.shotlistRows?.some((row) => row.id === reference.rowId)) {
          return { edges: [], error: '引用的分镜表或镜头不存在，请重新读取镜头行后创建' };
        }
      }
      if ((sourceNode.type ?? sourceNode.data.type) === 'group') {
        const message = `新节点「${targetNode.data.label}」引用的「${sourceNode.data.label}」是分组，不能作为内容来源`;
        return { edges: [], error: message };
      }

      const connectionKey = `${sourceId}:${targetNode.id}`;
      if (seenConnections.has(connectionKey)) continue;
      seenConnections.add(connectionKey);
      edges.push({
        id: `edge-${generateId()}`,
        source: sourceId,
        target: targetNode.id,
        sourceHandle: 'right',
        targetHandle: 'left',
      });
    }
  }

  return { edges };
}

export interface PreparedNodeUpdate {
  input: NodeUpdatePatch;
  targetIds: string[];
  targets: Node<BaseNodeData>[];
  patch: Partial<BaseNodeData>;
  promptEdits: Map<string, { before: string; after: string }>;
  beforeAudit: Map<string, NodeAuditSnapshot>;
  moveAbsolute: boolean;
  moveRelative: boolean;
}

/** 单补丁与异构补丁共用全部普通编辑校验；此阶段只准备，不写 Store 或文件。 */
export async function prepareNodeUpdate(
  context: AgentToolContext, input: NodeUpdatePatch, targets: Node<BaseNodeData>[],
  globalAssets: readonly DramaAsset[] | undefined, version: NodeVersionContext,
): Promise<PreparedNodeUpdate | AgentToolExecutionResult> {
  const targetIds = targets.map((node) => node.id);
  if (input.expectedNodeHash !== undefined) {
    const reject = (summary: string): AgentToolExecutionResult => ({ status: 'error', summary, retryable: false, errorCode: 'NODE_CONTEXT_CHANGED',
      modelContent: JSON.stringify({ errorCode: 'NODE_CONTEXT_CHANGED', operationStatus: 'not_executed', retryable: false, summary }) });
    if (targets.length !== 1) return reject('expectedNodeHash 必须明确对应恰好一个目标节点；未修改任何节点');
    const nodeHash = await getCanvasNodeHash(targets[0], context.projectId, version.settings);
    assertNodeVersionSnapshot(context, targets, version);
    if (nodeHash !== input.expectedNodeHash) return reject('节点内容、名称、位置或项目设置已变化，请重新读取后规划；未修改任何节点，不要自动重投写入');
  }
  if (input.promptEdit !== undefined) {
    const edit = input.promptEdit;
    if (input.prompt !== undefined || !edit || typeof edit !== 'object'
      || Object.keys(edit).some((key) => key !== 'oldText' && key !== 'newText')
      || typeof edit.oldText !== 'string' || !edit.oldText.length || edit.oldText.length > 8000
      || typeof edit.newText !== 'string' || edit.newText.length > 8000) {
      const message = 'promptEdit 仅接受非空且最多 8000 字的 oldText 和最多 8000 字的 newText，不能与 prompt 混传';
      return { status: 'error', summary: message, modelContent: message };
    }
  }
  const moveAbsolute = input.x !== undefined || input.y !== undefined;
  const moveRelative = input.dx !== undefined || input.dy !== undefined;
  if (moveAbsolute && targetIds.length > 1) {
    const message = '绝对坐标一次只能移动一个节点，批量移动请用 dx/dy';
    return { status: 'error', summary: message, modelContent: message };
  }

  const mcp = context.conversationId === `mcp-control-${context.projectId}`;

  const patch: Partial<BaseNodeData> = {
    ...(input.label !== undefined ? { label: input.label.trim() } : {}),
    ...(input.prompt !== undefined ? { prompt: mcp
      ? preferDramaLibraryReferences(input.prompt.trim(), useAppStore.getState().nodes,
        useAppStore.getState().dramaAssets, globalAssets ?? listGlobalDramaAssets(useAppStore.getState()))
      : input.prompt.trim() } : {}),
    ...(input.width !== undefined ? { nodeWidth: Math.round(input.width) } : {}),
    ...(input.height !== undefined ? { nodeHeight: Math.round(input.height) } : {}),
    ...(input.aspectRatio !== undefined ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.imageSize !== undefined ? { imageSize: input.imageSize } : {}),
    ...(input.imageQuality !== undefined ? { imageQuality: input.imageQuality } : {}),
    ...(input.imageBackground !== undefined ? { imageBackground: input.imageBackground } : {}),
    ...imageOutputNodePatch(input),
    ...(input.batchCount !== undefined ? { batchCount: input.batchCount } : {}),
    ...videoResolutionPatch(input),
    ...(input.videoDuration !== undefined ? { seedanceDuration: input.videoDuration < 0
      ? input.videoDuration : resolveShotVideoDuration(input.videoDuration) } : {}),
    ...(input.videoFps !== undefined ? { videoFps: input.videoFps } : {}),
    ...(input.generateAudio !== undefined ? { generateAudio: input.generateAudio } : {}),
    ...(input.audioPurpose !== undefined ? { audioPurpose: input.audioPurpose } : {}),
    ...(input.audioVoice !== undefined ? { audioVoice: input.audioVoice } : {}),
    ...(input.audioFormat !== undefined ? { audioFormat: input.audioFormat } : {}),
    ...(input.audioSpeed !== undefined ? { audioSpeed: input.audioSpeed } : {}),
    ...(input.audioSpeechSettings !== undefined ? { audioSpeechSettings: input.audioSpeechSettings } : {}),
    ...(input.musicDuration !== undefined ? { musicDuration: input.musicDuration } : {}),
    ...(input.musicBpm !== undefined ? { musicBpm: input.musicBpm } : {}),
    ...(input.musicTitle !== undefined ? { musicTitle: input.musicTitle } : {}),
    ...(input.musicLyrics !== undefined ? { musicLyrics: input.musicLyrics } : {}),
    ...(input.autoGenerateLyrics !== undefined ? { autoGenerateLyrics: input.autoGenerateLyrics } : {}),
  };
  const promptEdits = new Map<string, { before: string; after: string }>();
  if (input.promptEdit !== undefined) {
    const edit = input.promptEdit;
    const replacement = mcp
      ? preferDramaLibraryReferences(edit.newText, useAppStore.getState().nodes, useAppStore.getState().dramaAssets,
        globalAssets ?? listGlobalDramaAssets(useAppStore.getState()))
      : edit.newText;
    for (const node of targets) {
      const before = node.data.prompt ?? '';
      const range = promptEditRange(before, edit.oldText);
      if ('error' in range) return { status: 'error', summary: range.error, modelContent: range.error };
      promptEdits.set(node.id, { before, after: before.slice(0, range.start) + replacement + before.slice(range.end) });
    }
  }
  if (targets.some((node) => node.data.type === 'ai-storyboard'
    && (promptEdits.get(node.id)?.after ?? input.prompt)?.trim())) {
    const message = '宫格分镜是已有图片的裁切结果，不能设置生成提示词';
    return { status: 'error', summary: message, modelContent: message };
  }
  const beforeAudit = new Map(
    targets.map((node) => [node.id, captureNodeAudit(node)]),
  );
  const invalidMedia = targets.map((node) => ({ label: node.data.label,
    issue: mediaSettingsIssue(node.data.type, input, node.data) })).find((entry) => entry.issue);
  if (invalidMedia) {
    const message = `${invalidMedia.label}：${invalidMedia.issue}`;
    return { status: 'error', summary: message, modelContent: message };
  }
  if (input.content !== undefined) {
    // 媒体节点的 output 存的是本地路径或 URL，改写会直接破坏节点
    const nonText = targets.filter((node) => !TEXT_OUTPUT_NODE_TYPES.has(node.data.type));
    if (nonText.length > 0) {
      const message = `content 只能改写文本类节点，${nonText.length} 个目标节点不是文本节点`;
      return { status: 'error', summary: message, modelContent: message };
    }
    patch.output = input.content;
  }
  if (input.model !== undefined) {
    const resolved = resolveModelPatch(input.model, targets);
    if ('error' in resolved) {
      return { status: 'error', summary: resolved.error, modelContent: resolved.error };
    }
    Object.assign(patch, resolved.patch);
    if (input.batchCount !== undefined) patch.batchCount = input.batchCount;
    if (input.audioPurpose !== undefined) patch.audioPurpose = input.audioPurpose;
  }
  if (Object.keys(patch).length === 0 && !promptEdits.size && !moveAbsolute && !moveRelative) {
    return { status: 'error', summary: '没有提供需要更新的字段', modelContent: '没有提供需要更新的字段' };
  }

  return { input, targetIds, targets, patch, promptEdits, beforeAudit, moveAbsolute, moveRelative };
}

export function applyPreparedNodeUpdates(groups: PreparedNodeUpdate[], batch: boolean): number {
  const store = useAppStore.getState();
  // 保留旧标量入口的批量 Action；新异构入口先提交一次，再复用无历史的节点 Action。
  if (!batch && Object.keys(groups[0].patch).length) store.updateNodesDataBatch(groups[0].targetIds, groups[0].patch);
  else store.commitToHistory();
  for (const group of groups) {
    for (const node of group.targets) {
      const patch: Partial<BaseNodeData> = batch ? { ...group.patch } : {};
      if (group.input.model !== undefined && node.data.type === 'ai-image'
        && (node.data.model !== group.patch.model || node.data.provider !== group.patch.provider
          || node.data.workflowId !== group.patch.workflowId)) {
        Object.assign(patch, { imageOutputFormat: undefined, imageFrameCount: undefined,
          imageFrameDurationMs: undefined, imageTransparent: undefined }, imageOutputNodePatch(group.input));
      }
      const edited = group.promptEdits.get(node.id);
      if (edited) patch.prompt = edited.after;
      if (group.input.aspectRatio !== undefined && node.data.type === 'ai-video') patch.seedanceRatio = group.input.aspectRatio;
      if (group.input.label !== undefined) {
        if (node.data.displayLabel) patch.displayLabel = group.input.label.trim();
        if (node.data.fileName) patch.fileName = group.input.label.trim();
      }
      if (Object.keys(patch).length) store.updateNodeDataTransient(node.id, patch);
      if (group.moveAbsolute || group.moveRelative) store.updateNodePositionTransient(node.id, {
        x: Math.round(group.input.x ?? node.position.x + (group.input.dx ?? 0)),
        y: Math.round(group.input.y ?? node.position.y + (group.input.dy ?? 0)),
      });
    }
  }
  store.incrementRevision();
  return useAppStore.getState().getCurrentRevision();
}
