import { appDataDir } from '@tauri-apps/api/path';
import { DEFAULT_BASE_URLS } from '../constants/api';
import { lstat } from '@tauri-apps/plugin-fs';
import { fillTemplate, getSlashCommands } from '../components/nodes/shared/slashCommands';
import { getMediaModelOptions } from '../components/nodes/shared/defaultModels';
import { useAppStore } from '../store/useAppStore';
import type { AppConfig, WorkflowDefinition } from '../types';
import type { MediaDownloadAccess } from '../types/aiTypes';
import type { CharacterImageTaskRecovery, CharacterVisualGenerationParameters } from '../types/media';
import type { DramaCharacter } from '../types/dramaAssets';
import type { ProjectContext } from '../types/project';
import { t } from '../i18n';
import { canonicalXiaohongshuReferenceUrl } from '../utils/xiaohongshuReferenceUrl';
import { characterImageChannel, generateImagesBatch, supportsCharacterImageModel, supportsCharacterPaintMask } from './ai/generateImage';
import { isCharacterImageMaskDataUrl } from './ai/characterImageMask';
import { getHttpResponseError } from './ai/httpUtils';
import { PollTaskFailedError } from './pollTask';
import { redactModelProtocolErrorText } from './ai/modelProtocolHttp';
import { resolveImageOutputsPerJob, resolveImageParameterCapability } from './ai/mediaModelCapabilities';
import { assertSafeMediaParameterStrings } from './ai/modelCapabilityValidation';
import { buildCharacterLookbookPrompt } from './dramaAssetPrompt';
import { getProjectDataDir, getAssetUrlFromPath, isTauriEnv, joinPath } from './fileService';
import { getRelativeAssetPath, identifyAsset, resolveIndexedAssetPath } from './fs/assetIndex';
import { fingerprintAssetImage } from './fs/assetImageMetadata';
import { bytePartsToBase64Async, ensureProjectDataDir } from './fs/core';
import { CharacterVisualResultConflictError, characterVisualImageFormat, isCharacterVisualInputUrl, saveCharacterVisualResult } from './fs/characterVisualFiles';
import { readImageSourceBlob } from './fs/imageSourceBlob';
import { openDB, STORE_METADATA } from './indexedDb/schema';
import { configValuesEqual } from './configPatch';
import { MEDIA_DATA_URL_BYTE_LIMITS, sha256BytesHex } from './mediaDataUrl';
import { createNativeCharacterImageSubmissionGuard, listNativeCharacterImageTasks, listPendingNativeCharacterImageTasks, readNativeCharacterImageTask, reviewNativeCharacterImageTask } from './nativeCharacterImageTask';
import { runNativeCharacterImageTask, type NativeCharacterImageSubmissionGuard } from './nativeCharacterImageTask';
import { registerCharacterImageTaskContext, validateCharacterImageTaskRecovery, type CharacterImageExecutionPlan } from './characterImageTaskContext';
import { characterImageConfigurationDigest, recoverCharacterImageTask } from './characterImageTaskRecovery';
import { getProviderDefinition } from './ai/providerCatalogService';
import { mapImageDimensions } from './aiDimensions';
import { mediaProviderConfigId } from './workflowExecutionService';
import { DREAMINA_IMAGE_RATIOS, getDreaminaImageModel } from './ai/dreaminaModels';
import { captureLegacyProjectExpectedContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { safeExchangePath } from './projectExchangeDomain';
import {
  characterVisualCandidateFolder as candidateFolder,
  characterVisualOperations as operations,
  characterVisualScopePrefix as scopePrefix,
  isSafeCharacterVisualId as safeId,
  matchesOriginalCharacterVisualCandidatePath as matchesOriginalCandidatePath,
  readCharacterVisualRows as readRows,
  type StoredCharacterVisualCandidate as StoredCandidate,
  type StoredCharacterVisualRun as StoredRun,
} from './characterVisualHistory';

export { isCharacterVisualInputUrl } from './fs/characterVisualFiles';

export type CharacterVisualOperation = 'appearance' | 'turnaround' | 'edit';
export type CharacterVisualViewSlot = 'sheet' | 'side' | 'front';
export interface CharacterVisualTarget {
  scope: 'project' | 'global';
  characterId: string;
  ownerId?: string;
  projectId?: string;
}
type CharacterVisualScope = Omit<CharacterVisualTarget, 'characterId'>;
export interface CharacterVisualReference { id: string; url: string; purpose?: string; sourceUrl?: string }
export interface CharacterVisualCandidate {
  id: string;
  url: string;
  assetId?: string;
  relativePath?: string;
  filePath?: string;
  operation: CharacterVisualOperation;
  prompt: string;
}
export interface CharacterVisualRun {
  id: string;
  target: CharacterVisualTarget;
  operation: CharacterVisualOperation;
  viewSlot?: CharacterVisualViewSlot;
  maskedEdit?: boolean;
  expectedOutputCount?: number;
  prompt: string;
  submittedPrompt?: string;
  model: string;
  provider: string;
  aspectRatio?: string;
  imageSize?: string;
  createdAt: number;
  status: 'submitting' | 'completed' | 'failed' | 'uncertain' | 'paused' | 'reviewed';
  candidateIds: string[];
  reviewStatus?: 'prepared' | 'uncertain';
  candidates: CharacterVisualCandidate[];
  references: Array<Pick<CharacterVisualReference, 'id' | 'purpose' | 'sourceUrl'>>;
  error?: string;
  recoverable?: boolean;
  remoteTaskIds?: string[];
  workflowId?: string;
  workflowInputs?: Record<string, string>;
  runninghubModelParameters?: Record<string, string>;
  imageQuality?: string;
  imageBackground?: string;
}
export interface CharacterVisualDraft { target: CharacterVisualTarget; name: string; updatedAt: number }
export interface CharacterVisualModel {
  id: string;
  label: string;
  provider: string;
  ratios: readonly string[];
  resolutions: readonly string[];
  defaultRatio?: string;
  defaultResolution?: string;
  supportsReferences: boolean;
  supportsMask: boolean;
  channel: 'standard' | 'midjourney';
  maxReferences: number;
  workflowId?: string;
  connectionId?: string;
}
interface GenerateCharacterVisualInput {
  target: CharacterVisualTarget;
  characterName?: string;
  isNew?: boolean;
  operation: CharacterVisualOperation;
  viewSlot?: CharacterVisualViewSlot;
  mask?: { pngDataUrl: string; referenceId: string; baseDigest: string };
  prompt: string;
  model: string;
  provider: string;
  aspectRatio?: string;
  imageSize?: string;
  workflowId?: string;
  workflowInputs?: Record<string, string>;
  runninghubModelParameters?: Record<string, string>;
  imageQuality?: string;
  imageBackground?: string;
  references: CharacterVisualReference[];
  assertCurrent?: () => void;
  onBaseSnapshot?: (dataUrl: string) => void;
}
interface CandidatePath { id: string; relativePath: string; assetId?: string }

const GLOBAL_CANDIDATE_FOLDER = 'character-visual-candidates';
const MAX_HISTORY_ITEMS = 50;
const MAX_REFERENCES = 16;
const MAX_PROMPT_LENGTH = 30_000;
export const MAX_CHARACTER_VISUAL_REFERENCE_BYTES = 48 * 1024 * 1024;
const activeTargets = new Map<string, string>();
const activeRuns = new Set<string>();
const runListeners = new Set<() => void>();
const viewSlots = new Set<CharacterVisualViewSlot>(['sheet', 'side', 'front']);

export function subscribeCharacterVisualRuns(listener: () => void): () => void {
  runListeners.add(listener);
  return () => { runListeners.delete(listener); };
}

function notifyCharacterVisualRuns(): void {
  for (const listener of runListeners) listener();
}

function characterPrefix(target: CharacterVisualTarget): string {
  if (!safeId(target.characterId)) throw new Error(t('角色素材归属已变化'));
  return `${scopePrefix(target)}${target.characterId}:`;
}

const promotionKey = (target: CharacterVisualTarget) => `character-visual-promoted-v1:${characterPrefix(target)}`;
const pendingKey = (row: StoredRun) => `character-visual-pending-v1:${characterPrefix(row.target)}${row.projectEpoch ?? 'global'}:${row.fingerprint}`;

export async function markCharacterVisualDraftSaved(target: CharacterVisualTarget): Promise<void> {
  projectContext(target);
  if (!(await findRuns(target)).some((row) => row.draft)) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_METADATA, 'readwrite');
    transaction.objectStore(STORE_METADATA).put({ id: promotionKey(target) });
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error(t('角色生成历史保存失败')));
  });
}

export function captureCharacterVisualTarget(scope: CharacterVisualTarget['scope'], characterId: string): CharacterVisualTarget {
  return { ...captureCharacterVisualScope(scope), characterId };
}

export function captureCharacterVisualScope(scope: CharacterVisualTarget['scope']): CharacterVisualScope {
  const state = useAppStore.getState();
  if (scope === 'global') return { scope };
  try {
    const context = captureLegacyProjectExpectedContext(state, 'project');
    if (context.kind === 'project') {
      return { scope, ownerId: context.projectId, projectId: state.currentProjectId ?? undefined };
    }
  } catch { /* 未准备好时由提交前复核给出提示。 */ }
  return { scope };
}

function projectContext(target: CharacterVisualScope): ProjectContext | undefined {
  if (target.scope === 'global') return undefined;
  const state = useAppStore.getState();
  const context = captureLegacyProjectExpectedContext(state, 'project');
  if (context.kind !== 'project' || context.projectId !== target.ownerId || state.currentProjectId !== target.projectId) {
    throw new Error(t('角色素材归属已变化'));
  }
  return context;
}

export function listCharacterVisualModels(
  target: CharacterVisualTarget, _operation: CharacterVisualOperation, referenceCount = 0,
  config: AppConfig = useAppStore.getState().config,
  workflows: WorkflowDefinition[] = useAppStore.getState().workflows,
): CharacterVisualModel[] {
  if (!isTauriEnv() || target.scope === 'project' && !target.ownerId) return [];
  return getMediaModelOptions(config.generalModels, config, workflows).flatMap((option) => {
    if (option.mediaKind !== 'image') return [];
    const capability = resolveImageParameterCapability(option.value, option.provider, config);
    const dreamina = option.provider === 'dreamina' ? getDreaminaImageModel(option.value) : undefined;
    const channel = characterImageChannel(option.value, option.provider, config);
    const maxReferences = dreamina?.supportsImageReference === false ? 0 : supportsCharacterImageModel(option.value, option.provider, config, 1)
      ? Math.min(channel === 'midjourney' ? 1 : MAX_REFERENCES, capability?.maxImageReferences ?? MAX_REFERENCES) : 0;
    const supportsMask = maxReferences > 0 && supportsCharacterPaintMask(option.value, option.provider, config);
    if (referenceCount > maxReferences) return [];
    return [{
      id: option.value,
      label: option.label,
      provider: option.provider,
      ratios: dreamina ? DREAMINA_IMAGE_RATIOS : capability?.ratios ?? [],
      resolutions: dreamina?.resolutions ?? capability?.resolutions ?? [],
      defaultRatio: capability?.defaultRatio,
      defaultResolution: capability?.defaultResolution,
      supportsReferences: maxReferences > 0,
      supportsMask,
      channel,
      maxReferences,
      workflowId: option.workflowId,
      connectionId: option.providerConfigId ?? mediaProviderConfigId(option.provider, workflows.find((workflow) => workflow.id === option.workflowId)),
    }];
  });
}

/** 与图片节点派生相同的有效质量／背景，配置刷新不把旧档位继续提交。 */
export function resolveCharacterVisualParameters(model: CharacterVisualModel, parameters: CharacterVisualGenerationParameters,
  config: AppConfig = useAppStore.getState().config): CharacterVisualGenerationParameters {
  const capability = model.workflowId ? undefined : resolveImageParameterCapability(model.id, model.provider, config);
  return { ...parameters,
    imageQuality: capability?.qualities?.find((value) => value.toLowerCase() === parameters.imageQuality?.toLowerCase()) ?? capability?.defaultQuality,
    imageBackground: capability?.backgroundIsFixed ? capability.defaultBackground : parameters.imageBackground === '' ? ''
      : capability?.backgrounds?.find((value) => value.toLowerCase() === parameters.imageBackground?.toLowerCase()) ?? capability?.defaultBackground,
  };
}

export function buildCharacterVisualPrompt(character: DramaCharacter, operation: CharacterVisualOperation): string {
  if (operation === 'edit') return '';
  const subject = buildCharacterLookbookPrompt(character);
  if (operation === 'appearance') return subject;
  const description = [character.name, character.identity, character.summary, character.visualNotes, character.wardrobeDefault]
    .map((value) => value?.trim()).filter(Boolean).join('，');
  const template = getSlashCommands('ai-image').find((group) => group.id === 'character')?.children
    ?.find((item) => item.id === 'char-three-view')?.promptTemplate;
  return template ? fillTemplate(template, description) : subject;
}

function encodeImage(bytes: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> {
  return bytePartsToBase64Async([bytes], signal).then((encoded) => `data:${mime};base64,${encoded}`);
}

export async function readCharacterVisualInput(file: File, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (file.size <= 0 || file.size > MEDIA_DATA_URL_BYTE_LIMITS.image) throw new Error(t('图片大小超出限制'));
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  return encodeImage(bytes, characterVisualImageFormat(bytes).mime, signal);
}

function findRuns(target: CharacterVisualTarget): Promise<StoredRun[]> {
  const prefix = characterPrefix(target);
  const rows: StoredRun[] = [];
  return readRows(prefix, (row) => {
    if (row.target.scope === target.scope && row.target.ownerId === target.ownerId
      && row.target.characterId === target.characterId) rows.push(row);
    return rows.length < MAX_HISTORY_ITEMS;
  }, () => rows);
}

function findRun(target: CharacterVisualTarget, operationId: string): Promise<StoredRun | undefined> {
  let found: StoredRun | undefined;
  return readRows(characterPrefix(target), (row) => {
    if (row.target.scope !== target.scope || row.target.ownerId !== target.ownerId
      || row.target.characterId !== target.characterId || row.operationId !== operationId) return true;
    found = row;
    return false;
  }, () => found);
}

async function saveRun(row: StoredRun, mode: 'add' | 'claim-submit' | 'update' = 'update'): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_METADATA, 'readwrite', { durability: 'strict' });
    const store = transaction.objectStore(STORE_METADATA);
    let duplicate = false;
    if (mode === 'add') store.add(row);
    else if (mode === 'claim-submit') {
      const key = pendingKey(row);
      const claim = store.get(key);
      claim.onsuccess = () => {
        if (claim.result !== undefined) { duplicate = true; transaction.abort(); return; }
        store.add({ id: key, operationId: row.operationId });
        store.put(row);
      };
    } else {
      store.put(row);
      if (!row.native && ['completed', 'failed', 'reviewed'].includes(row.status)) {
        const key = pendingKey(row);
        const claim = store.get(key);
        claim.onsuccess = () => {
          if (claim.result?.operationId === row.operationId) store.delete(key);
        };
      }
    }
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(duplicate ? new Error(t('相同请求的提交状态尚未确认，请先查看服务商任务记录'))
      : transaction.error ?? new Error(t('角色生成历史保存失败')));
  });
}

export async function listCharacterVisualDraftTargets(target: CharacterVisualTarget): Promise<CharacterVisualDraft[]> {
  const known = new Set((target.scope === 'project' ? useAppStore.getState().dramaAssets.characters
    : useAppStore.getState().globalCharacters).map((character) => character.id));
  const drafts = new Map<string, CharacterVisualDraft>();
  await readRows(scopePrefix(target), (row) => {
    const id = row.target.characterId;
    if (row.draft && row.target.scope === target.scope && row.target.ownerId === target.ownerId
      && safeId(id) && id !== target.characterId && !known.has(id)
      && (row.sent || row.status === 'completed' || row.native && row.status === 'submitting')
      && (drafts.get(id)?.updatedAt ?? 0) < row.createdAt) {
      drafts.set(id, { target: { ...target, characterId: id }, name: row.name, updatedAt: row.createdAt });
    }
    return true;
  }, () => undefined);
  const db = await openDB();
  const eligible = await new Promise<CharacterVisualDraft[]>((resolve, reject) => {
    const transaction = db.transaction(STORE_METADATA, 'readonly');
    const available: CharacterVisualDraft[] = [];
    const store = transaction.objectStore(STORE_METADATA);
    for (const draft of drafts.values()) {
      const marker = store.get(promotionKey(draft.target));
      marker.onsuccess = () => { if (!marker.result) available.push(draft); };
    }
    transaction.oncomplete = () => resolve(available);
    transaction.onabort = () => reject(transaction.error ?? new Error(t('角色生成历史读取失败')));
  });
  return eligible.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 20);
}

async function candidateRoot(target: CharacterVisualTarget): Promise<string> {
  const root = target.scope === 'global'
    ? joinPath(await appDataDir(), GLOBAL_CANDIDATE_FOLDER)
    : target.ownerId && await getProjectDataDir(target.ownerId);
  if (!root) throw new Error(t('角色素材目录不可用'));
  return root;
}

function candidateId(row: StoredRun, index: number): string {
  return `${row.operationId}-${index + 1}`;
}

function candidateFromPath(row: StoredRun, candidate: CandidatePath, filePath: string, url: string): CharacterVisualCandidate {
  return {
    id: candidate.id,
    ...(candidate.assetId ? { assetId: candidate.assetId } : {}),
    ...(row.target.scope === 'project' ? { relativePath: candidate.relativePath } : {}),
    filePath,
    url,
    operation: row.operation,
    prompt: row.prompt,
  };
}

const candidateChecks = new Map<string, { filePath: string; mtime: number; size: number; digest: string }>();

async function readCandidates(row: StoredRun): Promise<CharacterVisualCandidate[]> {
  if (!row.candidates.length) return [];
  const root = await candidateRoot(row.target);
  const hydrated = await Promise.all(row.candidates.map(async (candidate) => {
    try {
      if (!matchesOriginalCandidatePath(row, candidate) || !/^[a-f0-9]{64}$/.test(candidate.digest)) return null;
      const indexedPath = candidate.assetId ? await resolveIndexedAssetPath(candidate.assetId) : undefined;
      const filePath = indexedPath && getRelativeAssetPath(indexedPath, root)
        ? indexedPath : joinPath(root, safeExchangePath(candidate.relativePath));
      const info = await lstat(filePath);
      if (!info.isFile || info.isSymlink || info.size !== candidate.bytes) return null;
      const mtime = info.mtime?.getTime() ?? 0;
      const cached = candidateChecks.get(candidate.id);
      if (!cached || cached.filePath !== filePath || cached.size !== info.size || cached.mtime !== mtime || cached.digest !== candidate.digest) {
        const actual = await fingerprintAssetImage(filePath);
        if (actual.digest !== candidate.digest || actual.bytes !== candidate.bytes) return null;
        const oldest = candidateChecks.keys().next().value;
        if (candidateChecks.size >= 512 && oldest !== undefined) candidateChecks.delete(oldest);
        candidateChecks.set(candidate.id, { filePath, mtime, size: info.size, digest: candidate.digest });
      }
      const url = await getAssetUrlFromPath(filePath);
      return url ? candidateFromPath(row, {
        ...candidate, relativePath: getRelativeAssetPath(filePath, root) ?? candidate.relativePath,
      }, filePath, url) : null;
    } catch { return null; }
  }));
  return hydrated.filter((candidate): candidate is CharacterVisualCandidate => candidate !== null);
}

function displayRun(row: StoredRun, candidates: CharacterVisualCandidate[], overrides: Partial<CharacterVisualRun> = {}): CharacterVisualRun {
  return {
    id: row.operationId, target: row.target, operation: row.operation, viewSlot: row.viewSlot, maskedEdit: row.maskedEdit,
    prompt: row.prompt, submittedPrompt: row.submittedPrompt, expectedOutputCount: row.expectedOutputCount,
    model: row.model, provider: row.provider, aspectRatio: row.aspectRatio, imageSize: row.imageSize,
    imageQuality: row.imageQuality, imageBackground: row.imageBackground, workflowId: row.workflowId,
    workflowInputs: row.workflowInputs, runninghubModelParameters: row.runninghubModelParameters,
    recoverable: Boolean(row.recovery?.tasks.length && ['submitting', 'uncertain', 'paused'].includes(overrides.status ?? row.status)),
    remoteTaskIds: row.recovery?.tasks.map((task) => task.taskId),
    createdAt: row.createdAt, status: row.status, references: row.references.map((reference) => ({
      ...reference, sourceUrl: canonicalXiaohongshuReferenceUrl(reference.sourceUrl),
    })), error: row.error,
    candidateIds: candidates.map((candidate) => candidate.id), candidates, ...overrides,
  };
}

export async function listCharacterVisualRuns(target: CharacterVisualTarget): Promise<CharacterVisualRun[]> {
  const rows = await findRuns(target);
  const nativeTasks = rows.some((row) => row.native) && target.ownerId
    ? await listNativeCharacterImageTasks(target.ownerId, target.characterId, rows.map((row) => row.operationId)) : [];
  const tasks = new Map(nativeTasks.map((task) => [task.operationId, task]));
  return rows.map((row) => {
    if (activeRuns.has(row.operationId)) return displayRun(row, [], { status: 'submitting' });
    if (row.native) {
      const found = tasks.get(row.operationId);
      const task = found?.projectEpoch === row.projectEpoch ? found : undefined;
      const candidateIds = task?.outputIndexes.map((index) => candidateId(row, index)) ?? [];
      if (task?.recovery) row.recovery = task.recovery;
      if (task?.status === 'completed') {
        return displayRun(row, [], { status: 'completed', candidateIds,
          error: row.expectedOutputCount && candidateIds.length < row.expectedOutputCount ? t('本次仅取得部分候选图，已保留可用结果') : undefined });
      }
      if (task?.status === 'outcome-unknown' || task?.status === 'prepared') {
        return displayRun(row, [], { status: task.recovery?.tasks.length ? 'paused' : 'uncertain', candidateIds,
          reviewStatus: task.active ? undefined : task.status === 'prepared' ? 'prepared' : 'uncertain',
          recoverable: Boolean(task.recovery?.tasks.length) && !task.active,
          error: task.recovery?.tasks.length ? t('原任务查询或保存尚未完成，可继续查询')
            : task.status === 'prepared' ? t('本次图片生成未提交') : t('提交状态未知，请查看服务商原任务记录') });
      }
      if (task?.status === 'reviewed') return displayRun(row, [], { status: 'reviewed', candidateIds, error: undefined });
      if (task?.status === 'failed' || !task) {
        return displayRun(row, [], { status: 'failed', error: t('本次图片生成未完成') });
      }
    }
    const candidateIds = row.candidates.map((candidate) => candidate.id);
    if (row.status === 'submitting') return displayRun(row, [], row.sent
      ? { status: row.recovery?.tasks.length ? 'paused' : 'uncertain', reviewStatus: 'uncertain', candidateIds,
        error: row.recovery?.tasks.length ? t('原任务查询或保存尚未完成，可继续查询') : t('提交状态未知，请查看服务商原任务记录') }
      : { status: 'failed', error: t('本次图片生成未提交') });
    return displayRun(row, [], { candidateIds, reviewStatus: row.sent && (row.status === 'uncertain' || row.status === 'paused') ? 'uncertain' : undefined });
  });
}

export interface PendingCharacterVisualRun {
  id: string;
  characterId: string;
  name?: string;
  model: string;
  createdAt: number;
  status: 'active' | 'prepared' | 'uncertain';
}

export async function listPendingCharacterVisualRuns(target: CharacterVisualScope): Promise<PendingCharacterVisualRun[]> {
  const context = projectContext(target);
  const native = context?.modelGeneration === 1 ? await listPendingNativeCharacterImageTasks(context.projectId) : [];
  const tasks = new Map(native.map((task) => [task.operationId, task]));
  const pending: PendingCharacterVisualRun[] = [];
  await readRows(scopePrefix(target), (row) => {
    if (row.target.scope !== target.scope || row.target.ownerId !== target.ownerId) return true;
    const task = tasks.get(row.operationId);
    if (task && task.characterId === row.target.characterId) {
      pending.push({ id: task.operationId, characterId: task.characterId, name: row.name, model: task.modelRef,
        createdAt: task.createdAt, status: task.active ? 'active' : task.status === 'prepared' ? 'prepared' : 'uncertain' });
      tasks.delete(task.operationId);
    } else if (!row.native && row.sent && (row.status === 'submitting' || row.status === 'uncertain' || row.status === 'paused')) {
      pending.push({ id: row.operationId, characterId: row.target.characterId, name: row.name, model: row.model,
        createdAt: row.createdAt, status: activeRuns.has(row.operationId) ? 'active' : 'uncertain' });
    }
    return true;
  }, () => undefined);
  for (const task of tasks.values()) {
    pending.push({ id: task.operationId, characterId: task.characterId, model: task.modelRef, createdAt: task.createdAt,
      status: task.active ? 'active' : task.status === 'prepared' ? 'prepared' : 'uncertain' });
  }
  return pending.sort((left, right) => right.createdAt - left.createdAt);
}

export async function reviewCharacterVisualRun(target: CharacterVisualTarget, id: string,
  assertCurrent: () => void, expectedStatus: 'prepared' | 'uncertain'): Promise<void> {
  const context = projectContext(target);
  const guard = () => {
    assertCurrent();
    if (activeRuns.has(id) || context && !isProjectExpectedContextCurrent(context, useAppStore.getState())) {
      throw new Error(t('原角色生成任务已变化，请刷新后重试'));
    }
  };
  const row = await findRun(target, id);
  guard();
  if (context?.modelGeneration === 1 && (!row || row.native)) {
    await reviewNativeCharacterImageTask(context.projectId, target.characterId, id, guard,
      expectedStatus === 'uncertain' ? 'outcome-unknown' : expectedStatus);
  } else {
    if (!row || expectedStatus === 'prepared' || !row.sent || row.status !== 'uncertain' && row.status !== 'submitting' && row.status !== 'paused') {
      throw new Error(t('原角色生成任务已变化，请刷新后重试'));
    }
    const db = await openDB();
    guard();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_METADATA, 'readwrite', { durability: 'strict' });
      const store = tx.objectStore(STORE_METADATA);
      const current = store.get(row.id);
      current.onsuccess = () => {
        try {
          guard();
          const latest = current.result as StoredRun | undefined;
          if (!latest || latest.operationId !== id || !latest.sent || latest.status !== 'uncertain' && latest.status !== 'submitting' && latest.status !== 'paused') {
            throw new Error(t('原角色生成任务已变化，请刷新后重试'));
          }
          store.put({ ...latest, status: 'reviewed', error: undefined });
          const key = pendingKey(latest);
          const claim = store.get(key);
          claim.onsuccess = () => { if (claim.result?.operationId === id) store.delete(key); };
        } catch { tx.abort(); }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error(t('原角色生成任务已变化，请刷新后重试')));
    });
  }
  notifyCharacterVisualRuns();
}

export async function readCharacterVisualRunCandidates(target: CharacterVisualTarget, id: string): Promise<CharacterVisualCandidate[]> {
  projectContext(target);
  const row = await findRun(target, id);
  if (!row) return [];
  if (!row.native || !target.ownerId) return readCandidates(row);
  const task = await readNativeCharacterImageTask(target.ownerId, target.characterId, id);
  if (!task || task.projectEpoch !== row.projectEpoch) return [];
  return task.candidates.map((candidate) =>
    candidateFromPath(row, { id: candidateId(row, candidate.index), relativePath: candidate.relativePath }, candidate.filePath, candidate.url));
}

/** 采纳时重读原任务，并核对候选图仍属于当前角色和作品。 */
export async function readCharacterVisualCandidate(target: CharacterVisualTarget, candidateIdValue: string): Promise<CharacterVisualCandidate> {
  projectContext(target);
  const operationId = candidateIdValue.slice(0, 36);
  const row = await findRun(target, operationId);
  if (row?.native && target.ownerId) {
    const index = Number(candidateIdValue.slice(37)) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || candidateId(row, index) !== candidateIdValue) throw new Error(t('原候选图片文件不可用'));
    const task = await readNativeCharacterImageTask(target.ownerId, target.characterId, operationId, index);
    const candidate = task?.projectEpoch === row.projectEpoch && task?.candidates?.find((item) =>
      candidateId(row, item.index) === candidateIdValue);
    if (candidate) return candidateFromPath(row, { id: candidateIdValue, relativePath: candidate.relativePath }, candidate.filePath, candidate.url);
  } else if (row) {
    const stored = row.candidates.find((candidate) => candidate.id === candidateIdValue);
    if (stored) {
      candidateChecks.delete(stored.id);
      const [candidate] = await readCandidates({ ...row, candidates: [stored] });
      if (candidate) return candidate;
    }
  }
  throw new Error(t('原候选图片文件不可用'));
}

async function freezeReferences(references: CharacterVisualReference[], signal: AbortSignal) {
  const frozen: Array<CharacterVisualReference & { digest: string }> = [];
  let bytesTotal = 0;
  for (const reference of references) {
    if (!isCharacterVisualInputUrl(reference.url)) throw new Error(t('参考图片地址不可用'));
    const blob = await readImageSourceBlob(reference.url, signal);
    bytesTotal += blob.size;
    if (bytesTotal > MAX_CHARACTER_VISUAL_REFERENCE_BYTES) throw new Error(t('参考图片总大小超出限制'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = await sha256BytesHex(bytes);
    if (frozen.some((item) => item.digest === digest)) throw new Error(t('请移除重复的参考图片'));
    const format = characterVisualImageFormat(bytes);
    frozen.push({ id: reference.id, purpose: reference.purpose?.trim().slice(0, 100),
      sourceUrl: canonicalXiaohongshuReferenceUrl(reference.sourceUrl), url: await encodeImage(bytes, format.mime, signal), digest });
  }
  return frozen;
}

async function persistCandidate(
  row: StoredRun, index: number, url: string, root: string, access: MediaDownloadAccess | undefined, signal: AbortSignal,
): Promise<StoredCandidate> {
  const folder = candidateFolder(row);
  if (row.target.ownerId) await ensureProjectDataDir(row.target.ownerId, { throwOnError: true });
  for (let ordinal = index; ordinal < 128; ordinal++) {
    const id = candidateId(row, ordinal);
    const stem = row.target.scope === 'global' ? id : `character-visual-${id}`;
    try {
      const { filePath } = await saveCharacterVisualResult(url, joinPath(root, folder), stem, access, signal);
      const relativePath = getRelativeAssetPath(filePath, root);
      if (!relativePath) throw new Error(t('原候选图片文件不可用'));
      const { bytes, digest } = await fingerprintAssetImage(filePath, signal);
      if (row.target.scope === 'global') return { id, relativePath, bytes, digest };
      const identity = await identifyAsset(filePath, { source: 'project', projectId: row.target.ownerId, rootPath: root });
      return { id, relativePath, bytes, digest, assetId: identity.assetId };
    } catch (error) { if (!(error instanceof CharacterVisualResultConflictError)) throw error; }
  }
  throw new Error(t('角色候选图片数量超过上限'));
}

/** 定妆拼接只交付本机候选，沿用角色历史和显式采纳，不登记远端作业。 */
export async function saveCharacterVisualComposite(target: CharacterVisualTarget, pngDataUrl: string,
  characterName: string, isNew: boolean, signal: AbortSignal, assertCurrent?: () => void): Promise<CharacterVisualCandidate> {
  if (!isTauriEnv() || !pngDataUrl.startsWith('data:image/png;base64,')) throw new Error(t('定妆拼图不可用'));
  const prefix = characterPrefix(target);
  const context = projectContext(target);
  const root = await candidateRoot(target);
  const guard = () => {
    signal.throwIfAborted();
    assertCurrent?.();
    if (context && !isProjectExpectedContextCurrent(context, useAppStore.getState())) throw new Error(t('角色素材归属已变化'));
  };
  guard();
  if (activeTargets.has(prefix)) throw new Error(t('该角色已有图片任务正在处理'));
  const operationId = crypto.randomUUID();
  activeTargets.set(prefix, operationId);
  try {
    const createdAt = Date.now();
    const secrets = Object.values(useAppStore.getState().config.providers).map((provider) => provider?.apiKey)
      .filter((key): key is string => Boolean(key));
    const row: StoredRun = {
      id: `${prefix}${createdAt}-${operationId}`, operationId, target, operation: 'turnaround',
      name: safeHistoryText(characterName.trim().slice(0, 128), secrets), prompt: '角色定妆拼图',
      model: 'local-composite', provider: 'local', createdAt, status: 'completed',
      candidates: [], references: [], sent: false, native: false, nativeLocal: context?.modelGeneration === 1,
      draft: isNew, projectEpoch: context?.projectEpoch, fingerprint: '',
    };
    if (await candidateRoot(target) !== root) throw new Error(t('角色素材目录不可用'));
    guard();
    row.candidates.push(await persistCandidate(row, 0, pngDataUrl, root, undefined, signal));
    const [candidate] = await readCandidates(row);
    if (!candidate) throw new Error(t('原候选图片文件不可用'));
    guard();
    await saveRun(row, 'add');
    notifyCharacterVisualRuns();
    return candidate;
  } finally { activeTargets.delete(prefix); }
}

function promptForSubmit(row: StoredRun, prompt: string): string {
  const purposes = row.references.map((reference, index) => reference.purpose
    ? `图片 ${index + 1} · ${reference.purpose}` : '').filter(Boolean);
  const editInstruction = row.operation === 'edit'
    ? '以下是一张角色底图。只按用户描述修改指定内容，尽量保持原图构图、角色身份及其余部分。'
    : '';
  const referenceInstruction = row.references.length
    ? `本次附带 ${row.references.length} 张参考图，按图片顺序和标注用途使用。` : '';
  const outputInstruction = row.aspectRatio ? `最终画幅为 ${row.aspectRatio}。` : '';
  return [editInstruction, referenceInstruction, prompt, ...purposes, outputInstruction].filter(Boolean).join('\n\n');
}

function safeHistoryText(value: string, secrets: string[]): string {
  return secrets.reduce(redactModelProtocolErrorText, value)
    .replace(/(?:https?:\/\/asset\.localhost|asset:\/\/localhost|file:\/\/)[^\s"'<>]+/gi, '[本地媒体]')
    .replace(/(^|[\s"'(=])(?:[a-z]:[\\/]|\\\\|\/(?!\/))[^\s"'<>]+/gi, '$1[本地路径]')
    .replace(/(?:\bBearer\s+|\b(?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s"'<>]+/gi, '[凭据]');
}

const completedCharacterRuns = new WeakMap<Error, CharacterVisualRun>();

async function executeCharacterVisualPlan(row: StoredRun, plan: CharacterImageExecutionPlan, options: {
  connectionId: string; root: string; signal: AbortSignal; assertCurrent: () => void;
  beforePost: () => Promise<void>; nativeGuard?: NativeCharacterImageSubmissionGuard; resume?: boolean;
}): Promise<never> {
  const { signal } = options;
  const connectionId = plan.recovery.workflow?.connectionId ?? options.connectionId;
  const config = useAppStore.getState().config;
  const connection = config.providers[connectionId];
  const base = plan.recovery.workflow?.providerBase ?? (connectionId === 'dreamina' ? 'http://dreamina.local'
    : connection?.baseUrl?.trim() || getProviderDefinition(connectionId, connection)?.defaultBaseUrl || DEFAULT_BASE_URLS[connectionId] || '');
  const expectedCount = plan.expectedCount ?? row.expectedOutputCount ?? 1;
  const recovery: CharacterImageTaskRecovery = options.resume && row.recovery ? structuredClone(row.recovery) : {
    version: 1, ...plan.recovery, connectionId, modelRef: row.model,
    providerBase: base.replace(/\/+$/, ''), configurationDigest: await characterImageConfigurationDigest(row.model, connectionId, row.workflowId),
    expectedCount, tasks: [], ...(plan.mediaDownloadAccess ? { mediaDownloadAccess: plan.mediaDownloadAccess } : {}),
  };
  if (recovery.workflow?.workflowId !== row.workflowId) throw new Error(t('原图片工作流归属已变化'));
  if (recovery.configurationDigest !== await characterImageConfigurationDigest(row.model, connectionId, row.workflowId)) {
    throw new Error(t('模型配置已变化，请恢复原连接后继续查询'));
  }
  const secrets = Object.values(config.providers).flatMap((provider) => provider?.apiKey ? [provider.apiKey] : []);
  validateCharacterImageTaskRecovery(recovery, secrets);
  row.expectedOutputCount = expectedCount;
  const execute = async (beforePost: () => Promise<void>, retainNative?: (value: CharacterImageTaskRecovery) => Promise<void>,
    originalRecovery?: CharacterImageTaskRecovery): Promise<string[] & { incomplete?: true }> => {
    if (options.resume) {
      const original = originalRecovery ?? row.recovery;
      if (!original || original.configurationDigest !== recovery.configurationDigest) throw new Error(t('原图片任务回执已变化'));
      const outputs = await recoverCharacterImageTask(original, row.operationId, signal);
      return Object.assign(outputs.filter((item) => !item.kind || item.kind === 'image').map((item) => item.url),
        outputs.incomplete ? { incomplete: true as const } : {});
    }
    const retain = async () => {
      validateCharacterImageTaskRecovery(recovery, secrets);
      if (retainNative) await retainNative(structuredClone(recovery));
      row.recovery = structuredClone(recovery);
      await saveRun(row);
    };
    await retain();
    const outputs = await plan.execute(beforePost, async (taskId, recoveryContext) => {
      const prior = recovery.tasks.find((task) => task.taskId === taskId);
      if (prior && !configValuesEqual(prior.recoveryContext, recoveryContext)) throw new Error(t('原图片任务回执已变化'));
      if (!prior) recovery.tasks.push({ taskId, ...(recoveryContext ? { recoveryContext } : {}) });
      await retain();
    }, row.operationId).catch((error: unknown) => { if (plan.isDefinitiveFailure?.(error)) row.status = 'failed'; throw error; });
    const images = outputs.filter((output) => !output.kind || output.kind === 'image');
    if (!images.length || images.length > 128) throw new Error(t('原图片任务没有返回完整候选集合'));
    return Object.assign(images.map((output) => output.url), outputs.incomplete ? { incomplete: true as const } : {});
  };
  let candidates: CharacterVisualCandidate[];
  if (row.native && options.nativeGuard) {
    await runNativeCharacterImageTask({ guard: options.nativeGuard, modelRef: row.model, connectionId,
      requestMaterial: row.fingerprint, dimensions: mapImageDimensions(row.imageSize || '2K', row.aspectRatio || '1:1'),
      expectedCount, signal, resume: options.resume, mediaDownloadAccess: recovery.mediaDownloadAccess,
      isDefinitiveFailure: plan.isDefinitiveFailure, execute });
    const task = row.target.ownerId && await readNativeCharacterImageTask(row.target.ownerId, row.target.characterId, row.operationId);
    if (!task || task.projectEpoch !== row.projectEpoch || task.status !== 'completed' || !task.candidates.length) throw new Error(t('原候选图片文件不可用'));
    candidates = task.candidates.map((candidate) => candidateFromPath(row,
      { id: candidateId(row, candidate.index), relativePath: candidate.relativePath }, candidate.filePath, candidate.url));
  } else {
    const urls = await execute(options.beforePost);
    let failed = false;
    for (const url of urls) {
      try {
        if (await candidateRoot(row.target) !== options.root) throw new Error(t('角色素材目录不可用'));
        const candidate = await persistCandidate(row, row.candidates.length, url, options.root, recovery.mediaDownloadAccess, signal);
        if (!row.candidates.some((item) => item.digest === candidate.digest)) row.candidates.push(candidate);
        await saveRun(row);
      } catch { failed = true; }
    }
    if (failed || urls.incomplete || !row.candidates.length) throw new Error(t('部分图片未能保存到本机'));
    candidates = await readCandidates(row);
  }
  row.sent = true;
  row.status = 'completed';
  row.error = candidates.length < expectedCount ? t('本次仅取得部分候选图，已保留可用结果') : undefined;
  await saveRun(row);
  const delivered = new Error('角色图片任务已保存并交付');
  delivered.name = 'NativeMediaTaskDelivered';
  completedCharacterRuns.set(delivered, displayRun(row, candidates));
  throw delivered;
}

export async function resumeCharacterVisualRun(target: CharacterVisualTarget, id: string, signal?: AbortSignal): Promise<CharacterVisualRun> {
  const context = projectContext(target), prefix = characterPrefix(target);
  const row = (await findRuns(target)).find((item) => item.operationId === id);
  if (!row || activeRuns.has(id) || activeTargets.has(prefix)) throw new Error(t('原角色生成任务已变化，请刷新后重试'));
  if (['failed', 'reviewed'].includes(row.status)) throw new Error(t('原角色生成任务已结束，不能继续查询'));
  if (row.native && target.ownerId) {
    const task = (await listNativeCharacterImageTasks(target.ownerId, target.characterId, [id]))[0];
    if (!task || !context || task.projectEpoch !== row.projectEpoch || context.projectEpoch !== row.projectEpoch) throw new Error(t('角色素材归属已变化'));
    row.recovery = task.recovery;
  }
  if (!row.recovery?.tasks.length) throw new Error(t('原图片请求没有已保存的任务 ID，请核对服务商原任务'));
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const guard = () => {
    controller.signal.throwIfAborted(); projectContext(target);
    if (context?.projectEpoch !== row.projectEpoch && row.native) throw new Error(t('角色素材归属已变化'));
  };
  activeTargets.set(prefix, id); activeRuns.add(id);
  try {
    const recovery = row.recovery;
    await executeCharacterVisualPlan(row, { expectedCount: recovery.expectedCount, recovery,
      mediaDownloadAccess: recovery.mediaDownloadAccess, execute: async () => { throw new Error('恢复不能重新提交生成'); } }, {
      connectionId: recovery.connectionId, root: await candidateRoot(target), signal: controller.signal, assertCurrent: guard,
      beforePost: async () => { throw new Error('恢复不能重新提交生成'); }, resume: true,
      ...(row.native && context ? { nativeGuard: createNativeCharacterImageSubmissionGuard({ ownerProjectId: context.projectId,
        projectEpoch: context.projectEpoch, characterId: target.characterId, operationId: id, fingerprint: row.fingerprint, assertCurrent: guard }) } : {}),
    });
    throw new Error(t('原图片任务没有返回完整候选集合'));
  } catch (error) {
    if (error instanceof Error && completedCharacterRuns.has(error)) return completedCharacterRuns.get(error)!;
    row.status = error instanceof PollTaskFailedError ? 'failed' : row.recovery?.tasks.length ? 'paused' : 'uncertain';
    row.error = row.status === 'failed' ? t('本次图片生成未完成') : t('原任务查询或保存尚未完成，可继续查询'); await saveRun(row);
    throw error;
  } finally {
    activeTargets.delete(prefix); activeRuns.delete(id); signal?.removeEventListener('abort', abort);
  }
}

export async function generateCharacterVisual(
  input: GenerateCharacterVisualInput, signal?: AbortSignal,
): Promise<CharacterVisualRun> {
  if (!isTauriEnv()) throw new Error(t('角色生图仅支持桌面应用'));
  const target = { ...input.target };
  const prefix = characterPrefix(target);
  const context = projectContext(target);
  const originalRoot = await candidateRoot(target);
  const prompt = input.prompt.trim();
  const references = input.references.map((reference) => ({ ...reference }));
  const operation = input.operation;
  if (!operations.has(operation) || !prompt || prompt.length > MAX_PROMPT_LENGTH) throw new Error(t('请填写有效的生成提示词'));
  const viewSlot = input.viewSlot;
  if (viewSlot !== undefined && (operation !== 'appearance' || !viewSlots.has(viewSlot))) throw new Error(t('无效的定妆视图'));
  if (operation !== 'appearance' && references.length !== 1) throw new Error(t('请只选择一张底图'));
  if (references.length > MAX_REFERENCES || new Set(references.map((reference) => reference.id)).size !== references.length
    || references.some((reference) => !safeId(reference.id))) throw new Error(t('参考图片选择无效'));
  const selected = listCharacterVisualModels(target, operation, references.length).find((model) =>
    model.id === input.model && model.provider === input.provider);
  if (!selected) throw new Error(t('所选模型未配置，或不支持本次图片操作'));
  if (input.workflowId !== undefined && input.workflowId !== selected.workflowId) throw new Error(t('模型配置已变化，请重新选择'));
  const workflow = selected.workflowId ? useAppStore.getState().workflows.find((item) => item.id === selected.workflowId) : undefined;
  const workflowInputs = { ...input.workflowInputs };
  const runninghubModelParameters = { ...input.runninghubModelParameters };
  if (selected.channel === 'midjourney' && (operation !== 'appearance' || viewSlot !== undefined)) throw new Error(t('Midjourney 专用通道仅用于角色生图'));
  const mask = input.mask ? { ...input.mask } : undefined;
  if (mask && (operation !== 'edit' || !selected.supportsMask || references[0]?.id !== mask.referenceId
    || !/^[a-f0-9]{64}$/.test(mask.baseDigest) || !isCharacterImageMaskDataUrl(mask.pngDataUrl))) {
    throw new Error(t('请为当前底图绘制有效蒙版并选择支持的模型'));
  }
  const aspectRatio = input.aspectRatio || (operation === 'turnaround' && selected.ratios.includes('16:9') ? '16:9' : selected.defaultRatio)
    || (mask ? '1:1' : undefined);
  const imageSize = input.imageSize || selected.defaultResolution || (mask ? '1K' : undefined);
  if (aspectRatio && selected.ratios.length && !selected.ratios.includes(aspectRatio)
    || imageSize && selected.resolutions.length && !selected.resolutions.includes(imageSize)) throw new Error(t('所选模型不支持当前图片参数'));
  assertSafeMediaParameterStrings({ aspectRatio, resolution: imageSize });

  if (activeTargets.has(prefix)) throw new Error(t('该角色已有图片任务正在处理'));
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const state = useAppStore.getState();
  const config = state.config;
  const general = selected.provider === 'general' ? config.generalModels?.find((model) => `general/${model.id}` === selected.id) : undefined;
  const connectionId = general?.providerConfigId ?? selected.connectionId ?? selected.provider;
  const connection = config.providers[connectionId];
  const guard = () => {
    controller.signal.throwIfAborted();
    input.assertCurrent?.();
    const current = useAppStore.getState();
    if (context && (current.currentProjectId !== target.projectId
      || !isProjectExpectedContextCurrent(context, current))) throw new Error(t('角色素材归属已变化'));
    if (!configValuesEqual(current.config.providers[connectionId], connection)
      || workflow && !configValuesEqual(current.workflows.find((item) => item.id === workflow.id), workflow)
      || general && !configValuesEqual(current.config.generalModels?.find((model) => model.id === general.id), general)) {
      throw new Error(t('模型配置已变化，请重新选择'));
    }
  };
  let sent = false;
  const abortPreparation = () => { if (!sent) controller.abort(signal?.reason); };
  signal?.addEventListener('abort', abortPreparation, { once: true });
  if (signal?.aborted) abortPreparation();
  activeTargets.set(prefix, id);
  activeRuns.add(id);
  try {
    guard();
    const frozen = await freezeReferences(references, controller.signal);
    if (mask && frozen[0]?.digest !== mask.baseDigest) throw new Error(t('底图已变化，请重新绘制蒙版'));
    guard();
    if (frozen.length === 1) input.onBaseSnapshot?.(frozen[0].url);
    const fingerprint = await sha256BytesHex(new TextEncoder().encode(JSON.stringify([operation, prompt, selected.id,
      selected.provider, connectionId, connection?.baseUrl, general?.modelId,
      aspectRatio, imageSize, frozen.map((reference) => [reference.digest, reference.purpose]),
      input.imageQuality, input.imageBackground, selected.workflowId, workflowInputs, runninghubModelParameters,
      ...(viewSlot || mask ? [viewSlot, mask ? await sha256BytesHex(new TextEncoder().encode(mask.pngDataUrl)) : undefined] : [])])));
    const isNative = context?.modelGeneration === 1;
    const createdAt = Date.now();
    const row: StoredRun = {
      id: `${prefix}${createdAt}-${id}`, operationId: id, target, operation, viewSlot, ...(mask ? { maskedEdit: true } : {}),
      ...(selected.channel === 'midjourney' ? { expectedOutputCount: resolveImageOutputsPerJob(selected.id, selected.provider, config) } : {}),
      name: input.characterName?.trim().slice(0, 128) ?? '', prompt, model: selected.id, provider: selected.provider,
      aspectRatio, imageSize, createdAt, status: 'submitting', candidates: [], sent: false, native: isNative, draft: input.isNew === true,
      imageQuality: input.imageQuality, imageBackground: input.imageBackground, workflowId: selected.workflowId,
      projectEpoch: context?.projectEpoch, fingerprint,
      references: frozen.map(({ id: referenceId, purpose, sourceUrl }) => ({ id: referenceId, purpose, sourceUrl })),
    };
    const requestPrompt = promptForSubmit(row, prompt);
    const secrets = Object.values(config.providers).map((provider) => provider?.apiKey).filter((key): key is string => Boolean(key));
    row.name = safeHistoryText(row.name, secrets);
    row.prompt = safeHistoryText(row.prompt, secrets);
    row.submittedPrompt = safeHistoryText(requestPrompt, secrets);
    const historyParameters = (values: Record<string, string>) => Object.fromEntries(Object.entries(values)
      .filter(([, value]) => typeof value === 'string' && !/^(?:[a-z]:[\\/]|\\\\|file:|asset:|https?:\/\/asset\.localhost)/i.test(value))
      .map(([key, value]) => [key, safeHistoryText(value, secrets)]));
    row.workflowInputs = historyParameters(workflowInputs);
    row.runninghubModelParameters = historyParameters(runninghubModelParameters);
    row.references = row.references.map((reference) => ({
      ...reference, ...(reference.purpose ? { purpose: safeHistoryText(reference.purpose, secrets) } : {}),
    }));
    await saveRun(row, 'add');
    notifyCharacterVisualRuns();
    const beforeSubmit = isNative && context
      ? createNativeCharacterImageSubmissionGuard({ ownerProjectId: context.projectId, projectEpoch: context.projectEpoch,
        characterId: target.characterId, operationId: id, fingerprint, assertCurrent: guard,
        onSubmit: () => { sent = true; notifyCharacterVisualRuns(); } })
      : async () => {
        guard();
        if (sent) throw new Error(t('本次图片任务已提交'));
        row.sent = true;
        try { await saveRun(row, 'claim-submit'); guard(); }
        catch (error) { row.sent = false; throw error; }
        sent = true;
        notifyCharacterVisualRuns();
      };
    const destination = registerCharacterImageTaskContext({ assertCurrent: guard,
      execute: (plan) => executeCharacterVisualPlan(row, plan, { connectionId, root: originalRoot, signal: controller.signal,
        assertCurrent: guard, beforePost: async () => { await beforeSubmit(); },
        ...(isNative && context ? { nativeGuard: beforeSubmit as NativeCharacterImageSubmissionGuard } : {}),
      }),
    });
    try {
      const batch = await generateImagesBatch({
        prompt: requestPrompt, model: selected.id, provider: selected.provider,
        characterWorkbench: target.scope, collectCandidates: true, imageSize, aspectRatio,
        imageQuality: input.imageQuality, imageBackground: input.imageBackground, workflowId: selected.workflowId,
        workflowInputs, runninghubModelParameters,
        image_urls: frozen.map((reference) => reference.url),
        ...(mask ? { characterPaintMask: mask.pngDataUrl } : {}),
      }, 1, controller.signal, destination.beforeSubmit);
      row.sent = true;
      if (isNative) {
        const task = target.ownerId && await readNativeCharacterImageTask(target.ownerId, target.characterId, id);
        if (!task || task.projectEpoch !== row.projectEpoch || task.status !== 'completed' || !task.candidates.length) {
          throw new Error(t('原候选图片文件不可用'));
        }
        row.status = 'completed';
        if (batch.expectedOutputCount && task.candidates.length < batch.expectedOutputCount) {
          row.error = t('本次仅取得部分候选图，已保留可用结果');
        }
        await saveRun(row);
        return displayRun(row, task.candidates.map((candidate) =>
          candidateFromPath(row, { id: candidateId(row, candidate.index), relativePath: candidate.relativePath }, candidate.filePath, candidate.url)));
      }
      for (const [index, result] of batch.results.entries()) {
        try {
          if (await candidateRoot(target) !== originalRoot) throw new Error(t('角色素材目录不可用'));
          row.candidates.push(await persistCandidate(row, index, result.url, originalRoot,
            result.mediaDownloadAccess ?? batch.mediaDownloadAccess, controller.signal));
          await saveRun(row);
        } catch { row.error = t('部分图片未能保存到本机'); }
      }
      if (!row.candidates.length) throw new Error(t('原候选图片文件不可用'));
      if (batch.expectedOutputCount && row.candidates.length < batch.expectedOutputCount) {
        row.error = t('本次仅取得部分候选图，已保留可用结果');
      }
      row.status = 'completed';
      await saveRun(row);
      return displayRun(row, await readCandidates(row));
    } catch (error) {
      if (error instanceof Error && completedCharacterRuns.has(error)) return completedCharacterRuns.get(error)!;
      row.sent = sent;
      const responseError = getHttpResponseError(error);
      const rejected = responseError?.definitiveFailure ? responseError : undefined;
      row.status = row.status === 'failed' || error instanceof PollTaskFailedError ? 'failed'
        : sent && !rejected ? row.recovery?.tasks.length ? 'paused' : 'uncertain' : 'failed';
      row.error = row.status === 'paused' ? t('原任务查询或保存尚未完成，可继续查询')
        : row.status === 'uncertain' ? t('提交状态未知，请查看服务商原任务记录')
        : rejected ? t('服务商拒绝了本次图片请求（HTTP {status}）', { status: rejected.status })
          : sent ? t('本次图片生成未完成') : t('本次图片生成未提交');
      await saveRun(row);
      return displayRun(row, await readCandidates(row), { reviewStatus: row.status === 'uncertain' || row.status === 'paused' ? 'uncertain' : undefined });
    } finally { destination.release(); }
  } finally {
    activeTargets.delete(prefix);
    activeRuns.delete(id);
    notifyCharacterVisualRuns();
    signal?.removeEventListener('abort', abortPreparation);
  }
}
