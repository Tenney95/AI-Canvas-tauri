import { appDataDir } from '@tauri-apps/api/path';
import { lstat } from '@tauri-apps/plugin-fs';
import { fillTemplate, getSlashCommands } from '../components/nodes/shared/slashCommands';
import { getMediaModelOptions } from '../components/nodes/shared/defaultModels';
import { useAppStore } from '../store/useAppStore';
import type { AppConfig } from '../types';
import type { MediaDownloadAccess } from '../types/aiTypes';
import type { DramaCharacter } from '../types/dramaAssets';
import type { ProjectContext } from '../types/project';
import { t } from '../i18n';
import { canonicalXiaohongshuReferenceUrl } from '../utils/xiaohongshuReferenceUrl';
import { characterImageChannel, generateImagesBatch, supportsCharacterImageModel, supportsCharacterPaintMask } from './ai/generateImage';
import { isCharacterImageMaskDataUrl } from './ai/characterImageMask';
import { getHttpResponseError } from './ai/httpUtils';
import { redactModelProtocolErrorText } from './ai/modelProtocolHttp';
import { resolveImageOutputsPerJob, resolveImageParameterCapability } from './ai/mediaModelCapabilities';
import { assertSafeMediaParameterStrings } from './ai/modelCapabilityValidation';
import { buildCharacterLookbookPrompt } from './dramaAssetPrompt';
import { getProjectDataDir, getAssetUrlFromPath, isTauriEnv, joinPath } from './fileService';
import { getRelativeAssetPath, identifyAsset, resolveIndexedAssetPath } from './fs/assetIndex';
import { fingerprintAssetImage } from './fs/assetImageMetadata';
import { bytePartsToBase64Async, ensureProjectDataDir } from './fs/core';
import { characterVisualImageFormat, isCharacterVisualInputUrl, saveCharacterVisualResult } from './fs/characterVisualFiles';
import { readImageSourceBlob } from './fs/imageSourceBlob';
import { openDB, STORE_METADATA } from './indexedDb/schema';
import { configValuesEqual } from './configPatch';
import { MEDIA_DATA_URL_BYTE_LIMITS, sha256BytesHex } from './mediaDataUrl';
import { createNativeCharacterImageSubmissionGuard, listNativeCharacterImageTasks, reviewNativeCharacterImageTask } from './nativeCharacterImageTask';
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
  status: 'submitting' | 'completed' | 'failed' | 'uncertain' | 'reviewed';
  candidates: CharacterVisualCandidate[];
  references: Array<Pick<CharacterVisualReference, 'id' | 'purpose' | 'sourceUrl'>>;
  error?: string;
  reviewable?: boolean;
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
const viewSlots = new Set<CharacterVisualViewSlot>(['sheet', 'side', 'front']);

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
  const state = useAppStore.getState();
  if (scope === 'global') return { scope, characterId };
  try {
    const context = captureLegacyProjectExpectedContext(state, 'project');
    if (context.kind === 'project') {
      return { scope, characterId, ownerId: context.projectId, projectId: state.currentProjectId ?? undefined };
    }
  } catch { /* 未准备好时由提交前复核给出提示。 */ }
  return { scope, characterId };
}

function projectContext(target: CharacterVisualTarget): ProjectContext | undefined {
  if (target.scope === 'global') return undefined;
  const state = useAppStore.getState();
  const context = captureLegacyProjectExpectedContext(state, 'project');
  if (context.kind !== 'project' || context.projectId !== target.ownerId || state.currentProjectId !== target.projectId) {
    throw new Error(t('角色素材归属已变化'));
  }
  return context;
}

export function listCharacterVisualModels(
  target: CharacterVisualTarget, operation: CharacterVisualOperation, referenceCount = 0,
  config: AppConfig = useAppStore.getState().config,
): CharacterVisualModel[] {
  if (!isTauriEnv() || target.scope === 'project' && !target.ownerId) return [];
  return getMediaModelOptions(config.generalModels, config).flatMap((option) => {
    if (option.mediaKind !== 'image' || !supportsCharacterImageModel(option.value, option.provider, config)) return [];
    const capability = resolveImageParameterCapability(option.value, option.provider, config);
    const channel = characterImageChannel(option.value, option.provider, config);
    if (channel === 'midjourney' && operation !== 'appearance') return [];
    const maxReferences = supportsCharacterImageModel(option.value, option.provider, config, 1)
      ? Math.min(channel === 'midjourney' ? 1 : MAX_REFERENCES, capability?.maxImageReferences ?? 1) : 0;
    const supportsMask = maxReferences > 0 && supportsCharacterPaintMask(option.value, option.provider, config);
    if (Math.max(operation === 'appearance' ? 0 : 1, referenceCount) > maxReferences) return [];
    return [{
      id: option.value,
      label: option.label,
      provider: option.provider,
      ratios: capability?.ratios ?? [],
      resolutions: capability?.resolutions ?? [],
      defaultRatio: capability?.defaultRatio,
      defaultResolution: capability?.defaultResolution,
      supportsReferences: maxReferences > 0,
      supportsMask,
      channel,
      maxReferences,
    }];
  });
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
    createdAt: row.createdAt, status: row.status, references: row.references.map((reference) => ({
      ...reference, sourceUrl: canonicalXiaohongshuReferenceUrl(reference.sourceUrl),
    })), error: row.error,
    candidates, ...overrides,
  };
}

export async function listCharacterVisualRuns(target: CharacterVisualTarget): Promise<CharacterVisualRun[]> {
  const rows = await findRuns(target);
  const nativeTasks = rows.some((row) => row.native) && target.ownerId
    ? await listNativeCharacterImageTasks(target.ownerId, target.characterId, rows.map((row) => row.operationId)) : [];
  return Promise.all(rows.map(async (row) => {
    if (activeRuns.has(row.operationId)) return displayRun(row, [], { status: 'submitting' });
    if (row.native) {
      const task = nativeTasks.find((item) => item.operationId === row.operationId && item.projectEpoch === row.projectEpoch);
      const candidates = (task?.candidates ?? []).map((candidate) =>
        candidateFromPath(row, { id: candidateId(row, candidate.index), relativePath: candidate.relativePath }, candidate.filePath, candidate.url));
      if (task?.status === 'completed') {
        return displayRun(row, candidates, { status: candidates.length ? 'completed' : 'failed',
          error: !candidates.length ? t('原候选图片文件不可用')
            : row.expectedOutputCount && candidates.length < row.expectedOutputCount ? t('本次仅取得部分候选图，已保留可用结果') : row.error });
      }
      if (task?.status === 'outcome-unknown' || task?.status === 'prepared') {
        return displayRun(row, candidates, { status: 'uncertain', reviewable: true,
          error: task.status === 'prepared' ? t('本次图片生成未提交') : t('提交状态未知，请查看服务商原任务记录') });
      }
      if (task?.status === 'reviewed') return displayRun(row, candidates, { status: 'reviewed', error: undefined });
      if (task?.status === 'failed' || row.status === 'submitting') {
        return displayRun(row, [], { status: 'failed', error: t('本次图片生成未完成') });
      }
    }
    const candidates = await readCandidates(row);
    if (row.status === 'submitting') return displayRun(row, candidates, row.sent
      ? { status: 'uncertain', reviewable: true, error: t('提交状态未知，请查看服务商原任务记录') }
      : { status: 'failed', error: t('本次图片生成未提交') });
    if (row.status === 'completed' && !candidates.length) {
      return displayRun(row, [], { status: 'failed', error: t('原候选图片文件不可用') });
    }
    if (row.status === 'completed' && row.expectedOutputCount && candidates.length < row.expectedOutputCount) {
      return displayRun(row, candidates, { error: t('本次仅取得部分候选图，已保留可用结果') });
    }
    return displayRun(row, candidates, { reviewable: row.sent && row.status === 'uncertain' });
  }));
}

export async function reviewCharacterVisualRun(target: CharacterVisualTarget, id: string): Promise<void> {
  const row = (await findRuns(target)).find((item) => item.operationId === id);
  if (!row || activeRuns.has(id)) throw new Error(t('原角色生成任务已变化，请刷新后重试'));
  if (row.native && target.ownerId) await reviewNativeCharacterImageTask(target.ownerId, target.characterId, id);
  else {
    if (!row.sent || row.status !== 'uncertain' && row.status !== 'submitting') {
      throw new Error(t('原角色生成任务已变化，请刷新后重试'));
    }
    await saveRun({ ...row, status: 'reviewed', error: undefined });
  }
}

/** 采纳时重读原任务，并核对候选图仍属于当前角色和作品。 */
export async function readCharacterVisualCandidate(target: CharacterVisualTarget, candidateIdValue: string): Promise<CharacterVisualCandidate> {
  projectContext(target);
  const operationId = candidateIdValue.slice(0, 36);
  const row = (await findRuns(target)).find((item) => item.operationId === operationId);
  if (row?.native && target.ownerId) {
    const [task] = await listNativeCharacterImageTasks(target.ownerId, target.characterId, [operationId]);
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
  const id = candidateId(row, index);
  const folder = candidateFolder(row);
  const stem = row.target.scope === 'global' ? id : `character-visual-${id}`;
  if (row.target.ownerId) await ensureProjectDataDir(row.target.ownerId, { throwOnError: true });
  const { filePath } = await saveCharacterVisualResult(url, joinPath(root, folder), stem, access, signal);
  const relativePath = getRelativeAssetPath(filePath, root);
  if (!relativePath) throw new Error(t('原候选图片文件不可用'));
  const { bytes, digest } = await fingerprintAssetImage(filePath, signal);
  if (row.target.scope === 'global') return { id, relativePath, bytes, digest };
  const identity = await identifyAsset(filePath, { source: 'project', projectId: row.target.ownerId, rootPath: root });
  return { id, relativePath, bytes, digest, assetId: identity.assetId };
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
  const connectionId = general?.providerConfigId ?? selected.provider;
  const connection = config.providers[connectionId];
  const guard = () => {
    controller.signal.throwIfAborted();
    input.assertCurrent?.();
    const current = useAppStore.getState();
    if (context && (current.currentProjectId !== target.projectId
      || !isProjectExpectedContextCurrent(context, current))) throw new Error(t('角色素材归属已变化'));
    if (!configValuesEqual(current.config.providers[connectionId], connection)
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
      ...(viewSlot || mask ? [viewSlot, mask ? await sha256BytesHex(new TextEncoder().encode(mask.pngDataUrl)) : undefined] : [])])));
    const isNative = context?.modelGeneration === 1;
    const createdAt = Date.now();
    const row: StoredRun = {
      id: `${prefix}${createdAt}-${id}`, operationId: id, target, operation, viewSlot, ...(mask ? { maskedEdit: true } : {}),
      ...(selected.channel === 'midjourney' ? { expectedOutputCount: resolveImageOutputsPerJob(selected.id, selected.provider, config) } : {}),
      name: input.characterName?.trim().slice(0, 128) ?? '', prompt, model: selected.id, provider: selected.provider,
      aspectRatio, imageSize, createdAt, status: 'submitting', candidates: [], sent: false, native: isNative, draft: input.isNew === true,
      projectEpoch: context?.projectEpoch, fingerprint,
      references: frozen.map(({ id: referenceId, purpose, sourceUrl }) => ({ id: referenceId, purpose, sourceUrl })),
    };
    const requestPrompt = promptForSubmit(row, prompt);
    const secrets = Object.values(config.providers).map((provider) => provider?.apiKey).filter((key): key is string => Boolean(key));
    row.name = safeHistoryText(row.name, secrets);
    row.prompt = safeHistoryText(row.prompt, secrets);
    row.submittedPrompt = safeHistoryText(requestPrompt, secrets);
    row.references = row.references.map((reference) => ({
      ...reference, ...(reference.purpose ? { purpose: safeHistoryText(reference.purpose, secrets) } : {}),
    }));
    await saveRun(row, 'add');
    const beforeSubmit = isNative && context
      ? createNativeCharacterImageSubmissionGuard({ ownerProjectId: context.projectId, projectEpoch: context.projectEpoch,
        characterId: target.characterId, operationId: id, fingerprint, assertCurrent: guard,
        onSubmit: () => { sent = true; } })
      : async () => {
        guard();
        if (sent) throw new Error(t('本次图片任务已提交'));
        row.sent = true;
        try { await saveRun(row, 'claim-submit'); guard(); }
        catch (error) { row.sent = false; throw error; }
        sent = true;
      };
    try {
      const batch = await generateImagesBatch({
        prompt: requestPrompt, model: selected.id, provider: selected.provider,
        characterWorkbench: target.scope, collectCandidates: true, imageSize, aspectRatio,
        image_urls: frozen.map((reference) => reference.url),
        ...(mask ? { characterPaintMask: mask.pngDataUrl } : {}),
      }, 1, controller.signal, beforeSubmit);
      row.sent = true;
      if (isNative) {
        const task = target.ownerId && (await listNativeCharacterImageTasks(target.ownerId, target.characterId, [id]))
          .find((item) => item.operationId === id && item.projectEpoch === row.projectEpoch);
        if (!task || task.status !== 'completed' || !task.candidates?.length) throw new Error(t('原候选图片文件不可用'));
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
      row.sent = sent;
      const responseError = getHttpResponseError(error);
      const rejected = responseError?.definitiveFailure ? responseError : undefined;
      row.status = sent && !rejected ? 'uncertain' : 'failed';
      row.error = row.status === 'uncertain' ? t('提交状态未知，请查看服务商原任务记录')
        : rejected ? t('服务商拒绝了本次图片请求（HTTP {status}）', { status: rejected.status }) : t('本次图片生成未提交');
      await saveRun(row);
      return displayRun(row, await readCandidates(row), { reviewable: row.status === 'uncertain' });
    }
  } finally {
    activeTargets.delete(prefix);
    activeRuns.delete(id);
    signal?.removeEventListener('abort', abortPreparation);
  }
}
