/** 新作品更新与恢复：冻结来源、独立备份、文件发布和事务 journal。 */
import type { ProjectArchiveVideoEditorV4, ProjectExchangeSnapshotV2, ValidatedProjectArchiveV4 } from '../types/projectArchiveV4';
import type { ProjectModelTransferCapture, ProjectModelTransferExchange, ProjectModelTransferImportJournal } from '../types/projectModelTransfer';
import type { ProjectMergePlanV2, ProjectMergeSideV2 } from './projectMergeV2Service';
import { buildProjectMergePlanV2, resolveProjectMergeV2 } from './projectMergeV2Service';
import { captureNativeProjectArchive } from './nativeProjectArchiveService';
import { createBoundProjectModelArchiveExportPort } from './projectModelArchiveNativePort';
import { importProjectModelArchiveHistory, materializeProjectModelArchiveBusiness, prepareProjectModelArchiveCapture } from './projectModelArchiveService';
import { commitNativeArchiveHistory } from './nativeArchiveHistoryCommit';
import { projectArchivePayloadFromSnapshotV2, readProjectArchiveV4, readProjectArchiveV4Files, serializeProjectArchiveV4 } from './projectArchiveV4';
import { createProjectExchangeRevisionV2, findProjectExchangeBaseV2, parseProjectExchangeBundleV2 } from './projectExchangeV2Format';
import { deriveLegacyProjectionProofFromRevisions } from './projectExchangeV2Domain';
import { listNativeContentRecoveryPoints, replaceNativeContentWithRecovery } from './indexedDb/nativeProjectRepository';
import { NATIVE_EDITOR_CHOICE_KEY, nativeEditorChoiceRequired, resolveNativeEditorUpdate } from './videoEditorArchive';
import { createNativeUpdateBackup, inspectNativeRestorePoint, nativeUpdateInventory, stageNativeUpdateSource, verifyNativeRestoreAssets, verifyNativeUpdateBackup } from './nativeProjectUpdateMedia';
import { createBoundProjectModelArchiveImportPort } from './projectModelArchiveNativePort';
import { configValuesEqual } from './configPatch';
import { sha256BytesHex } from './mediaDataUrl';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { invoke } from '@tauri-apps/api/core';
import { preserveNativeUpdateFields } from './nativeProjectUpdatePreservation';
import { pinNativeHistoricalEditorMedia } from './nativeProjectHistoricalEditorMedia';
import { materializeNativeRawRecovery, referencedNativeRecoveryAssets } from './nativeProjectRawRecovery';
import { materializeNativeArchiveAssetMetadata } from './nativeArchiveAssetMetadata';
import { allocateNativeRecoveryAssets, applyNativeGlobalRecoveryFiles } from './nativeProjectAssetRecovery';
import { materializeNativeArchiveGlobalAssets, verifyNativeGlobalRecoverySources } from './nativeProjectArchiveService';
import { prepareNativeMissingAssetBackup, verifyNativeMissingAssetBackups } from './nativeMissingAssetBackup';
import { rebindRetiredNativeSnapshot } from './nativeProjectIdentityRebind';
import { prepareNativeProjectUpdate, readNativeProjectUpdate, advanceNativeProjectUpdate, commitNativeProjectUpdate, listNativeRetiredIdentityIds,
  type NativeProjectUpdateJournal } from './indexedDb/nativeProjectRepository';

export interface NativeProjectUpdatePreview {
  operationId: string;
  sourceDirectory?: string;
  editorChoiceRequired: boolean;
  source: ValidatedProjectArchiveV4;
  expected: ProjectModelTransferCapture;
  plan: ProjectMergePlanV2;
  localExchange: ProjectModelTransferExchange;
}

/** 历史剪辑只读保留；未导入过的历史附件不能静默遗漏。 */
function assertRetiredEditorKnown(incoming: ProjectArchiveVideoEditorV4 | undefined, local: ProjectArchiveVideoEditorV4 | undefined,
  incomingSnapshot: ProjectExchangeSnapshotV2, localSnapshot: ProjectExchangeSnapshotV2): void {
  const incomingFiles = readProjectArchiveV4Files(incomingSnapshot), localFiles = readProjectArchiveV4Files(localSnapshot);
  for (const record of incoming?.retiredRecords ?? []) {
    const matches = (local?.retiredRecords ?? []).filter((item) => item.id === record.id);
    if (matches.length !== 1 || !configValuesEqual(matches[0], record)) {
      throw new Error('项目包包含尚未纳入本机的历史剪辑工程，当前更新不能安全合并，请先导入为新项目');
    }
    for (const track of record.tracks) for (const clip of track.clips) if (clip.relativePath?.startsWith('exchange-file:')) {
      const id = clip.relativePath.slice('exchange-file:'.length);
      const source = incomingFiles.find((file) => file.id === id), existing = localFiles.find((file) => file.id === id);
      const sourceMedia = incomingSnapshot.media.find((media) => media.id === source?.mediaId);
      const localMedia = localSnapshot.media.find((media) => media.id === existing?.mediaId);
      if (!source || !existing || !sourceMedia || !localMedia || sourceMedia.sha256 !== localMedia.sha256
        || sourceMedia.bytes !== localMedia.bytes) throw new Error('历史剪辑素材与本机版本不一致，未更新项目');
    }
  }
}

/** 预览只接受有明确共同来源的包；已提交的协作头不因预览改变。 */
export async function previewNativeProjectUpdate(source: ValidatedProjectArchiveV4, projectId: string, sourceDirectory?: string): Promise<NativeProjectUpdatePreview> {
  const entries = await serializeProjectArchiveV4(source.payload, source.manifest, source.assets);
  source = await readProjectArchiveV4(Object.fromEntries(entries.map((entry) => [entry.path, entry.content])), source.assets);
  const { value: expected } = await captureNativeProjectArchive(projectId);
  const operationId = crypto.randomUUID();
  const portable = await materializeNativeArchiveGlobalAssets(expected, operationId, { files: [] });
  if (!expected.exchange || expected.exchange.lineageId !== source.snapshot.lineageId) throw new Error('项目缺少可证明的共同来源，请导入为新项目');
  const port = createBoundProjectModelArchiveExportPort(projectId, '');
  const assets = await port.inspectAssets(portable);
  const prepared = await prepareProjectModelArchiveCapture(portable, assets);
  assertRetiredEditorKnown(source.payload.videoEditor, prepared.payload.videoEditor, source.snapshot, prepared.snapshot);
  const latest = await captureNativeProjectArchive(projectId);
  if (latest.value.sourceToken !== expected.sourceToken) throw new Error('项目在预览期间发生变化，请重试');
  const graph = [...expected.exchange.bundle.revisions, ...source.payload.exchange.revisions];
  const base = await findProjectExchangeBaseV2(expected.exchange.localHead, source.payload.exchange.head, graph,
    [...expected.exchange.bundle.ancestors, ...source.payload.exchange.ancestors]);
  if (base.status !== 'found') throw new Error('缺少完整共同版本，请导入为新项目');
  const baseProof = base.revision.canonicalVersion === 1 ? await deriveLegacyProjectionProofFromRevisions(base.revision, graph) : undefined;
  const plan = await buildProjectMergePlanV2(base.revision.snapshot, prepared.snapshot, source.snapshot, { base: baseProof });
  return { source, sourceDirectory, expected, plan, localExchange: prepared.exchange, operationId,
    editorChoiceRequired: nativeEditorChoiceRequired(prepared.payload.videoEditor, source.payload.videoEditor) };
}

function mergeBundle(current: ProjectModelTransferExchange, source: ProjectModelTransferExchange['bundle'],
  head: Awaited<ReturnType<typeof createProjectExchangeRevisionV2>>) {
  const key = (row: { canonicalVersion: number; revisionId: string }) => `${row.canonicalVersion}:${row.revisionId}`;
  const revisions = [...new Map([...current.bundle.revisions, ...source.revisions, head].map((row) => [key(row), row])).values()];
  const ancestors = [...new Map([...current.bundle.ancestors, ...source.ancestors].map((row) => [key(row), row])).values()]
    .filter((row) => !revisions.some((revision) => key(revision) === key(row)));
  return parseProjectExchangeBundleV2({ ...source, packageId: crypto.randomUUID(), head: { canonicalVersion: 2, revisionId: head.revisionId },
    revisions, ancestors, files: head.snapshot.media.map((media) => ({ mediaId: media.id, archivePath: `assets/${media.id}.${media.extension}` })) });
}

const digest = (value: unknown) => sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(value)));
const updateAttempts = new WeakMap<NativeProjectUpdatePreview, { intent: string; input: Parameters<typeof prepareNativeProjectUpdate>[0] }>();

async function assertOriginalUpdate(operation: NativeProjectUpdateJournal): Promise<void> {
  await verifyNativeUpdateBackup(operation.projectId, operation.backup);
  const current = await captureNativeProjectArchive(operation.projectId);
  if (current.value.sourceToken !== operation.expected.sourceToken || current.changeRevision !== operation.expected.sessionRevision) {
    throw new Error('项目或历史在更新期间变化，原操作已保留');
  }
  const missing = operation.recoveryState?.missingFiles ?? [];
  if (missing.length) await verifyNativeMissingAssetBackups(operation.expected, await listNativeContentRecoveryPoints(operation.projectId), missing, operation.operationId);
  const currentOnly = operation.recoveryState?.currentFilesOnly ?? false;
  const port = missing.length || currentOnly ? createBoundProjectModelArchiveExportPort(operation.projectId, '', missing, currentOnly) : createBoundProjectModelArchiveExportPort(operation.projectId, '');
  const globals = operation.recoveryState?.globalFiles ?? [];
  await verifyNativeGlobalRecoverySources(operation.expected, globals);
  const currentAssets = nativeUpdateInventory(await port.inspectAssets(applyNativeGlobalRecoveryFiles(operation.expected, globals)));
  if (!configValuesEqual(currentAssets, operation.oldAssets)) throw new Error('项目素材在更新期间变化，原操作已保留');
  if (operation.mode === 'restore-content') {
    const point = (await listNativeContentRecoveryPoints(operation.projectId)).find((item) => item.operationId === operation.restoreRecoveryId);
    if (!point || !operation.restoreAssets) throw new Error('原恢复点已变化，未恢复项目');
    await verifyNativeRestoreAssets(operation.projectId, point, operation.expected, operation.restoreAssets);
  }
}

/** 按 journal 中冻结的身份、素材和备份续接；不会重新合并或分配 ID。 */
async function finishNativeUpdate(initial: NativeProjectUpdateJournal, assertCurrent?: () => void): Promise<NativeProjectUpdateJournal> {
  let operation = initial;
  if (operation.phase === 'finalized') return operation;
  if (operation.phase === 'aborted') throw new Error('原更新已撤销，备份和已发布素材仍保留');
  if (operation.phase === 'db_committed') {
    await commitNativeArchiveHistory(operation);
    return advanceNativeProjectUpdate(operation.operationId, operation.sequence, 'finalized');
  }
  if (!operation.sourceRef) throw new Error('原更新的隔离来源缺失，请保留操作材料');
  const port = createBoundProjectModelArchiveImportPort(operation.projectId, operation.sourceRef);
  await assertOriginalUpdate(operation); assertCurrent?.();
  if (operation.phase === 'prepared') {
    for (const root of operation.next.project.storageBindings) if (root.rootRef !== operation.next.project.storageRootRef) {
      try { await invoke('resolve_native_project_media_subroot', { projectId: operation.projectId, rootRef: root.rootRef, create: false }); }
      catch { await invoke('resolve_native_project_media_subroot', { projectId: operation.projectId, rootRef: root.rootRef, create: true }); }
    }
    await assertOriginalUpdate(operation); assertCurrent?.();
    operation = await advanceNativeProjectUpdate(operation.operationId, operation.sequence, 'media_publishing');
  }
  if (operation.phase === 'media_publishing') {
    const reference = await port.publishMedia(operation as ProjectModelTransferImportJournal);
    await port.verifyMediaPublication(operation as ProjectModelTransferImportJournal, reference);
    await assertOriginalUpdate(operation); assertCurrent?.();
    operation = await advanceNativeProjectUpdate(operation.operationId, operation.sequence, 'media_ready', reference);
  }
  if (operation.phase === 'media_ready') {
    await port.verifyMediaPublication(operation as ProjectModelTransferImportJournal, operation.mediaPublicationRef!);
    await assertOriginalUpdate(operation); assertCurrent?.();
    operation = await commitNativeProjectUpdate(operation.operationId, operation.sequence);
  }
  if (operation.phase === 'db_committed') {
    await commitNativeArchiveHistory(operation);
    operation = await advanceNativeProjectUpdate(operation.operationId, operation.sequence, 'finalized');
  }
  if (operation.phase !== 'finalized') throw new Error('原更新阶段无效，未确认提交');
  return operation;
}

/** 各事务的副作用可能已提交，失败时必须保留原操作而不是生成新的 ID。 */
export async function resumeNativeProjectUpdate(operationId: string, assertCurrent?: () => void): Promise<void> {
  const operation = await readNativeProjectUpdate(operationId);
  if (!operation) throw new Error('原更新操作不存在；请核对项目，不要直接重投');
  await finishNativeUpdate(operation, assertCurrent);
}

async function makeUpdateInput(preview: NativeProjectUpdatePreview, choices: Readonly<Record<string, ProjectMergeSideV2>>,
  mode: 'update-existing' | 'restore-content', assertCurrent?: () => void): Promise<Parameters<typeof prepareNativeProjectUpdate>[0]> {
  const expected = preview.expected, projectId = expected.aggregate.project.id;
  const current = await captureNativeProjectArchive(projectId);
  if (current.value.sourceToken !== expected.sourceToken || !expected.exchange) throw new Error('项目或历史已变化，请重新预览');
  const selected = mode === 'restore-content' ? preview.source.snapshot : resolveProjectMergeV2(preview.plan, choices);
  const retired = await listNativeRetiredIdentityIds(projectId);
  // 恢复被删除分集时分配全新逻辑身份，保留原身份的墓碑与历史回执。
  const rebound = rebindRetiredNativeSnapshot(selected, preview.localExchange, retired, preview.source.payload.videoEditor);
  const snapshot = pinNativeHistoricalEditorMedia({ selected: rebound.snapshot, local: preview.plan.local,
    localExchange: preview.localExchange, expected });
  const operationId = preview.operationId;
  const material = await materializeProjectModelArchiveBusiness(projectArchivePayloadFromSnapshotV2(snapshot), snapshot,
    expected, projectId, operationId, { exchange: preview.localExchange, snapshot: preview.plan.local },
    { allocateId: (kind) => `${kind === 'episode' ? 'e2' : kind === 'canvas' ? 'c2' : 'r2'}-${crypto.randomUUID()}`,
      folderName: expected.aggregate.project.dataFolder });
  if (mode === 'update-existing') preserveNativeUpdateFields(expected, material.aggregate, preview.plan.local, snapshot, preview.localExchange);
  const choice = mode === 'restore-content' ? 'incoming' : choices[NATIVE_EDITOR_CHOICE_KEY];
  const editorRecords = resolveNativeEditorUpdate({ required: mode === 'restore-content' || preview.editorChoiceRequired,
    choice, currentRecords: expected.editorRecords ?? [], incoming: rebound.editor,
    identityMappings: material.identities, fileBindings: material.fileBindings,
    originalCanvasIds: expected.aggregate.canvases.map((item) => item.id),
    targetCanvasIds: material.aggregate.canvases.map((item) => item.id) });
  const parents = [preview.localExchange.localHead, preview.source.payload.exchange.head];
  const head = await createProjectExchangeRevisionV2(snapshot, [...new Map(parents.map((item) => [`${item.canonicalVersion}:${item.revisionId}`, item])).values()]);
  const bundle = await mergeBundle(preview.localExchange, preview.source.payload.exchange, head);
  const exchange: ProjectModelTransferExchange = { lineageId: snapshot.lineageId, localHead: bundle.head, bundle,
    identities: material.identities, fileBindings: material.fileBindings, stateVersion: expected.exchange.stateVersion + 1,
    published: expected.exchange.published };
  if (!preview.sourceDirectory) throw new Error('项目包隔离来源不可用，请重新预览');
  assertCurrent?.();
  const source = await stageNativeUpdateSource(preview.source, preview.sourceDirectory, projectId, operationId);
  assertCurrent?.();
  const { backup, oldAssets, assetSnapshots, recoveryState } = await createNativeUpdateBackup(expected, operationId);
  const assetRecords = materializeNativeArchiveAssetMetadata({ aggregate: material.aggregate, editors: editorRecords,
    identities: material.identities, bindings: material.fileBindings, selected: snapshot, source: preview.source.snapshot,
    metadata: preview.source.payload.assetMetadata, local: assetSnapshots });
  await verifyNativeUpdateBackup(projectId, backup); assertCurrent?.();
  const latest = await captureNativeProjectArchive(projectId);
  if (latest.value.sourceToken !== expected.sourceToken) throw new Error('备份后项目或历史发生变化，未更新');
  const packageDigest = await digest([preview.source.manifest, preview.source.payload.exchange]);
  const intentDigest = await digest([packageDigest, expected.sourceToken, mode, choices]);
  // 内容恢复保留今日历史；更新仅追加来源可证的输出快照，不恢复任务或租约。
  const history = mode === 'restore-content' ? [] : (await importProjectModelArchiveHistory(preview.source, projectId,
    snapshot.lineageId, expected, { appendChat: false, appendMemories: false }, { identities: material.identities,
      episodes: material.aggregate.episodes, defaultCanvasId: material.aggregate.project.kind === 'standalone' ? material.aggregate.canvases[0]?.id : undefined,
      fileBindings: material.fileBindings })).filter((row) => row.kind === 'output');
  return { operationId, mode, packageDigest, intentDigest, sourceLineageId: snapshot.lineageId, targetProjectId: projectId,
    expected, next: { ...material.aggregate, bindings: [], previews: [] }, exchange, idMap: material.identities,
    history, media: material.media, editorRecords, backup, oldAssets, oldAssetSnapshots: assetSnapshots, recoveryState, assetRecords, ...source };
}

/** 预览选择、独立备份、隔离来源及原生发布通过 journal 构成同一可恢复操作。 */
export async function applyNativeProjectUpdate(preview: NativeProjectUpdatePreview, choices: Readonly<Record<string, ProjectMergeSideV2>>, assertCurrent?: () => void): Promise<void> {
  const intent = JSON.stringify(Object.entries(choices).sort(([a], [b]) => a.localeCompare(b)));
  const existing = await readNativeProjectUpdate(preview.operationId);
  if (existing) {
    const expectedIntent = await digest([existing.packageDigest, preview.expected.sourceToken, 'update-existing', choices]);
    if (existing.intentDigest !== expectedIntent) throw new Error('原更新操作已冻结其他选择，请先核对');
    await finishNativeUpdate(existing, assertCurrent); return;
  }
  let attempt = updateAttempts.get(preview);
  if (attempt && attempt.intent !== intent) throw new Error('原更新操作已冻结选择，请先核对');
  if (!attempt) {
    const input = await makeUpdateInput(preview, choices, 'update-existing', assertCurrent);
    attempt = { intent, input }; updateAttempts.set(preview, attempt);
  }
  try {
    assertCurrent?.();
    const operation = await prepareNativeProjectUpdate(attempt.input);
    await finishNativeUpdate(operation, assertCurrent);
  } catch (error) {
    let operation: NativeProjectUpdateJournal | null;
    try { operation = await readNativeProjectUpdate(preview.operationId); }
    catch (cause) { throw new Error(`更新结果未知，原操作 ${preview.operationId} 已保留，请先核对`, { cause }); }
    if (operation) throw new Error(`更新未完成，原操作 ${preview.operationId} 已保留；${error instanceof Error ? error.message : '请核对后续接'}`, { cause: error });
    throw error;
  }
}

/** 恢复读取原生备份，重新发布原素材并以新 journal 保存恢复前内容。 */
export async function restoreNativeContentRecovery(projectId: string, recoveryId: string, operationId: string, assertCurrent?: () => void): Promise<void> {
  const existing = await readNativeProjectUpdate(operationId);
  if (existing) { if (existing.mode !== 'restore-content' || existing.projectId !== projectId || existing.restoreRecoveryId !== recoveryId) throw new Error('恢复操作身份冲突');
    await finishNativeUpdate(existing, assertCurrent); return; }
  const point = (await listNativeContentRecoveryPoints(projectId)).find((item) => item.operationId === recoveryId);
  const { value: expected } = await captureNativeProjectArchive(projectId);
  if (!point?.exchange || !expected.exchange || point.exchange.lineageId !== expected.exchange.lineageId) throw new Error('恢复点来源不可用');
  if (!point.backup) {
    if (expected.editorRecords?.length || (await createBoundProjectModelArchiveExportPort(projectId, '').inspectAssets(expected)).length) {
      throw new Error('旧恢复点没有独立素材备份，不能安全恢复');
    }
    const recovered = await prepareProjectModelArchiveCapture({ ...expected, aggregate: point.aggregate, exchange: point.exchange,
      includesHistory: false, history: [], historyBindings: [] }, []);
    const head = await createProjectExchangeRevisionV2(recovered.snapshot, [expected.exchange.localHead]);
    const bundle = await mergeBundle(expected.exchange, recovered.exchange.bundle, head);
    const exchange: ProjectModelTransferExchange = { ...expected.exchange, localHead: bundle.head, bundle,
      stateVersion: expected.exchange.stateVersion + 1 };
    assertCurrent?.();
    await replaceNativeContentWithRecovery({ operationId, expected, next: { ...point.aggregate, bindings: [], previews: [] }, exchange });
    return;
  }
  const retired = await listNativeRetiredIdentityIds(projectId);
  const { source, directory, prepared: previous, reusableAssets: existingAssets } = await inspectNativeRestorePoint(projectId, point, expected);
  // 老恢复点未冻结的标签/图片信息不能从今日索引补造为历史事实；原文件可复用时保留原ID。
  const assetSnapshots = point.assetSnapshots ?? [];
  // 带索引的恢复素材始终发布到新目录，旧路径及索引留给原历史，不与新身份争用同一路径。
  const indexedPaths = new Set(assetSnapshots.map((asset) => JSON.stringify([asset.rootRef, asset.path])));
  const reusableAssets = existingAssets.filter((asset) => !indexedPaths.has(JSON.stringify([asset.rootRef, asset.path])));
  const missingFiles = await prepareNativeMissingAssetBackup(expected, point, source, directory, operationId);
  await verifyNativeMissingAssetBackups(expected, [point], missingFiles, operationId);
  const portable = await materializeNativeArchiveGlobalAssets(expected, operationId, { files: [] });
  const localRead = createBoundProjectModelArchiveExportPort(projectId, '', missingFiles, true);
  const localAssets = await localRead.inspectAssets(portable);
  const local = await prepareProjectModelArchiveCapture(portable, localAssets);
  assertRetiredEditorKnown(source.payload.videoEditor, local.payload.videoEditor, source.snapshot, local.snapshot);
  const identities = [...local.exchange.identities];
  for (const identity of previous.exchange.identities) {
    const sourceMatch = identities.find((item) => item.kind === identity.kind && item.sourceId === identity.sourceId);
    const localMatch = identities.find((item) => item.kind === identity.kind && item.localId === identity.localId);
    if (sourceMatch && !configValuesEqual(sourceMatch, identity) || localMatch && !configValuesEqual(localMatch, identity)) {
      throw new Error('恢复点的协作身份与当前作品冲突，未恢复');
    }
    if (!sourceMatch) identities.push(identity);
  }
  // 协作身份必须全新，旧 sourceId 和本机墓碑继续保留供审计。
  const rebound = rebindRetiredNativeSnapshot(source.snapshot, local.exchange, retired, source.payload.videoEditor);
  const snapshot = pinNativeHistoricalEditorMedia({ selected: rebound.snapshot, local: local.snapshot,
    localExchange: local.exchange, expected });
  const sourceFiles = readProjectArchiveV4Files(source.snapshot);
  const reusableKeys = new Set(reusableAssets.map((item) => JSON.stringify([item.rootRef, item.path])));
  const missingIds = new Set<string>();
  for (const asset of point.oldAssets ?? []) {
    if (reusableKeys.has(JSON.stringify([asset.rootRef, asset.path]))) continue;
    const roots = previous.exchange.identities.filter((item) => item.kind === 'storage-root' && item.localId === asset.rootRef);
    const matches = previous.exchange.fileBindings.filter((item) => roots.length === 1 && item.rootRef === roots[0].sourceId && item.localRelativePath === asset.path);
    if (matches.length !== 1) throw new Error('缺失恢复素材没有唯一原文件身份');
    missingIds.add(matches[0].id);
  }
  // 未复用原文件不得继承旧路径；发布器将其从原备份写入本操作的新目录。
  const fileBindings = previous.exchange.fileBindings.filter((item) => !missingIds.has(item.id));
  for (const binding of local.exchange.fileBindings) if (!missingIds.has(binding.id) && !fileBindings.some((item) => item.id === binding.id)) fileBindings.push(binding);
  const available = { ...previous.exchange, identities, fileBindings };
  const material = await materializeProjectModelArchiveBusiness(projectArchivePayloadFromSnapshotV2(snapshot), snapshot,
    expected, projectId, operationId, { exchange: available, snapshot },
    { allocateId: (kind) => `${kind === 'episode' ? 'e2' : kind === 'canvas' ? 'c2' : 'r2'}-${crypto.randomUUID()}`,
      folderName: expected.aggregate.project.dataFolder });
  const mapIdentity = (kind: 'episode' | 'canvas', from: string) => {
    const previousMappings = previous.exchange.identities.filter((item) => item.kind === kind && item.localId === from);
    if (previousMappings.length !== 1) throw new Error('恢复点缺少原身份映射');
    const oldSource = previousMappings[0].sourceId;
    const changes = rebound.rebindings.filter((item) => item.kind === kind && item.from === oldSource);
    if (changes.length > 1) throw new Error('恢复身份映射重复');
    const targetSource = changes[0]?.to ?? oldSource;
    const targetMappings = material.identities.filter((item) => item.kind === kind && item.sourceId === targetSource);
    if (targetMappings.length !== 1) throw new Error('恢复目标身份缺失');
    return { from, to: targetMappings[0].localId };
  };
  // 仓储以恢复点的根为先，再追加当前新增根，保持原先身份与顺序。
  const roots = structuredClone(point.aggregate.project.storageBindings);
  for (const binding of expected.aggregate.project.storageBindings) {
    const existing = roots.find((item) => item.rootRef === binding.rootRef);
    if (existing && !configValuesEqual(existing, binding)) throw new Error('恢复素材根绑定已变化');
    if (!existing) roots.push(structuredClone(binding));
  }
  if (material.aggregate.project.storageBindings.some((item) => !roots.some((root) => configValuesEqual(root, item)))) {
    throw new Error('恢复素材根不属于原恢复点或当前作品');
  }
  material.aggregate.project.storageBindings = roots;
  const episodeIds = point.aggregate.episodes.map((item) => mapIdentity('episode', item.id));
  const canvasIds = point.aggregate.canvases.map((item) => mapIdentity('canvas', item.id));
  // 同一文件 ID、根与摘要必须一致；缺失或变化的文件只能从备份发布到新路径。
  const files = (point.oldAssets ?? []).map((asset) => {
    const roots = previous.exchange.identities.filter((item) => item.kind === 'storage-root' && item.localId === asset.rootRef);
    if (roots.length !== 1) throw new Error('恢复素材根身份无效');
    const candidates = previous.exchange.fileBindings.filter((item) => item.rootRef === roots[0].sourceId && item.localRelativePath === asset.path);
    if (candidates.length !== 1) throw new Error('恢复素材缺少唯一原文件绑定');
    const old = candidates[0];
    const sourceFile = sourceFiles.find((item) => item.id === old.id && item.rootRef === old.rootRef && item.relativePath === old.relativePath);
    const descriptor = source.snapshot.media.find((item) => item.id === sourceFile?.mediaId);
    const targets = material.fileBindings.filter((item) => item.id === old.id && item.rootRef === old.rootRef
      && item.relativePath === old.relativePath);
    if (!descriptor || descriptor.bytes !== asset.bytes || descriptor.sha256 !== asset.sha256 || targets.length !== 1) {
      throw new Error('恢复素材的原身份、路径或摘要不一致，未恢复');
    }
    const targetPath = targets[0].localRelativePath;
    const reusable = reusableKeys.has(JSON.stringify([asset.rootRef, asset.path]));
    const publications = material.media.filter((item) => item.rootRef === asset.rootRef && item.relativePath === targetPath
      && item.bytes === asset.bytes && item.sha256 === asset.sha256);
    if (reusable ? targetPath !== asset.path || publications.length !== 0 : targetPath === asset.path || publications.length !== 1) {
      throw new Error('恢复素材的复用或发布状态不一致，未恢复');
    }
    return { rootRef: asset.rootRef, from: asset.path, to: targetPath };
  });
  const recoveredAssets = allocateNativeRecoveryAssets(projectId, point.aggregate.project.storageRootRef, assetSnapshots, files, canvasIds,
    point.aggregate.bindings.filter((binding) => binding.retired && binding.canvasId).map((binding) => binding.canvasId!));
  const rawRecovery = { recoveryId, episodeIds, canvasIds, files, rebindings: rebound.rebindings, assets: recoveredAssets.mappings, assetSnapshots };
  const raw = materializeNativeRawRecovery({ original: point.aggregate, target: material.aggregate,
    episodeIds, canvasIds, files, editors: point.editorRecords ?? [],
    assets: referencedNativeRecoveryAssets(point.aggregate, point.editorRecords ?? [], recoveredAssets.mappings), knownAssets: recoveredAssets.mappings });
  const parents = [local.exchange.localHead, source.payload.exchange.head];
  const head = await createProjectExchangeRevisionV2(snapshot,
    [...new Map(parents.map((item) => [`${item.canonicalVersion}:${item.revisionId}`, item])).values()]);
  const bundle = await mergeBundle(local.exchange, source.payload.exchange, head);
  const exchange: ProjectModelTransferExchange = { lineageId: source.snapshot.lineageId, localHead: bundle.head, bundle,
    identities: material.identities, fileBindings: material.fileBindings, stateVersion: expected.exchange.stateVersion + 1,
    published: expected.exchange.published };
  const next = raw.aggregate;
  assertCurrent?.();
  const staged = await stageNativeUpdateSource(source, directory, projectId, operationId);
  const { backup, oldAssets, assetSnapshots: oldAssetSnapshots, recoveryState } = await createNativeUpdateBackup(expected, operationId, missingFiles, true);
  await verifyNativeRestoreAssets(projectId, point, expected, reusableAssets); assertCurrent?.();
  const packageDigest = await digest([source.manifest, source.payload.exchange]);
  const intentDigest = await digest([packageDigest, expected.sourceToken, 'restore-content', recoveryId]);
  const input: Parameters<typeof prepareNativeProjectUpdate>[0] = { operationId, mode: 'restore-content', packageDigest, intentDigest,
    sourceLineageId: source.snapshot.lineageId, targetProjectId: projectId, expected, next, exchange,
    idMap: material.identities, history: [], media: material.media, editorRecords: raw.editors, backup, oldAssets,
    restoreRecoveryId: recoveryId, restoreAssets: structuredClone(reusableAssets), rawRecovery, oldAssetSnapshots,
    assetRecords: recoveredAssets.records, recoveryState, ...staged };
  try { await finishNativeUpdate(await prepareNativeProjectUpdate(input), assertCurrent); }
  catch (error) {
    let operation: NativeProjectUpdateJournal | null;
    try { operation = await readNativeProjectUpdate(operationId); }
    catch (cause) { throw new Error(`恢复结果未知，原操作 ${operationId} 已保留，请先核对`, { cause }); }
    if (operation) throw new Error(`恢复未完成，原操作 ${operationId} 已保留；${error instanceof Error ? error.message : '请核对后续接'}`, { cause: error });
    throw error;
  }
}
