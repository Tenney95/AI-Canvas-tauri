/** 项目包预览与更新编排。会话仅驻留内存，任何预览都不写已有项目。 */
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import * as files from './fileService';
import { readArchiveProject, readArchiveChat, readArchiveEpisodes, restoreProjectArchive,
  type ProjectArchiveManifest, type ProjectArchiveChatPayload, type ProjectImportResult } from './projectTransferService';
import type { ProjectSaveData } from './storageService';
import type { ProjectExchangeBundle, ProjectExchangeRevision, ProjectExchangeState } from '../types/projectExchange';
import { materializeExchangeSnapshot, safeExchangePath, exchangeEqual, type ArchiveAssetDigest, type ExchangeCapture } from './projectExchangeDomain';
import { createProjectExchangeRevision, parseProjectExchangeBundle, findProjectExchangeBase } from './projectExchangeFormat';
import { loadProjectExchangeGraph, loadProjectExchangeState, saveProjectExchangeCheckpoint, parseProjectExchangeState } from './indexedDb/projectExchangeRepository';
import { beginProjectImportOperation, commitProjectImport, readProjectImportScope, listProjectImportRecoveries,
  type ProjectImportHistoryRow } from './indexedDb/projectImportRepository';
import { resolveProjectMerge, type ProjectMergePlan, type ProjectMergeSide } from './projectMergeService';
import { compareProjectSnapshots, captureProjectSnapshot } from './projectMergeWorkerClient';
import { configValuesEqual } from './configPatch';
import { sha256BytesHex } from './mediaDataUrl';
import { toProjectSummaryRecord } from './indexedDb/projectSummary';

export interface PreparedProjectImport {
  id: string; stagingProjectId: string; stagingFolder: string; archivePath: string; directory: string;
  manifest: ProjectArchiveManifest; records: ProjectSaveData[]; chat: Array<ProjectArchiveChatPayload | null>;
  assets: ArchiveAssetDigest[]; bundle: ProjectExchangeBundle | null; sourceState: ProjectExchangeState | null; disposed: boolean;
}
export interface ProjectImportPreview {
  sessionId: string; targetId: string; expectedRecords: ProjectSaveData[]; expectedState: ProjectExchangeState | null;
  local: ExchangeCapture; incoming: ExchangeCapture; plan: ProjectMergePlan; baseStatus: string; localDirectory: string;
  incomingHead: ProjectExchangeRevision | null; localHead: ProjectExchangeRevision | null;
}
export interface ProjectImportOptions {
  appendChat: boolean; appendMemories: boolean; independent?: boolean;
  signal?: AbortSignal; onTransfer?: (operationId: string) => void;
}
const sessions = new Map<string, PreparedProjectImport>();
function requireSession(session: PreparedProjectImport) {
  if (session.disposed || sessions.get(session.id) !== session) throw new Error('项目包预览已关闭，请重新选择');
}
export async function closePreparedProjectImport(session: PreparedProjectImport): Promise<void> {
  if (session.disposed) return;
  session.disposed = true; sessions.delete(session.id);
  await files.deleteProjectDataDir(session.stagingProjectId);
}
export async function prepareProjectImport(): Promise<PreparedProjectImport | null> {
  if (!files.isTauriEnv()) throw new Error('项目导入仅在桌面版可用');
  const archivePath = await open({ multiple: false, title: '选择项目包', filters: [{ name: 'AI Canvas 项目包', extensions: ['aicanvas'] }] });
  if (typeof archivePath !== 'string' || !archivePath) return null;
  const stagingProjectId = crypto.randomUUID(), stagingFolder = files.buildProjectFolderName('导入预览', stagingProjectId);
  files.registerProjectFolder(stagingProjectId, stagingFolder);
  try {
    const directory = await files.ensureProjectDataDir(stagingProjectId); if (!directory) throw new Error('无法准备导入目录');
    const unpacked = await invoke<{ texts: Record<string, string>; assets: ArchiveAssetDigest[] }>('unpack_project_archive', { archivePath, assetsDir: directory });
    const manifest = JSON.parse(unpacked.texts['manifest.json'] ?? 'null') as ProjectArchiveManifest;
    if (!manifest || !Number.isSafeInteger(manifest.formatVersion) || manifest.formatVersion < 1 || manifest.formatVersion > 3) throw new Error('项目包版本无效或需要升级应用');
    const owner = readArchiveProject(JSON.parse(unpacked.texts['project.json'] ?? 'null'), '项目记录');
    if (manifest.projectId !== owner.id) throw new Error('项目包清单与项目身份不一致');
    const episodes = readArchiveEpisodes(unpacked.texts['episodes.json'], manifest, owner);
    const bundle = manifest.formatVersion === 3 ? await parseProjectExchangeBundle(unpacked.texts['exchange.json']) : null;
    if (!Array.isArray(unpacked.assets)) throw new Error('原生归档组件需要重新编译，请重启桌面开发服务');
    let sourceState: ProjectExchangeState | null = null;
    if (bundle) {
      const head = bundle.revisions.find((revision) => revision.revisionId === bundle.headRevisionId)!;
      sourceState = parseProjectExchangeState(JSON.parse(unpacked.texts['exchange-state.json'] ?? 'null'));
      if (sourceState.ownerId !== owner.id || sourceState.lineageId !== bundle.lineageId || sourceState.headRevisionId !== bundle.headRevisionId
        || sourceState.rootProjectId !== head.snapshot.rootProjectId) throw new Error('项目包来源映射不一致');
      for (const file of bundle.files) {
        const descriptor = head.snapshot.media.find((item) => item.id === file.mediaId)!;
        const actual = unpacked.assets.find((item) => safeExchangePath(item.path) === file.archivePath.slice(7));
        if (!actual || actual.bytes !== descriptor.bytes || actual.sha256 !== descriptor.sha256) throw new Error('项目包素材校验失败，未修改本机项目');
      }
      const captured = await captureProjectSnapshot([owner, ...episodes.map((item) => item.project)], unpacked.assets, sourceState, head.snapshot);
      if (!exchangeEqual(captured.snapshot, head.snapshot)) throw new Error('项目包业务记录与协作快照不一致');
    }
    const session: PreparedProjectImport = { id: crypto.randomUUID(), stagingProjectId, stagingFolder, archivePath, directory,
      manifest, records: [owner, ...episodes.map((item) => item.project)], chat: [readArchiveChat(JSON.parse(unpacked.texts['chat.json'] ?? 'null')), ...episodes.map((item) => item.chat)],
      assets: unpacked.assets, bundle, sourceState, disposed: false };
    sessions.set(session.id, session); return session;
  } catch (error) { await files.deleteProjectDataDir(stagingProjectId).catch(() => undefined); throw error; }
}

export async function prepareExchangeExport(records: ProjectSaveData[], assets: ArchiveAssetDigest[], directory?: string): Promise<ProjectExchangeBundle> {
  const ownerId = records[0].id, previous = await loadProjectExchangeState(ownerId);
  const graph = previous ? await loadProjectExchangeGraph(previous.lineageId) : { revisions: [], ancestors: [] };
  const oldHead = graph.revisions.find((revision) => revision.revisionId === previous?.headRevisionId);
  const captured = await captureProjectSnapshot(records, assets, previous, oldHead?.snapshot, directory);
  let head = await createProjectExchangeRevision(captured.snapshot, previous ? [previous.headRevisionId] : []);
  if (oldHead?.contentDigest === head.contentDigest) head = oldHead;
  const sorted = (items: ProjectSaveData[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  if (!configValuesEqual(sorted(records), sorted(await readProjectImportScope(ownerId)))) throw new Error('项目在导出准备期间发生变化，请重新导出');
  const state: ProjectExchangeState = { ownerId, lineageId: captured.snapshot.lineageId, rootProjectId: captured.snapshot.rootProjectId,
    headRevisionId: head.revisionId, stateVersion: (previous?.stateVersion ?? 0) + 1, identities: captured.identities };
  const revisions = [...graph.revisions.filter((revision) => revision.revisionId !== head.revisionId), head];
  const bundle = await parseProjectExchangeBundle({ format: 'ai-canvas-project-exchange', version: 1, packageId: crypto.randomUUID(),
    lineageId: state.lineageId, headRevisionId: head.revisionId, revisions, ancestors: graph.ancestors,
    files: head.snapshot.media.map((descriptor) => {
      const entity = head.snapshot.entities.find((item) => item.kind === 'file' && item.data.mediaId === descriptor.id)!;
      return { mediaId: descriptor.id, archivePath: `assets/${captured.files.get(entity.id)!}` };
    }) });
  // 先确认完整版本材料仍可导出，超限不得把本机协作状态推进到不可读取的版本。
  await saveProjectExchangeCheckpoint({ expectedState: previous, state, revisions: [head] });
  return bundle;
}

/** 旧包只按仍保留的源 ID 人工对照；从不据此宣称找到了共同版本。 */
export async function previewProjectImport(session: PreparedProjectImport, targetId: string, confirmedBase?: PreparedProjectImport): Promise<ProjectImportPreview> {
  requireSession(session);
  const expectedRecords = await readProjectImportScope(targetId), expectedState = await loadProjectExchangeState(targetId);
  const directory = await files.ensureProjectDataDir(targetId); if (!directory) throw new Error('无法读取目标项目素材');
  const assets = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: directory });
  let incomingHead: ProjectExchangeRevision | null = null, localHead: ProjectExchangeRevision | null = null, baseStatus = 'manual';
  const localGraph = expectedState ? await loadProjectExchangeGraph(expectedState.lineageId) : { revisions: [], ancestors: [] };
  let local = await captureProjectSnapshot(expectedRecords, assets, expectedState, localGraph.revisions.find((item) => item.revisionId === expectedState?.headRevisionId)?.snapshot, directory);
  let incoming: ExchangeCapture;
  let base = null;
  if (session.bundle) {
    incomingHead = session.bundle.revisions.find((revision) => revision.revisionId === session.bundle!.headRevisionId)!;
    if (!expectedState || expectedState.lineageId !== session.bundle.lineageId || expectedState.rootProjectId !== incomingHead.snapshot.rootProjectId) {
      throw new Error('该项目与项目包没有相同的协作来源。旧项目请先用原始导出包导入建立来源，或作为新项目导入。');
    }
    const graph = await loadProjectExchangeGraph(expectedState.lineageId);
    const full = new Map([...graph.revisions, ...session.bundle.revisions].map((revision) => [revision.revisionId, revision]));
    const headers = new Map([...graph.ancestors, ...session.bundle.ancestors].filter((item) => !full.has(item.revisionId)).map((item) => [item.revisionId, item]));
    const match = await findProjectExchangeBase(expectedState.headRevisionId, incomingHead.revisionId, [...full.values()], [...headers.values()]);
    baseStatus = match.status; if (match.status === 'found') base = match.revision.snapshot;
    incoming = { snapshot: incomingHead.snapshot, identities: [], files: new Map(incomingHead.snapshot.entities.filter((item) => item.kind === 'file')
      .map((item) => [item.id, session.bundle!.files.find((file) => file.mediaId === item.data.mediaId)!.archivePath.slice(7)])) };
    const oldHead = full.get(expectedState.headRevisionId);
    localHead = await createProjectExchangeRevision(local.snapshot, [expectedState.headRevisionId]);
    if (oldHead?.contentDigest === localHead.contentDigest) localHead = oldHead;
  } else {
    // 对齐 owner，分集只有源 ID 仍相同时才配对；其余分集都是明确新增/删除候选。
    const adjusted = session.records.map((record, index) => ({ ...record, id: index === 0 ? targetId : record.id, parentId: index === 0 ? undefined : targetId }));
    const temporary: ProjectExchangeState = { ownerId: targetId, lineageId: local.snapshot.lineageId, rootProjectId: local.snapshot.rootProjectId,
      stateVersion: 1, headRevisionId: '0'.repeat(64), identities: local.identities.filter((item) => item.kind === 'project') };
    incoming = await captureProjectSnapshot(adjusted, session.assets, temporary);
    // 相同旧包文件路径只作为人工对照键，不能自动判断删除。
    const localFiles = new Map(local.identities.filter((item) => item.kind === 'file').map((item) => [item.localId, item.id]));
    const adjustedState = { ...temporary, identities: [...temporary.identities, ...incoming.identities.filter((item) => item.kind === 'file').map((item) => ({ ...item, id: localFiles.get(item.localId) ?? item.id }))] };
    incoming = await captureProjectSnapshot(adjusted, session.assets, adjustedState);
    // 未建立来源的双向手工更新不写入虚构的 DAG。
    local = { ...local, snapshot: { ...local.snapshot, lineageId: incoming.snapshot.lineageId } };
    if (confirmedBase) {
      requireSession(confirmedBase);
      const baseRecords = confirmedBase.records.map((record, index) => ({ ...record,
        id: index === 0 ? targetId : record.id, parentId: index === 0 ? undefined : targetId }));
      // 来源由用户确认；只对齐明确保留的 ID，不按名称/序号猜配分集或资产。
      const mappings = new Map([...incoming.identities, ...local.identities].map((item) => [JSON.stringify([item.kind, item.scopeId, item.localId]), item]));
      const baseState = { ...temporary, identities: [...mappings.values()] };
      base = (await captureProjectSnapshot(baseRecords, confirmedBase.assets, baseState)).snapshot;
      baseStatus = 'externalConfirmed';
    }
  }
  const plan = await compareProjectSnapshots(base, local.snapshot, incoming.snapshot);
  if (session.bundle && expectedState) {
    const graph = await loadProjectExchangeGraph(expectedState.lineageId);
    const full = new Map([...graph.revisions, ...session.bundle.revisions].map((item) => [item.revisionId, item]));
    const headers = [...graph.ancestors, ...session.bundle.ancestors].filter((item) => !full.has(item.revisionId));
    const match = await findProjectExchangeBase(expectedState.headRevisionId, incomingHead!.revisionId, [...full.values()], [...new Map(headers.map((item) => [item.revisionId, item])).values()]);
    plan.alreadyApplied = match.status === 'found' && match.revision.revisionId === incomingHead!.revisionId;
  }
  return { sessionId: session.id, targetId, expectedRecords, expectedState, local, incoming, plan, baseStatus, incomingHead, localHead, localDirectory: directory };
}

/** 只为已校验的本地文件生成预览地址；不加载包内任意网络 URL。 */
export function projectImportMediaPreview(session: PreparedProjectImport, preview: ProjectImportPreview, side: 'local' | 'incoming', value: unknown): { url: string; kind: string } | null {
  if (value === undefined) return null;
  const capture = side === 'local' ? preview.local : preview.incoming;
  const token = JSON.stringify(value).match(/exchange-file:([A-Za-z0-9_-]+)/)?.[1];
  const entity = token ? capture.snapshot.entities.find((item) => item.kind === 'file' && item.id === token)
    : capture.snapshot.entities.find((item) => item.kind === 'file' && typeof value === 'object' && value !== null && 'mediaId' in value && item.data.mediaId === value.mediaId);
  const descriptor = capture.snapshot.media.find((item) => item.id === entity?.data.mediaId);
  const path = entity ? capture.files.get(entity.id) : undefined;
  if (!path || !descriptor || !['image', 'video', 'audio'].includes(descriptor.kind)) return null;
  return { url: convertFileSrc(files.joinPath(side === 'local' ? preview.localDirectory : session.directory, safeExchangePath(path))), kind: descriptor.kind };
}

async function historyRows(session: PreparedProjectImport, records: ProjectSaveData[], options: ProjectImportOptions,
  identities: ProjectExchangeState['identities']): Promise<ProjectImportHistoryRow[]> {
  if (!options.appendChat && !options.appendMemories) return [];
  const rows: ProjectImportHistoryRow[] = [], namespace = session.bundle?.lineageId ?? session.manifest.projectId;
  const origin = async (kind: string, source: { id: string }) => {
    const stored = (source as { archiveOriginId?: unknown }).archiveOriginId;
    return typeof stored === 'string' && /^[a-f0-9]{64}$/.test(stored) ? stored
      : sha256BytesHex(new TextEncoder().encode(JSON.stringify([namespace, kind, source.id])));
  };
  const stable = async (kind: string, source: { id: string }, projectId: string) => 'exchange-' + await sha256BytesHex(new TextEncoder().encode(JSON.stringify([projectId, kind, await origin(kind, source)])));
  const retained = new Set(records.map((record) => record.id));
  const projectMap = new Map(session.records.map((record, index) => {
    const logical = session.sourceState?.identities.find((item) => item.kind === 'project' && item.localId === record.id)?.id;
    const local = index === 0 ? records[0].id : identities.find((item) => item.kind === 'project' && item.id === (logical ?? record.id))?.localId;
    return [record.id, local && retained.has(local) ? local : undefined];
  }));
  const conversations = new Map<string, string>(), messages = new Map<string, string>(), messageConversations = new Map<string, string>();
  // 先为整部剧建立来源映射，项目记忆可能引用另一个分集的会话。
  for (const [index, payload] of session.chat.entries()) {
    const projectId = projectMap.get(session.records[index].id); if (!payload || !projectId) continue;
    const localConversations = new Set(payload.conversations.map((conversation) => conversation.id));
    for (const conversation of payload.conversations) {
      if (conversations.has(conversation.id)) throw new Error('项目包中的会话 ID 重复');
      conversations.set(conversation.id, await stable('conversation', conversation, projectId));
    }
    for (const message of payload.messages) {
      if (!localConversations.has(message.conversationId)) continue;
      if (messages.has(message.id)) throw new Error('项目包中的消息 ID 重复');
      messages.set(message.id, await stable('message', message, projectId));
      messageConversations.set(message.id, message.conversationId);
    }
  }
  for (const [index, payload] of session.chat.entries()) {
    if (!payload) continue;
    const projectId = projectMap.get(session.records[index].id); if (!projectId) continue;
    const localConversations = new Set(payload.conversations.map((conversation) => conversation.id));
    if (options.appendChat) {
      for (const conversation of payload.conversations) rows.push({ store: 'chatConversations', value: {
        id: conversations.get(conversation.id)!, archiveOriginId: await origin('conversation', conversation), projectId, title: conversation.title, titleSource: conversation.titleSource,
        pinned: false, archived: conversation.archived === true, agentMode: 'plan', createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt, messageCount: payload.messages.filter((message) => message.conversationId === conversation.id).length } });
      for (const message of payload.messages) {
        if (!localConversations.has(message.conversationId)) continue;
        rows.push({ store: 'chatMessages', value: { id: messages.get(message.id)!, archiveOriginId: await origin('message', message), projectId, conversationId: conversations.get(message.conversationId)!,
          sequence: message.sequence, role: message.role, content: message.content, status: 'done', createdAt: message.createdAt, updatedAt: message.updatedAt } });
      }
    }
    if (options.appendMemories) for (const memory of payload.memories) {
      const sourceConversationId = memory.source?.conversationId ?? '', sourceMessageId = memory.source?.messageId ?? '';
      const conversationId = options.appendChat ? conversations.get(sourceConversationId) : undefined;
      rows.push({ store: 'projectMemories', value: {
        id: await stable('memory', memory, projectId), archiveOriginId: await origin('memory', memory), projectId, kind: memory.kind, content: memory.content,
        enabled: memory.enabled === true, createdAt: memory.createdAt, updatedAt: memory.updatedAt, source: {
          conversationId: conversationId ?? '',
          messageId: conversationId && messageConversations.get(sourceMessageId) === sourceConversationId ? messages.get(sourceMessageId) : undefined,
          unavailable: memory.source?.unavailable === true || !conversationId } } });
    }
  }
  return rows;
}

/** 恢复点的媒体也复制到独立路径，之后编辑原文件不会改掉恢复点字节。 */
async function freezeRecovery(capture: ExchangeCapture, records: ProjectSaveData[], directory: string, options: Pick<ProjectImportOptions, 'signal' | 'onTransfer'> = {}) {
  const operationId = crypto.randomUUID(), paths = new Map<string, string>();
  const assets = capture.snapshot.entities.filter((item) => item.kind === 'file').map((entity) => {
    const descriptor = capture.snapshot.media.find((item) => item.id === entity.data.mediaId)!;
    const path = capture.files.get(entity.id)!;
    const destinationPath = `${entity.id}/${safeExchangePath(String(entity.data.name ?? path.split('/').pop()))}`;
    paths.set(entity.id, `imports/${operationId}/${destinationPath}`);
    return { path, destinationPath, bytes: descriptor.bytes, sha256: descriptor.sha256 };
  });
  options.signal?.throwIfAborted(); options.onTransfer?.(operationId);
  await invoke('publish_project_import_assets', { stagingDir: directory, projectDir: directory, operationId, assets });
  options.signal?.throwIfAborted();
  const identities = capture.identities.map((identity) => identity.kind === 'file' && paths.has(identity.id) ? { ...identity, localId: paths.get(identity.id)! } : { ...identity });
  return { records: materializeExchangeSnapshot(capture.snapshot, identities, records, records[0].dataFolder ?? records[0].id, paths), identities,
    assets: assets.map((asset) => ({ path: `imports/${operationId}/${asset.destinationPath}`, bytes: asset.bytes, sha256: asset.sha256 })) };
}

export async function applyProjectImport(session: PreparedProjectImport, preview: ProjectImportPreview | null,
  choices: Readonly<Record<string, ProjectMergeSide>>, options: ProjectImportOptions, assertCurrent?: () => void): Promise<ProjectImportResult> {
  requireSession(session);
  if (!preview && !session.bundle) return restoreProjectArchive(session.archivePath, undefined, options, session);
  if (preview && preview.sessionId !== session.id) throw new Error('预览会话已变化');
  if (preview?.plan.alreadyApplied) throw new Error('该版本已经处理，未重复写入项目');
  const snapshot = preview ? resolveProjectMerge(preview.plan, choices) : session.bundle!.revisions.find((item) => item.revisionId === session.bundle!.headRevisionId)!.snapshot;
  const ownerId = preview?.targetId ?? crypto.randomUUID(), operationId = crypto.randomUUID();
  options.signal?.throwIfAborted(); options.onTransfer?.(operationId);
  const folder = preview?.expectedRecords[0].dataFolder ?? files.buildProjectFolderName(String(snapshot.entities.find((item) => item.kind === 'project' && item.id === snapshot.rootProjectId)?.data.name ?? '导入项目'), ownerId);
  files.registerProjectFolder(ownerId, folder);
  const targetDir = await files.ensureProjectDataDir(ownerId); if (!targetDir) throw new Error('无法准备目标素材目录');
  const paths = new Map<string, string>(), incomingAssets: Array<ArchiveAssetDigest & { destinationPath: string }> = [];
  for (const entity of snapshot.entities.filter((item) => item.kind === 'file')) {
    const localEntity = preview?.local.snapshot.entities.find((item) => item.kind === 'file' && item.id === entity.id);
    if (localEntity && exchangeEqual(localEntity.data, entity.data)) { paths.set(entity.id, preview!.local.files.get(entity.id)!); continue; }
    const archivePath = session.bundle?.files.find((file) => file.mediaId === entity.data.mediaId)?.archivePath.slice(7) ?? preview?.incoming.files.get(entity.id);
    const digest = session.assets.find((asset) => asset.path === archivePath); if (!archivePath || !digest) throw new Error('对方素材不完整，不能应用更新');
    const destinationPath = `${entity.id}/${safeExchangePath(typeof entity.data.name === 'string' ? entity.data.name : archivePath.split('/').pop()!)}`;
    incomingAssets.push({ ...digest, destinationPath }); paths.set(entity.id, `imports/${operationId}/${destinationPath}`);
  }
  if (preview && !configValuesEqual(preview.expectedRecords, await readProjectImportScope(ownerId))) throw new Error('项目在预览后发生变化，请重新对比');
  await beginProjectImportOperation(operationId, ownerId, session.stagingProjectId, session.stagingFolder);
  await invoke('publish_project_import_assets', { stagingDir: session.directory, projectDir: targetDir, operationId, assets: incomingAssets });
  options.signal?.throwIfAborted();
  const identities: ProjectExchangeState['identities'] = structuredClone(preview?.local.identities ?? [{ kind: 'project' as const, scopeId: snapshot.rootProjectId, id: snapshot.rootProjectId, localId: ownerId }]);
  // 文件映射是接收端的实际相对路径，不沿用发送端目录。
  for (const [id, path] of paths) { const index = identities.findIndex((item) => item.kind === 'file' && item.id === id);
    const mapping = { kind: 'file' as const, scopeId: snapshot.rootProjectId, id, localId: path }; if (index < 0) identities.push(mapping); else identities[index] = mapping; }
  const records = materializeExchangeSnapshot(snapshot, identities, preview?.expectedRecords ?? [], folder, paths);
  const graph = preview?.expectedState ? await loadProjectExchangeGraph(preview.expectedState.lineageId) : { revisions: [], ancestors: [] };
  const revisions = new Map([...graph.revisions, ...(session.bundle?.revisions ?? [])].map((item) => [item.revisionId, item]));
  if (preview?.localHead) revisions.set(preview.localHead.revisionId, preview.localHead);
  let state: ProjectExchangeState | null = null;
  if (session.bundle) {
    const parents = [...new Set([preview?.localHead?.revisionId, session.bundle.headRevisionId].filter((id): id is string => !!id))];
    const head = preview ? await createProjectExchangeRevision(snapshot, parents) : revisions.get(session.bundle.headRevisionId)!;
    revisions.set(head.revisionId, head);
    state = { ownerId, lineageId: snapshot.lineageId, rootProjectId: snapshot.rootProjectId, headRevisionId: head.revisionId,
      stateVersion: (preview?.expectedState?.stateVersion ?? 0) + 1, identities };
    if (!preview && options.independent) {
      const fork = { ...snapshot, lineageId: crypto.randomUUID() }, revision = await createProjectExchangeRevision(fork);
      revisions.clear(); revisions.set(revision.revisionId, revision); state = { ...state, lineageId: fork.lineageId, headRevisionId: revision.revisionId };
    }
  } else if (preview?.expectedState) {
    const head = await createProjectExchangeRevision(snapshot, [preview.expectedState.headRevisionId]); revisions.set(head.revisionId, head);
    state = { ...preview.expectedState, headRevisionId: head.revisionId, stateVersion: preview.expectedState.stateVersion + 1, identities };
  }
  const headers = new Map([...graph.ancestors, ...(session.bundle?.ancestors ?? [])].filter((item) => !revisions.has(item.revisionId) && item.lineageId === state?.lineageId).map((item) => [item.revisionId, item]));
  const history = await historyRows(session, records, options, identities);
  const recovery = preview ? await freezeRecovery(preview.local, preview.expectedRecords, targetDir, options) : null;
  await commitProjectImport({ operationId, expectedRecords: preview?.expectedRecords ?? [], records,
    expectedState: preview?.expectedState ?? null, state, revisions: [...revisions.values()], ancestors: [...headers.values()], history, label: '导入更新前',
    assertCurrent: () => { options.signal?.throwIfAborted(); assertCurrent?.(); }, signal: options.signal,
    recoveryRecords: recovery?.records, recoveryIdentities: recovery?.identities, recoveryAssets: recovery?.assets });
  files.registerProjectFolders(records); files.notifyProjectDiskChanged();
  const record = records[0];
  return { projectId: ownerId, projectName: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt, dataFolder: folder,
    settings: record.settings, series: record.series, episodes: records.slice(1).map((item) => toProjectSummaryRecord(item)!), warnings: [],
    assetCount: paths.size, missingAssetCount: 0, conversationCount: history.filter((row) => row.store === 'chatConversations').length,
    memoryCount: history.filter((row) => row.store === 'projectMemories').length };
}

/** 恢复也是一次新的本机修订；不倒退写入代际，也不撤销已经处理的远端父链。 */
export async function restoreProjectImportRecovery(ownerId: string, recoveryId: string, assertCurrent?: () => void): Promise<void> {
  const recovery = (await listProjectImportRecoveries(ownerId)).find((item) => item.id === recoveryId);
  if (!recovery) throw new Error('恢复点不存在');
  const expectedRecords = await readProjectImportScope(ownerId), expectedState = await loadProjectExchangeState(ownerId);
  // 恢复业务内容不回退本机目录定位；项目改名/迁移目录后，旧恢复点仍使用当前素材根。
  const restoredRecords = recovery.records.map((record) => ({ ...record, dataFolder: expectedRecords[0].dataFolder ?? ownerId }));
  const directory = await files.ensureProjectDataDir(ownerId); if (!directory) throw new Error('无法读取项目素材');
  const assets = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: directory });
  const actual = new Map(assets.map((asset) => [asset.path, asset]));
  if (!recovery.assets && (recovery.identities ?? recovery.state?.identities ?? []).some((item) => item.kind === 'file')) {
    throw new Error('旧恢复点缺少素材校验信息，请使用原始项目包恢复');
  }
  if (recovery.assets?.some((asset) => !configValuesEqual(asset, actual.get(asset.path)))) throw new Error('恢复点素材缺失或已被修改，未恢复项目');
  const graph = expectedState ? await loadProjectExchangeGraph(expectedState.lineageId) : { revisions: [], ancestors: [] };
  const current = await captureProjectSnapshot(expectedRecords, assets, expectedState,
    graph.revisions.find((item) => item.revisionId === expectedState?.headRevisionId)?.snapshot, directory);
  const beforeRestore = await freezeRecovery(current, expectedRecords, directory);
  let state: ProjectExchangeState | null = null;
  let revisions: ProjectExchangeRevision[] = [];
  let ancestors: ProjectExchangeBundle['ancestors'] = [];
  if (expectedState) {
    const mappings = recovery.identities ?? recovery.state?.identities ?? [];
    const paths = new Set(mappings.filter((item) => item.kind === 'file').map((item) => item.localId));
    const captured = await captureProjectSnapshot(restoredRecords, mappings.length ? assets.filter((asset) => paths.has(asset.path)) : assets, { ...expectedState,
      identities: [...new Map([...expectedState.identities, ...mappings].map((item) => [JSON.stringify([item.kind, item.scopeId, item.id]), item])).values()] }, undefined, directory);
    const head = await createProjectExchangeRevision(captured.snapshot, [expectedState.headRevisionId]);
    revisions = [...graph.revisions, head]; ancestors = graph.ancestors;
    state = { ...expectedState, stateVersion: expectedState.stateVersion + 1, identities: captured.identities, headRevisionId: head.revisionId };
  }
  assertCurrent?.();
  await commitProjectImport({ operationId: crypto.randomUUID(), expectedRecords, records: restoredRecords,
    expectedState, state, revisions, ancestors, history: [], label: '恢复操作前', assertCurrent,
    recoveryRecords: beforeRestore.records, recoveryIdentities: beforeRestore.identities, recoveryAssets: beforeRestore.assets });
  files.notifyProjectDiskChanged();
}
