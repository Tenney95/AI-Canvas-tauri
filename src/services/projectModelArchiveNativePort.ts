/** P5 fixture 的真实文件适配；所有源根由冷维护 profile 与相对绑定推出，输出仍需原生路径授权。 */
import { invoke } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import * as files from './fileService';
import { projectModelArchiveMediaPrefix, projectModelArchiveStorageContext, readProjectModelArchive, type ProjectModelArchivePort, type ProjectModelArchiveAsset } from './projectModelArchiveService';
import type { ProjectModelFixtureBusinessSession } from '../types/projectModelBusiness';
import type { ProjectModelTransferCapture, ProjectModelTransferImportJournal } from '../types/projectModelTransfer';
import { createProjectModelPreRestoreBackupService } from './projectModelPreRestoreBackup';
import type { ArchiveAssetDigest } from './projectExchangeDomain';
import { captureSourceLocation, missingProjectAssetMessage, projectArchiveDisplayLabel, safeExchangePath } from './projectExchangeDomain';
import { readProjectArchiveV4Files } from './projectArchiveV4';
import type { ProjectModelTransferExchange } from '../types/projectModelTransfer';
import { createProjectArchiveFixturePreviewDirectory } from './fs/projectArchiveFixtureFiles';
import { sha256BytesHex } from './mediaDataUrl';
import { assertNativeFileMissing, type NativeMissingAssetProof } from './nativeMissingAssetBackup';

interface SourceRoot { rootRef: string; directory: string }
type NativeAsset = ArchiveAssetDigest & { sourceRootRef?: string; sourceRelativePath?: string; destinationPath?: string };
const sameAsset = (a: ArchiveAssetDigest, b: ArchiveAssetDigest) => a.bytes === b.bytes && a.sha256 === b.sha256;

/** 独立 fixture 的真实解包入口；正式 Store/UI 不接线，不删除可能被journal引用的来源。 */
export async function prepareProjectModelArchiveFixtureImport(database: IDBDatabase, session: ProjectModelFixtureBusinessSession,
  options: { archivePath: string; operationId?: string; outputPath?: string }) {
  const staging = await createProjectArchiveFixturePreviewDirectory(database.name, options.operationId ?? crypto.randomUUID());
  const unpacked = await invoke<{ texts: Record<string, string>; assets: ArchiveAssetDigest[] }>('unpack_project_archive', {
    archivePath: options.archivePath, assetsDir: staging.directory,
  });
  const source = await readProjectModelArchive(unpacked.texts, unpacked.assets);
  const port = createNativeProjectModelArchivePort(database, session, { incomingFolder: staging.sourceRef, outputPath: options.outputPath });
  await port.captureImportSource!(source);
  return { sourceRef: staging.sourceRef, source, port };
}
function headFiles(exchange: ProjectModelTransferExchange | null) {
  if (!exchange) throw new Error('本机传输状态缺少完整 canonical2 head');
  const head = exchange.bundle.revisions.find((item) => item.canonicalVersion === exchange.localHead.canonicalVersion
    && item.revisionId === exchange.localHead.revisionId);
  if (head?.canonicalVersion !== 2) throw new Error('本机传输状态缺少完整 canonical2 head');
  return { exchange, snapshot: head.snapshot, files: readProjectArchiveV4Files(head.snapshot) };
}
const pathFields = new Set(['relativePath', 'imageRelativePath', 'directorCaptureRelativePaths']);
interface StoragePathOrigin { location: string; fieldPath: string }
const storagePathKey = (rootRef: string, path: string) => JSON.stringify([rootRef, path]);
/** 只读领域文件字段；新生成且尚未登记进 head 的 imports 文件也属于当前作品。 */
export function currentStoragePaths(capture: ProjectModelTransferCapture, directories: Map<string, string>,
  origins?: Map<string, StoragePathOrigin>): Map<string, Set<string>> {
  const paths = new Map([...directories.keys()].map((root) => [root, new Set<string>()]));
  const projectLocation = `项目「${projectArchiveDisplayLabel(capture.aggregate.project.name)}」`;
  const canvases = new Map(capture.aggregate.canvases.map((canvas) => [canvas.id, canvas]));
  const episodes = new Map(capture.aggregate.episodes.flatMap((episode) => [[episode.id, episode], [episode.canvasId, episode]] as const));
  const ownerLocation = (id: string) => {
    const canvas = canvases.get(id);
    const episode = episodes.get(id) ?? (canvas?.episodeId ? episodes.get(canvas.episodeId) : undefined);
    return `${projectLocation}${episode ? ` → 分集「${projectArchiveDisplayLabel(episode.name)}」` : ''}`
      + (canvas ? ` → 画布（ID：${projectArchiveDisplayLabel(canvas.id, '格式无效')}）` : '');
  };
  const add = (rootRef: string, path: string, location: string, fieldPath: string) => {
    paths.get(rootRef)?.add(path);
    const key = storagePathKey(rootRef, path);
    if (!origins?.has(key)) origins?.set(key, { location, fieldPath });
  };
  const sourceKinds: Record<string, string> = { nodes: '节点', shotlistRows: '镜头', characters: '角色', scenes: '场景', props: '道具',
    referenceImages: '参考图', voiceClips: '音色', actions: '动作', media: '动作素材' };
  const walk = (value: unknown, rootRef: string, field = '', location = projectLocation, fieldPath = ''): void => {
    if (typeof value === 'string' && value) {
      let relative: string | undefined;
      if (pathFields.has(field)) relative = safeExchangePath(value);
      else if (['filePath', 'imageFilePath', 'directorCaptureFilePaths'].includes(field)) {
        const directory = directories.get(rootRef)?.replace(/\\/g, '/').replace(/\/$/, ''), absolute = value.replace(/\\/g, '/');
        if (directory && (/^[a-z]:\//i.test(directory) ? absolute.toLowerCase().startsWith(directory.toLowerCase() + '/') : absolute.startsWith(directory + '/'))) {
          relative = safeExchangePath(absolute.slice(directory.length + 1));
        }
      }
      if (relative) add(rootRef, relative, location, fieldPath);
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, rootRef, field, location, `${fieldPath}[${index}]`)); return; }
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if (origins && sourceKinds[field] && typeof row.id === 'string') {
      location = captureSourceLocation(location, sourceKinds[field], row);
      if (field === 'nodes') fieldPath = '';
    }
    const bound = typeof row.storageRootRef === 'string' ? row.storageRootRef : rootRef;
    if (!directories.has(bound)) throw new Error('当前素材引用的根不属于项目');
    for (const [key, item] of Object.entries(row)) walk(item, bound, key, location, fieldPath ? `${fieldPath}.${key}` : key);
  };
  const primary = projectModelArchiveStorageContext(capture).primary;
  walk(capture.aggregate.content, primary); walk(capture.aggregate.project.defaultSettings, primary, '', projectLocation, 'defaultSettings');
  for (const content of capture.aggregate.episodeContents) walk(content, content.storageRootRef, '', ownerLocation(content.episodeId));
  for (const episode of capture.aggregate.episodes) walk(episode.settingsPolicy,
    capture.aggregate.episodeContents.find((item) => item.episodeId === episode.id)?.storageRootRef ?? primary,
    '', ownerLocation(episode.id), 'settingsPolicy');
  for (const canvas of capture.aggregate.canvases) walk(canvas, canvas.storageRootRef, '', ownerLocation(canvas.id));
  for (const editor of capture.editorRecords ?? []) walk(editor, primary, '', captureSourceLocation(ownerLocation(editor.projectId), '剪辑工程', editor as unknown as Record<string, unknown>));
  for (const editor of capture.retiredEditorRecords ?? []) walk(editor, primary, '', captureSourceLocation(ownerLocation(editor.projectId), '已退役剪辑工程', editor as unknown as Record<string, unknown>));
  for (const row of capture.history) if (row.kind === 'output') walk(row.value, primary, '', captureSourceLocation(ownerLocation(row.value.projectId), '输出历史', row.value));
  for (const [index, result] of (capture.nativeMediaResults ?? []).entries()) add(capture.aggregate.project.storageRootRef,
    safeExchangePath(result.relativePath), `${ownerLocation(result.canvasId)} → 已保留媒体产物（操作：${projectArchiveDisplayLabel(result.operationId, '格式无效')}）`, `nativeMediaResults[${index}].relativePath`);
  for (const [index, result] of (capture.nativeEditorMediaArtifacts ?? []).entries()) add(capture.aggregate.project.storageRootRef,
    safeExchangePath(result.path), `${ownerLocation(result.canvasId)} → 已保留剪辑产物（操作：${projectArchiveDisplayLabel(result.operationId, '格式无效')}）`, `nativeEditorMediaArtifacts[${index}].path`);
  for (const asset of capture.assetMetadata ?? []) {
    if (!paths.has(asset.rootRef)) throw new Error('素材元数据根不属于项目');
    const location = captureSourceLocation(ownerLocation(asset.ownerId), '素材', { id: asset.assetId, name: safeExchangePath(asset.path).split('/').at(-1) });
    add(asset.rootRef, safeExchangePath(asset.path), location, 'assetMetadata.path');
    for (const [imageIndex, image] of (asset.images ?? []).entries()) for (const [referenceIndex, reference] of image.references.entries()) {
      add(asset.rootRef, safeExchangePath(reference.relativePath), `${location} → 图片信息[${imageIndex}]`,
        `assetMetadata.images[${imageIndex}].references[${referenceIndex}].relativePath`);
    }
  }
  return paths;
}

export function createNativeProjectModelArchivePort(database: IDBDatabase, session: ProjectModelFixtureBusinessSession,
  options: { incomingFolder?: string; outputPath?: string } = {}): ProjectModelArchivePort {
  const directory = (relative: string, create = false) => files.projectArchiveFixtureDirectory(database.name, relative, create);
  return createArchiveFilePort(directory, options, createProjectModelPreRestoreBackupService(database, session));
}

/**
 * 新库的只读导出文件端口。所有项目根均由原生已绑定身份解析，不能把 Renderer 拼出的路径作为授权。
 * 这里只提供文件步骤；调用者仍需事务捕获、变更版本 CAS、journal 和原生发布回执。
 */
export function createBoundProjectModelArchiveExportPort(projectId: string, outputPath: string, missingFiles?: readonly NativeMissingAssetProof[], currentFilesOnly = false):
  Pick<ProjectModelArchivePort, 'inspectAssets' | 'pack' | 'verifyExportPublication' | 'recoverExportPublication'> {
  if (!/^p2-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(projectId)) {
    throw new Error('新项目身份无效');
  }
  const rootFolder = `project-${projectId}`;
  const directory = async (relative: string): Promise<string> => {
    if (relative === rootFolder) return invoke<string>('resolve_native_project_media_root', { projectId });
    const prefix = `${rootFolder}/roots/`;
    const rootRef = relative.startsWith(prefix) ? relative.slice(prefix.length) : '';
    if (!/^r2-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(rootRef)) {
      throw new Error('素材根不属于该新项目');
    }
    return invoke<string>('resolve_native_project_media_subroot', { projectId, rootRef, create: false });
  };
  const port = createArchiveFilePort(directory, { outputPath, nativeRootFolder: rootFolder, nativeProjectId: projectId,
    ...(missingFiles?.length ? { missingFiles: structuredClone(missingFiles) as NativeMissingAssetProof[] } : {}), currentFilesOnly });
  return { inspectAssets: port.inspectAssets, pack: port.pack, verifyExportPublication: port.verifyExportPublication,
    recoverExportPublication: port.recoverExportPublication };
}

/** 新副本只发布到原生绑定的项目根和该操作的隔离来源目录。 */
export function createBoundProjectModelArchiveImportPort(projectId: string, incomingFolder: string):
  Pick<ProjectModelArchivePort, 'captureImportSource' | 'publishMedia' | 'verifyMediaPublication'> {
  if (!/^p2-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(projectId)
    || !/^(?:native-import-[a-f0-9-]{36}|imports\/native-update-[a-f0-9-]{36})$/.test(incomingFolder)) throw new Error('新项目导入身份无效');
  const rootFolder = `project-${projectId}`;
  const directory = async (relative: string, create = false): Promise<string> => {
    if (relative === incomingFolder) {
      const base = await files.getBaseDir(); if (!base) throw new Error('导入来源目录不可用');
      return files.joinPath(base, incomingFolder);
    }
    if (relative !== safeExchangePath(relative)) throw new Error('素材目录无效');
    const parts = relative.split('/');
    if (parts[0] !== rootFolder) throw new Error('素材目录不属于该新项目');
    let root = await invoke<string>('resolve_native_project_media_root', { projectId });
    let index = 1;
    if (parts[1] === 'roots') {
      const rootRef = parts[2];
      if (!/^r2-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(rootRef)) throw new Error('素材根无效');
      try { root = await invoke<string>('resolve_native_project_media_subroot', { projectId, rootRef, create: false }); }
      catch (error) {
        if (!create) throw error;
        root = await invoke<string>('resolve_native_project_media_subroot', { projectId, rootRef, create: true });
      }
      index = 3;
    }
    if (parts.length === index) return root;
    if (parts.length !== index + 2 || parts[index] !== 'imports' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(parts[index + 1])) {
      throw new Error('素材发布目录无效');
    }
    return files.joinPath(root, 'imports', parts[index + 1]);
  };
  const port = createArchiveFilePort(directory, { incomingFolder, nativeRootFolder: rootFolder, nativeProjectId: projectId });
  return { captureImportSource: port.captureImportSource, publishMedia: port.publishMedia, verifyMediaPublication: port.verifyMediaPublication };
}

function createArchiveFilePort(directory: (relative: string, create?: boolean) => Promise<string>,
  options: { incomingFolder?: string; outputPath?: string; nativeRootFolder?: string; nativeProjectId?: string; missingFiles?: readonly NativeMissingAssetProof[]; currentFilesOnly?: boolean },
  backup?: ReturnType<typeof createProjectModelPreRestoreBackupService>): ProjectModelArchivePort {
  function assertBoundCapture(capture: ProjectModelTransferCapture): void {
    if (!options.nativeProjectId) return;
    const project = capture.aggregate.project;
    if (project.id !== options.nativeProjectId || project.dataFolder !== options.nativeRootFolder
      || !project.storageBindings.some((root) => root.rootRef === project.storageRootRef)
      || project.storageBindings.some((root) => root.folderName !== (root.rootRef === project.storageRootRef
        ? options.nativeRootFolder : `${options.nativeRootFolder}/roots/${root.rootRef}`))) {
      throw new Error('素材根不属于该新项目');
    }
  }
  const inventoryDigest = (assets: ProjectModelArchiveAsset[]) => {
    const rows = assets.map(({ rootRef, path, bytes, sha256 }) => ({ rootRef, path, bytes, sha256 })).sort((a, b) => {
      const left = JSON.stringify([a.rootRef, a.path]), right = JSON.stringify([b.rootRef, b.path]); return left < right ? -1 : left > right ? 1 : 0;
    });
    return sha256BytesHex(new TextEncoder().encode(JSON.stringify(rows)));
  };
  async function currentMediaDigest(capture: ProjectModelTransferCapture, journal?: ProjectModelTransferImportJournal) {
    let assets = await port.inspectAssets(capture);
    if (journal) assets = assets.filter((asset) => {
      const owner = capture.aggregate.project.storageBindings.find((item) => item.rootRef === asset.rootRef)!;
      return !journal.next.project.storageBindings.some((item) => !capture.aggregate.project.storageBindings.some((old) => old.rootRef === item.rootRef)
        && item.folderName.startsWith(owner.folderName + '/') && asset.path.startsWith(item.folderName.slice(owner.folderName.length + 1) + '/'));
    });
    const directories = new Map<string, string>();
    for (const root of projectModelArchiveStorageContext(capture).roots) directories.set(root.rootRef, await directory(root.folderName));
    for (const [rootRef, paths] of currentStoragePaths(capture, directories)) for (const path of paths) {
      if (!assets.some((asset) => asset.rootRef === rootRef && (asset.path === path || asset.aliases?.includes(path)))) throw new Error('恢复前的旧素材引用缺失，无法证明内容可恢复');
    }
    return inventoryDigest(assets);
  }
  async function verifyMedia(operation: ProjectModelTransferImportJournal, reference: string): Promise<void> {
    if (reference !== `media_v1_${operation.operationId}`) throw new Error('媒体发布回执不属于原导入操作');
    const head = headFiles(operation.exchange);
    for (const root of operation.next.project.storageBindings) {
      const logicalRoot = operation.idMap.find((item) => item.kind === 'storage-root' && item.localId === root.rootRef)?.sourceId;
      const required = head.files.filter((file) => file.rootRef === logicalRoot).map((file) => {
        const binding = head.exchange.fileBindings.find((item) => item.id === file.id && item.rootRef === file.rootRef && item.relativePath === file.relativePath);
        const descriptor = head.snapshot.media.find((item) => item.id === file.mediaId);
        if (!binding || !descriptor) throw new Error('已发布媒体缺少冻结的文件绑定');
        return { path: safeExchangePath(binding.localRelativePath), bytes: descriptor.bytes, sha256: descriptor.sha256 };
      });
      if (!required.length) continue;
      const actual = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', {
        assetsDir: await directory(root.folderName), selectedPaths: required.map((item) => item.path),
      });
      if (actual.length !== required.length || required.some((asset) => {
        const found = actual.find((item) => item.path === asset.path); return !found || !sameAsset(found, asset);
      })) throw new Error('已发布媒体不完整或摘要变化，未提交项目');
    }
  }
  const port: ProjectModelArchivePort = {
    async captureImportSource(source) {
      const sourceFiles = source.files.map((file) => {
        const descriptor = source.snapshot.media.find((item) => item.id === file.mediaId)!;
        const archivePath = source.payload.exchange.files.find((item) => item.mediaId === file.mediaId)?.archivePath;
        if (!archivePath?.startsWith('assets/')) throw new Error('原包缺少素材条目');
        return { id: file.id, rootRef: file.rootRef, relativePath: file.relativePath, archivePath, bytes: descriptor.bytes, sha256: descriptor.sha256 };
      });
      if (!sourceFiles.length) return { sourceFiles };
      if (!options.incomingFolder) throw new Error('没有可恢复的隔离解包目录');
      const sourceRef = safeExchangePath(options.incomingFolder), assetsDir = await directory(sourceRef);
      const expected = [...new Map(sourceFiles.map((item) => [item.archivePath, {
        path: safeExchangePath(item.archivePath.slice(7)), bytes: item.bytes, sha256: item.sha256,
      }])).values()];
      const actual = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir, selectedPaths: expected.map((item) => item.path) });
      if (actual.length !== expected.length || expected.some((item) => {
        const found = actual.find((row) => row.path === item.path); return !found || !sameAsset(found, item);
      })) throw new Error('隔离来源素材不完整或摘要变化');
      return { sourceRef, sourceFiles };
    },
    async inspectAssets(capture) {
      assertBoundCapture(capture);
      const result: ProjectModelArchiveAsset[] = [];
      const directories = new Map<string, string>();
      const activeRoots = projectModelArchiveStorageContext(capture).roots;
      if (options.currentFilesOnly && options.nativeProjectId) {
        const primary = await directory(capture.aggregate.project.dataFolder);
        for (const root of activeRoots) directories.set(root.rootRef, root.rootRef === capture.aggregate.project.storageRootRef ? primary
          : `${primary.replace(/[\\/]+$/, '')}/roots/${root.rootRef}`);
      } else for (const root of activeRoots) directories.set(root.rootRef, await directory(root.folderName));
      const origins = new Map<string, StoragePathOrigin>();
      const current = currentStoragePaths(capture, directories, origins);
      for (const result of capture.nativeMediaResults ?? []) {
        const root = capture.aggregate.project.storageRootRef;
        const paths = current.get(root) ?? new Set<string>();
        paths.add(safeExchangePath(result.relativePath)); current.set(root, paths);
      }
      for (const result of capture.nativeEditorMediaArtifacts ?? []) {
        const root = capture.aggregate.project.storageRootRef;
        const paths = current.get(root) ?? new Set<string>();
        paths.add(safeExchangePath(result.path)); current.set(root, paths);
      }
      for (const asset of capture.assetMetadata ?? []) {
        if (!directories.has(asset.rootRef)) throw new Error('素材元数据的原生根不存在');
        const paths = current.get(asset.rootRef) ?? new Set<string>();
        paths.add(safeExchangePath(asset.path));
        for (const image of asset.images ?? []) for (const reference of image.references) paths.add(safeExchangePath(reference.relativePath));
        current.set(asset.rootRef, paths);
      }
      const head = capture.exchange ? headFiles(capture.exchange) : null;
      for (const proof of options.missingFiles ?? []) {
        // 冻结图片参考图可能已由原P迁到F；此投影不再读取P，原证明仍由expected的独立核验约束。
        if (options.currentFilesOnly && !current.get(proof.rootRef)?.has(proof.path)) continue;
        const logical = capture.exchange?.identities.filter((identity) => identity.kind === 'storage-root' && identity.localId === proof.rootRef && identity.sourceId === proof.logicalRoot) ?? [];
        const bound = capture.exchange?.fileBindings.filter((binding) => binding.id === proof.fileId && binding.rootRef === proof.logicalRoot
          && binding.relativePath === proof.logicalPath && binding.localRelativePath === proof.path) ?? [];
        const file = head?.files.find((entry) => entry.id === proof.fileId && entry.rootRef === proof.logicalRoot && entry.relativePath === proof.logicalPath);
        const media = head?.snapshot.media.find((entry) => entry.id === file?.mediaId);
        if (logical.length !== 1 || bound.length !== 1 || !media || media.bytes !== proof.bytes || media.sha256 !== proof.sha256) throw new Error('缺失备份来源与当前冻结文件身份不一致');
      }
      for (const file of head?.files ?? []) {
        const rootId = capture.exchange?.identities.find((item) => item.kind === 'storage-root' && item.sourceId === file.rootRef)?.localId;
        if (!rootId || !directories.has(rootId)) throw new Error('旧版本附件所在素材根缺失，无法安全导出');
      }
      for (const root of activeRoots) {
        let assetsDir = directories.get(root.rootRef)!;
        if (options.currentFilesOnly && !current.get(root.rootRef)?.size && !await exists(assetsDir)) continue;
        if (options.currentFilesOnly) assetsDir = await directory(root.folderName);
        const logicalRoot = capture.exchange?.identities.find((item) => item.kind === 'storage-root' && item.localId === root.rootRef)?.sourceId;
        const required = (head?.files ?? []).filter((item) => item.rootRef === logicalRoot).map((file) => {
          const binding = capture.exchange?.fileBindings.find((item) => item.id === file.id && item.rootRef === file.rootRef && item.relativePath === file.relativePath);
          if (!binding) throw new Error('旧版本附件缺少路径绑定，无法安全导出');
          const path = safeExchangePath(binding.localRelativePath), key = storagePathKey(root.rootRef, path);
          if (!origins.has(key)) origins.set(key, { location: `项目「${projectArchiveDisplayLabel(capture.aggregate.project.name)}」 → 旧版本附件（文件 ID：${projectArchiveDisplayLabel(file.id, '格式无效')}）`,
            fieldPath: 'exchange.fileBindings.localRelativePath' });
          return path;
        }).filter((path) => !options.currentFilesOnly || current.get(root.rootRef)?.has(path));
        if (!(await exists(assetsDir))) {
          if (required.length || current.get(root.rootRef)?.size) throw new Error('项目引用的素材根缺失，无法安全导出');
          continue;
        }
        const referencePaths = [...new Set([...required, ...(current.get(root.rootRef) ?? [])])];
        const nativeReferences = referencePaths.filter((path) => !(options.missingFiles ?? []).some((proof) => proof.rootRef === root.rootRef && proof.path === path));
        const includeImportPaths = nativeReferences.filter((path) => /^imports\//i.test(path));
        const assets = await invoke<Array<ArchiveAssetDigest & { aliases?: string[] }>>('inspect_project_archive_assets', {
          assetsDir, includeImportPaths, resolveImportAliases: true, referencePaths: nativeReferences,
        });
        // 新项目的第二个根可位于 primary/roots 下，不能再按 primary 根捕获一次。
        const nestedRoots = capture.aggregate.project.storageBindings.filter((item) => item.folderName.startsWith(`${root.folderName}/`))
          .map((item) => item.folderName.slice(root.folderName.length + 1) + '/');
        const retained: Array<ArchiveAssetDigest & { aliases?: string[]; backupSourceRelativePath?: string }> = assets.filter((asset) => !(root.folderName === options.nativeRootFolder
          && (asset.path.toLowerCase() === '.ai-canvas-native-project.json' || asset.path.toLowerCase().startsWith('roots/')))
          && !nestedRoots.some((prefix) => asset.path.startsWith(prefix))
          && !(options.missingFiles ?? []).some((proof) => proof.rootRef === root.rootRef && proof.copyPath === asset.path));
        for (const proof of options.missingFiles ?? []) if (proof.rootRef === root.rootRef && referencePaths.includes(proof.path)) {
          if (retained.some((asset) => asset.path === proof.path || asset.aliases?.includes(proof.path))) throw new Error('原缺失文件重新出现，请重新核对备份');
          safeExchangePath(proof.path); safeExchangePath(proof.copyPath);
          if (!/^imports\/missing-backup-[a-f0-9-]{36}\/copy-[a-f0-9]{64}\.[a-z0-9]{1,16}$/.test(proof.copyPath)) throw new Error('缺失备份来源不是受控副本');
          await assertNativeFileMissing(`${assetsDir.replace(/[\\/]+$/, '')}/${proof.path}`);
          const copied = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir, selectedPaths: [proof.copyPath] });
          if (copied.length !== 1 || copied[0].path !== proof.copyPath || copied[0].bytes !== proof.bytes || copied[0].sha256 !== proof.sha256) throw new Error('缺失文件的备份来源已变化');
          retained.push({ path: proof.path, bytes: proof.bytes, sha256: proof.sha256, backupSourceRelativePath: proof.copyPath });
        }
        for (const path of referencePaths) if (!retained.some((asset) => asset.path === path || asset.aliases?.includes(path))) {
          const origin = origins.get(storagePathKey(root.rootRef, path));
          const location = `${origin?.location ?? `项目「${projectArchiveDisplayLabel(capture.aggregate.project.name)}」`}（素材根：${projectArchiveDisplayLabel(root.rootRef, '已绑定根')}）`;
          throw new Error(missingProjectAssetMessage(path, location, origin?.fieldPath, '项目引用的素材缺失，无法安全导出'));
        }
        result.push(...retained
          .map((asset) => ({ path: asset.path, bytes: asset.bytes, sha256: asset.sha256, rootRef: root.rootRef, aliases: asset.aliases,
            ...(asset.backupSourceRelativePath ? { backupSourceRelativePath: asset.backupSourceRelativePath } : {}),
            localAbsolutePath: `${assetsDir.replace(/\\/g, '/').replace(/\/$/, '')}/${asset.backupSourceRelativePath ?? asset.path}` })));
      }
      return result;
    },
    async publishMedia(operation, _source) {
      const publicationPrefix = await projectModelArchiveMediaPrefix(operation.operationId);
      const sourceRoots: SourceRoot[] = [];
      if (operation.sourceRef) sourceRoots.push({ rootRef: 'incoming', directory: await directory(operation.sourceRef) });
      for (const [index, root] of (operation.expected?.aggregate.project.storageBindings ?? []).entries()) {
        sourceRoots.push({ rootRef: `local-${index}`, directory: await directory(root.folderName) });
      }
      const groups = new Map<string, { rootRef: string; assets: NativeAsset[] }>();
      for (const asset of operation.media) {
        const logicalRoot = operation.idMap.find((mapping) => mapping.kind === 'storage-root' && mapping.localId === asset.rootRef)?.sourceId;
        const binding = operation.exchange?.fileBindings.find((item) => item.rootRef === logicalRoot && item.localRelativePath === asset.relativePath);
        if (!binding) throw new Error('媒体发布清单没有冻结的本机路径绑定');
        const prefix = `imports/${publicationPrefix}-root-`;
        if (!asset.relativePath.startsWith(prefix)) throw new Error('媒体目的路径不属于原导入操作');
        const [, childOperationId, ...relative] = safeExchangePath(asset.relativePath).split('/');
        if (!/^\d+$/.test(childOperationId.slice(`${publicationPrefix}-root-`.length)) || !relative.length) throw new Error('媒体子操作身份无效');
        const destinationPath = relative.join('/');
        const file = operation.sourceFiles?.find((item) => item.id === binding.id && item.rootRef === logicalRoot && item.relativePath === binding.relativePath);
        let native: NativeAsset;
        if (file && sameAsset({ ...asset, path: '' }, { ...file, path: '' })) {
          if (!operation.sourceRef) throw new Error('原操作没有冻结的隔离解包目录');
          native = { bytes: asset.bytes, sha256: asset.sha256, path: safeExchangePath(file.archivePath.slice(7)), sourceRootRef: 'incoming', destinationPath };
        } else {
          const previousIndex = operation.expected?.aggregate.project.storageBindings.findIndex((root) => root.rootRef === asset.rootRef) ?? -1;
          const previousBinding = operation.expected?.exchange?.fileBindings.find((item) => item.id === binding.id && item.rootRef === binding.rootRef);
          if (previousIndex < 0 || !previousBinding) throw new Error('合并素材没有可证明的原来源');
          native = { bytes: asset.bytes, sha256: asset.sha256, path: safeExchangePath(previousBinding.localRelativePath),
            sourceRootRef: `local-${previousIndex}`, destinationPath };
        }
        const group = groups.get(childOperationId) ?? { rootRef: asset.rootRef, assets: [] };
        if (group.rootRef !== asset.rootRef) throw new Error('同一媒体子操作不能跨本机根');
        group.assets.push(native); groups.set(childOperationId, group);
      }
      for (const [operationId, group] of groups) {
        const root = operation.next.project.storageBindings.find((item) => item.rootRef === group.rootRef);
        if (!root) throw new Error('媒体发布根不属于目标项目');
        const projectDir = await directory(root.folderName, true);
        const finalDir = await directory(`${root.folderName}/imports/${operationId}`);
        if (await exists(finalDir)) {
          // 响应丢失后只核对同一 child 目录，缺项或不同字节均停止，绝不覆盖。
          const actual = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', {
            assetsDir: finalDir, selectedPaths: group.assets.map((item) => item.destinationPath!),
          });
          if (actual.length !== group.assets.length || group.assets.some((item) => {
            const found = actual.find((row) => row.path === item.destinationPath); return !found || !sameAsset(found, item);
          })) throw new Error('原媒体子操作已存在但无法核实，未重发');
        } else {
          const needed = new Set(group.assets.map((item) => item.sourceRootRef));
          const selectedRoots = sourceRoots.filter((item) => needed.has(item.rootRef));
          if (selectedRoots.length !== needed.size) throw new Error('原媒体来源根缺失，未重发');
          await invoke('publish_project_import_assets', { stagingDir: selectedRoots[0]?.directory ?? projectDir,
            projectDir, operationId, sourceRoots: selectedRoots, assets: group.assets });
        }
      }
      const reference = `media_v1_${operation.operationId}`;
      await verifyMedia(operation, reference);
      return reference;
    },
    verifyMediaPublication: verifyMedia,
    async pack(operation, entries, capture, logicalFiles, assets) {
      assertBoundCapture(capture);
      if (!options.outputPath) throw new Error('请先明确选择本次归档输出文件');
      const sourceRoots: SourceRoot[] = [];
      for (const [index, root] of capture.aggregate.project.storageBindings.entries()) {
        const logical = operation.exchange.identities.find((mapping) => mapping.kind === 'storage-root' && mapping.localId === root.rootRef)?.sourceId;
        if (logicalFiles.some((file) => file.rootRef === logical)) sourceRoots.push({ rootRef: `root-${index}`, directory: await directory(root.folderName, true) });
      }
      const expectedAssets: NativeAsset[] = [];
      const media = new Set<string>();
      for (const file of logicalFiles) {
        if (media.has(file.mediaId)) continue; media.add(file.mediaId);
        const localRoot = operation.exchange.identities.find((mapping) => mapping.kind === 'storage-root' && mapping.sourceId === file.rootRef)?.localId;
        const binding = operation.exchange.fileBindings.find((item) => item.id === file.id && item.rootRef === file.rootRef && item.relativePath === file.relativePath);
        const rootIndex = capture.aggregate.project.storageBindings.findIndex((item) => item.rootRef === localRoot);
        const asset = assets.find((item) => item.rootRef === localRoot && (item.path === binding?.localRelativePath
          || !!binding && item.aliases?.includes(binding.localRelativePath)));
        if (!asset) throw new Error('导出素材捕获不完整');
        const archivePath = operation.exchange.bundle.files.find((item) => item.mediaId === file.mediaId)?.archivePath;
        if (rootIndex < 0 || !archivePath?.startsWith('assets/')) throw new Error('导出素材缺少原包路径或本机来源根');
        expectedAssets.push({ path: archivePath.slice(7), bytes: asset.bytes, sha256: asset.sha256,
          sourceRootRef: `root-${rootIndex}`, sourceRelativePath: asset.backupSourceRelativePath ?? asset.path });
      }
      const assetsDir = sourceRoots[0]?.directory ?? await directory(capture.aggregate.project.dataFolder, true);
      const aliasChecks = assets.filter((asset) => asset.aliases?.length).map((asset) => {
        const index = capture.aggregate.project.storageBindings.findIndex((root) => root.rootRef === asset.rootRef);
        if (index < 0) throw new Error('素材别名来源根缺失');
        return { rootRef: `root-${index}`, path: asset.path, aliases: asset.aliases, bytes: asset.bytes, sha256: asset.sha256 };
      });
      const result = await invoke<{ operationId?: string; publicationRef?: string; archiveSha256?: string; archiveBytes?: number }>('pack_project_archive', {
        operationId: operation.operationId, entries, assetsDir, sourceRoots, outputPath: options.outputPath, expectedAssets, aliasChecks,
      });
      if (result.operationId !== operation.operationId || !result.publicationRef || !result.archiveSha256) throw new Error('原归档发布回执未知，未登记交接，禁止自动重发');
      return { outputRef: result.publicationRef, packageDigest: result.archiveSha256, archiveBytes: result.archiveBytes };
    },
    async verifyExportPublication(operation, receipt) {
      const result = await invoke<{ status: string; publicationRef?: string; archiveSha256?: string }>('verify_project_archive_publication', {
        operationId: operation.operationId, publicationRef: receipt.outputRef,
      });
      if (result.status !== 'published' || result.publicationRef !== receipt.outputRef || result.archiveSha256 !== receipt.packageDigest) throw new Error('原输出文件无法核实，未登记发布');
    },
    async recoverExportPublication(operation) {
      const result = await invoke<{ status: string; publicationRef?: string; archiveSha256?: string }>('verify_project_archive_publication', {
        operationId: operation.operationId, publicationRef: operation.outputRef,
      });
      if (result.status !== 'published' || !result.publicationRef || !result.archiveSha256) throw new Error('原发布结果仍待核对，不重新打包或覆盖');
      return { outputRef: result.publicationRef, packageDigest: result.archiveSha256 };
    },
    async createRestoreBackup(capture, expectedAssets) {
      if (!backup) throw new Error('没有新项目的恢复备份授权');
      if (!expectedAssets) throw new Error('缺少原预览的媒体清单，未恢复作品');
      const sourceMediaDigest = await currentMediaDigest(capture);
      if (sourceMediaDigest !== await inventoryDigest(expectedAssets)) throw new Error('预览后旧素材已变化，请重新预览');
      const proof = await backup.create(capture, { operationId: crypto.randomUUID() });
      if (await currentMediaDigest(capture) !== sourceMediaDigest) throw new Error('备份期间旧素材变化，未恢复作品');
      return { ...proof, sourceMediaDigest };
    },
    async verifyRestoreBackup(proof, capture) {
      if (!backup) throw new Error('没有新项目的恢复备份授权');
      if (!proof.sourceMediaDigest) throw new Error('恢复证明缺少旧媒体清单摘要');
      await backup.verify(proof, capture);
      if (await currentMediaDigest(capture) !== proof.sourceMediaDigest) throw new Error('恢复前旧素材变化，未恢复作品');
    },
    async verifyRestoreCommit(proof, capture, journal) {
      if (!backup) throw new Error('没有新项目的恢复备份授权');
      if (!proof.sourceMediaDigest) throw new Error('恢复证明缺少旧媒体清单摘要');
      await backup.verifyCommit(proof, capture, journal);
      if (await currentMediaDigest(capture, journal) !== proof.sourceMediaDigest) throw new Error('恢复提交前旧素材变化，未恢复作品');
    },
  };
  return port;
}
