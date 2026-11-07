/** P5 fixture 的真实文件适配；所有源根由冷维护 profile 与相对绑定推出，输出仍需原生路径授权。 */
import { invoke } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import * as files from './fileService';
import { projectModelArchiveMediaPrefix, projectModelArchiveStorageContext, readProjectModelArchive, type ProjectModelArchivePort, type ProjectModelArchiveAsset } from './projectModelArchiveService';
import type { ProjectModelFixtureBusinessSession } from '../types/projectModelBusiness';
import type { ProjectModelTransferCapture, ProjectModelTransferImportJournal } from '../types/projectModelTransfer';
import { createProjectModelPreRestoreBackupService } from './projectModelPreRestoreBackup';
import type { ArchiveAssetDigest } from './projectExchangeDomain';
import { safeExchangePath } from './projectExchangeDomain';
import { readProjectArchiveV4Files } from './projectArchiveV4';
import type { ProjectModelTransferExchange } from '../types/projectModelTransfer';
import { createProjectArchiveFixturePreviewDirectory } from './fs/projectArchiveFixtureFiles';
import { sha256BytesHex } from './mediaDataUrl';

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
/** 只读领域文件字段；新生成且尚未登记进 head 的 imports 文件也属于当前作品。 */
function currentStoragePaths(capture: ProjectModelTransferCapture, directories: Map<string, string>): Map<string, Set<string>> {
  const paths = new Map([...directories.keys()].map((root) => [root, new Set<string>()]));
  const walk = (value: unknown, rootRef: string, field = ''): void => {
    if (typeof value === 'string' && value) {
      let relative: string | undefined;
      if (pathFields.has(field)) relative = safeExchangePath(value);
      else if (['filePath', 'imageFilePath', 'directorCaptureFilePaths'].includes(field)) {
        const directory = directories.get(rootRef)?.replace(/\\/g, '/').replace(/\/$/, ''), absolute = value.replace(/\\/g, '/');
        if (directory && (/^[a-z]:\//i.test(directory) ? absolute.toLowerCase().startsWith(directory.toLowerCase() + '/') : absolute.startsWith(directory + '/'))) {
          relative = safeExchangePath(absolute.slice(directory.length + 1));
        }
      }
      if (relative) paths.get(rootRef)?.add(relative);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) walk(item, rootRef, field); return; }
    if (!value || typeof value !== 'object') return;
    const bound = typeof (value as { storageRootRef?: unknown }).storageRootRef === 'string'
      ? (value as { storageRootRef: string }).storageRootRef : rootRef;
    if (!directories.has(bound)) throw new Error('当前素材引用的根不属于项目');
    for (const [key, item] of Object.entries(value)) walk(item, bound, key);
  };
  const primary = projectModelArchiveStorageContext(capture).primary;
  walk(capture.aggregate.content, primary); walk(capture.aggregate.project.defaultSettings, primary);
  for (const content of capture.aggregate.episodeContents) walk(content, content.storageRootRef);
  for (const episode of capture.aggregate.episodes) walk(episode.settingsPolicy,
    capture.aggregate.episodeContents.find((item) => item.episodeId === episode.id)?.storageRootRef ?? primary);
  for (const canvas of capture.aggregate.canvases) walk(canvas, canvas.storageRootRef);
  return paths;
}

export function createNativeProjectModelArchivePort(database: IDBDatabase, session: ProjectModelFixtureBusinessSession,
  options: { incomingFolder?: string; outputPath?: string } = {}): ProjectModelArchivePort {
  const backup = createProjectModelPreRestoreBackupService(database, session);
  const directory = (relative: string, create = false) => files.projectArchiveFixtureDirectory(database.name, relative, create);
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
      const result: ProjectModelArchiveAsset[] = [];
      const directories = new Map<string, string>();
      const activeRoots = projectModelArchiveStorageContext(capture).roots;
      for (const root of activeRoots) directories.set(root.rootRef, await directory(root.folderName));
      const current = currentStoragePaths(capture, directories);
      const head = capture.exchange ? headFiles(capture.exchange) : null;
      for (const file of head?.files ?? []) {
        const rootId = capture.exchange?.identities.find((item) => item.kind === 'storage-root' && item.sourceId === file.rootRef)?.localId;
        if (!rootId || !directories.has(rootId)) throw new Error('旧版本附件所在素材根缺失，无法安全导出');
      }
      for (const root of activeRoots) {
        const assetsDir = directories.get(root.rootRef)!;
        const logicalRoot = capture.exchange?.identities.find((item) => item.kind === 'storage-root' && item.localId === root.rootRef)?.sourceId;
        const required = (head?.files ?? []).filter((item) => item.rootRef === logicalRoot).map((file) => {
          const binding = capture.exchange?.fileBindings.find((item) => item.id === file.id && item.rootRef === file.rootRef && item.relativePath === file.relativePath);
          if (!binding) throw new Error('旧版本附件缺少路径绑定，无法安全导出');
          return safeExchangePath(binding.localRelativePath);
        });
        if (!(await exists(assetsDir))) {
          if (required.length) throw new Error('旧版本附件所在素材根缺失，无法安全导出');
          continue;
        }
        const referencePaths = [...new Set([...required, ...(current.get(root.rootRef) ?? [])])];
        const includeImportPaths = referencePaths.filter((path) => /^imports\//i.test(path));
        const assets = await invoke<Array<ArchiveAssetDigest & { aliases?: string[] }>>('inspect_project_archive_assets', {
          assetsDir, includeImportPaths, resolveImportAliases: true, referencePaths,
        });
        // 新项目的第二个根可位于 primary/roots 下，不能再按 primary 根捕获一次。
        const nestedRoots = capture.aggregate.project.storageBindings.filter((item) => item.folderName.startsWith(`${root.folderName}/`))
          .map((item) => item.folderName.slice(root.folderName.length + 1) + '/');
        const retained = assets.filter((asset) => !nestedRoots.some((prefix) => asset.path.startsWith(prefix)));
        for (const path of required) if (!retained.some((asset) => asset.path === path || asset.aliases?.includes(path))) {
          throw new Error('旧版本附件缺失，无法安全导出');
        }
        result.push(...retained
          .map((asset) => ({ path: asset.path, bytes: asset.bytes, sha256: asset.sha256, rootRef: root.rootRef, aliases: asset.aliases,
            localAbsolutePath: `${assetsDir.replace(/\\/g, '/').replace(/\/$/, '')}/${asset.path}` })));
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
      if (!options.outputPath) throw new Error('请先明确选择本次归档输出文件');
      const sourceRoots: SourceRoot[] = [];
      for (const [index, root] of capture.aggregate.project.storageBindings.entries()) sourceRoots.push({ rootRef: `root-${index}`, directory: await directory(root.folderName, true) });
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
          sourceRootRef: `root-${rootIndex}`, sourceRelativePath: asset.path });
      }
      const assetsDir = sourceRoots[0]?.directory ?? await directory(capture.aggregate.project.dataFolder, true);
      const aliasChecks = assets.filter((asset) => asset.aliases?.length).map((asset) => {
        const index = capture.aggregate.project.storageBindings.findIndex((root) => root.rootRef === asset.rootRef);
        if (index < 0) throw new Error('素材别名来源根缺失');
        return { rootRef: `root-${index}`, path: asset.path, aliases: asset.aliases, bytes: asset.bytes, sha256: asset.sha256 };
      });
      const result = await invoke<{ operationId?: string; publicationRef?: string; archiveSha256?: string }>('pack_project_archive', {
        operationId: operation.operationId, entries, assetsDir, sourceRoots, outputPath: options.outputPath, expectedAssets, aliasChecks,
      });
      if (result.operationId !== operation.operationId || !result.publicationRef || !result.archiveSha256) throw new Error('原归档发布回执未知，未登记交接，禁止自动重发');
      return { outputRef: result.publicationRef, packageDigest: result.archiveSha256 };
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
      if (!expectedAssets) throw new Error('缺少原预览的媒体清单，未恢复作品');
      const sourceMediaDigest = await currentMediaDigest(capture);
      if (sourceMediaDigest !== await inventoryDigest(expectedAssets)) throw new Error('预览后旧素材已变化，请重新预览');
      const proof = await backup.create(capture, { operationId: crypto.randomUUID() });
      if (await currentMediaDigest(capture) !== sourceMediaDigest) throw new Error('备份期间旧素材变化，未恢复作品');
      return { ...proof, sourceMediaDigest };
    },
    async verifyRestoreBackup(proof, capture) {
      if (!proof.sourceMediaDigest) throw new Error('恢复证明缺少旧媒体清单摘要');
      await backup.verify(proof, capture);
      if (await currentMediaDigest(capture) !== proof.sourceMediaDigest) throw new Error('恢复前旧素材变化，未恢复作品');
    },
    async verifyRestoreCommit(proof, capture, journal) {
      if (!proof.sourceMediaDigest) throw new Error('恢复证明缺少旧媒体清单摘要');
      await backup.verifyCommit(proof, capture, journal);
      if (await currentMediaDigest(capture, journal) !== proof.sourceMediaDigest) throw new Error('恢复提交前旧素材变化，未恢复作品');
    },
  };
  return port;
}
