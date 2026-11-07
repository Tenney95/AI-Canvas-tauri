/** 分集剧本的 TXT 副本只在主窗口显式改稿时同步；路径和待绑定回执仅在内存中使用。 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { lstat } from '@tauri-apps/plugin-fs';
import type { ProjectTextFileReference } from '../types';
import { buildEpisodeScriptFileName, needsEpisodeScriptFileSync, normalizeProjectTextFileReference } from '../utils/manuscriptFileReference';
import { createAssetTextFile, getProjectDataDir, joinPath, readAssetTextFile, saveAssetTextFile, type AssetTextSnapshot } from './fileService';
import { isTauriEnv } from './fs/core';

export { buildEpisodeScriptFileName, needsEpisodeScriptFileSync } from '../utils/manuscriptFileReference';

export interface EpisodeScriptFileWriteOptions {
  episodeId: string;
  projectId: string;
  exchangeEpoch: number;
  episodeExchangeEpoch: number;
  name: string;
  previousText: string;
  text: string;
  reference?: ProjectTextFileReference;
  assertCurrent: () => void;
  subscribe?: (listener: () => void) => () => void;
  onPrepared?: (receipt: EpisodeScriptFileReceipt) => void;
}
export interface EpisodeScriptFileReceipt {
  reference: ProjectTextFileReference;
  /** 只有项目记录也保存成功后才清理待绑定回执。 */
  confirm: () => void;
  /** 不删除新文件；既有文件只在仍是本次写入版本时恢复。 */
  rollback: (assertCurrent?: () => void) => Promise<boolean>;
}
interface PendingCreation {
  path: string;
  source: string;
  desiredName: string;
  digest: string;
  reference: ProjectTextFileReference;
}
const pendingCreations = new Map<string, PendingCreation>();
const normalizeText = (text: string) => text.replace(/\r\n/g, '\n');
const sourceKey = (reference: ProjectTextFileReference | undefined) => JSON.stringify(reference ?? null);
class EpisodeScriptFileError extends Error {}

/** 引用可以来自归档的 imports 目录；每层目录都必须是普通目录。 */
async function assertPlainParents(directory: string, relativePath: string, check: () => void) {
  let parent = directory;
  for (const segment of ['', ...relativePath.split('/').slice(0, -1)]) {
    if (segment) parent = joinPath(parent, segment);
    check();
    const info = await lstat(parent);
    check();
    if (!info.isDirectory || info.isSymlink) throw new EpisodeScriptFileError('剧本 TXT 所在目录必须是普通文件夹');
  }
}

/** Web 演示继续保存项目记录；没有原生文件能力时不伪造文件引用。 */
export async function prepareEpisodeScriptFileWrite(options: EpisodeScriptFileWriteOptions): Promise<EpisodeScriptFileReceipt | undefined> {
  if (!isTauriEnv()) return undefined;
  if (getCurrentWindow().label !== 'main') throw new EpisodeScriptFileError('请通过主窗口保存本集剧本');
  const reference = normalizeProjectTextFileReference(options.reference);
  const text = normalizeText(options.text);
  const desiredName = buildEpisodeScriptFileName(options.name);
  if (text.includes('\0')) throw new EpisodeScriptFileError('文本不能包含二进制空字符');
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new EpisodeScriptFileError('内容超过 2 MB，无法保存');
  const controller = new AbortController();
  const check = () => {
    controller.signal.throwIfAborted();
    try { options.assertCurrent(); }
    catch (reason) { throw new EpisodeScriptFileError('剧本保存期间项目或稿件已变化，草稿已保留', { cause: reason }); }
  };
  const stop = options.subscribe?.(() => { try { options.assertCurrent(); } catch { controller.abort(); } });
  const key = JSON.stringify([options.projectId, options.episodeId, options.exchangeEpoch, options.episodeExchangeEpoch]);
  const complete = () => {
    const pending = pendingCreations.get(key);
    if (pending && pending.reference.relativePath === nextReference.relativePath) pendingCreations.delete(key);
  };
  let nextReference: ProjectTextFileReference;
  try {
    check();
    let previous: AssetTextSnapshot | undefined;
    let path: string | undefined;
    let boundDirectory: string | undefined;
    if (reference) {
      const directory = await getProjectDataDir(options.projectId);
      check();
      if (!directory) throw new EpisodeScriptFileError('剧集素材目录不可用，请重新打开剧集');
      await assertPlainParents(directory, reference.relativePath, check);
      boundDirectory = directory;
      path = joinPath(directory, reference.relativePath);
      try { previous = await readAssetTextFile(path, controller.signal); }
      catch (reason) { check(); throw new EpisodeScriptFileError('无法读取本集 TXT，草稿已保留，请恢复文件后重试', { cause: reason }); }
      check();
      const expected = reference.digest ? previous.digest === reference.digest : previous.content === normalizeText(options.previousText);
      // 上次 TXT 已写成而项目提交失败时，显式重试可以只补交项目记录。
      if (!expected && previous.content !== text) throw new EpisodeScriptFileError('本集 TXT 已被修改，未覆盖磁盘内容；请先核对文件与当前草稿');
    }
    if (needsEpisodeScriptFileSync({ name: options.name, episodeScriptFile: reference })) {
      let pending = pendingCreations.get(key);
      let pendingDirectory: string | undefined;
      if (pending && pending.desiredName === desiredName && pending.source === sourceKey(reference)) {
        const directory = await getProjectDataDir(options.projectId);
        check();
        if (!directory) throw new EpisodeScriptFileError('剧集素材目录不可用，请重新打开剧集');
        pendingDirectory = directory;
        // 保存根目录或剧集目录已改变时，旧位置保留为恢复副本，不能绑定成新目录的文件。
        if (pending.path !== joinPath(directory, pending.reference.relativePath)) pending = undefined;
      }
      if (pending && pending.desiredName === desiredName && pending.source === sourceKey(reference)) {
        let current: AssetTextSnapshot;
        if (!pendingDirectory) throw new EpisodeScriptFileError('剧集素材目录不可用，请重新打开剧集');
        await assertPlainParents(pendingDirectory, pending.reference.relativePath, check);
        try { current = await readAssetTextFile(pending.path, controller.signal); }
        catch (reason) { check(); throw new EpisodeScriptFileError('待绑定的剧本 TXT 不可用，草稿已保留，请检查项目文件', { cause: reason }); }
        check();
        if (current.digest !== pending.digest) throw new EpisodeScriptFileError('待绑定的剧本 TXT 已被修改，未覆盖文件；请先核对项目文件');
        if (current.content !== text) pending.digest = (await saveAssetTextFile(pending.path, current, text, controller.signal)).digest;
        pending.reference = { ...pending.reference, digest: pending.digest };
      } else {
        const created = await createAssetTextFile(options.projectId, text, desiredName, {
          projectSubdirectory: 'manuscripts', signal: controller.signal, assertCurrent: check,
        });
        pending = { path: created.filePath, source: sourceKey(reference), desiredName, digest: created.snapshot.digest,
          reference: { fileName: created.fileName, relativePath: created.relativePath, digest: created.snapshot.digest, sourceName: desiredName } };
        // 读回已成功，即使接下来目标变化，也保留可恢复副本而不盲目删除正文。
        pendingCreations.set(key, pending);
      }
      nextReference = pending.reference;
      const receipt: EpisodeScriptFileReceipt = { reference: nextReference, confirm: complete, rollback: async () => false };
      options.onPrepared?.(receipt);
      check();
      return receipt;
    }
    if (!reference || !previous || !path || !boundDirectory) throw new EpisodeScriptFileError('本集剧本文件引用无效');
    let saved = previous;
    if (previous.content !== text) saved = await saveAssetTextFile(path, previous, text, controller.signal);
    nextReference = { ...reference, digest: saved.digest, sourceName: desiredName };
    const writtenPath = path;
    const writtenDirectory = boundDirectory;
    const baseline = previous;
    const written = saved;
    const receipt: EpisodeScriptFileReceipt = { reference: nextReference, confirm: complete, rollback: async (assertCurrent) => {
      assertCurrent?.();
      if (written.digest === baseline.digest) return true;
      await assertPlainParents(writtenDirectory, reference.relativePath, () => assertCurrent?.());
      const current = await readAssetTextFile(writtenPath);
      assertCurrent?.();
      if (current.digest !== written.digest) return false;
      await saveAssetTextFile(writtenPath, current, baseline.content);
      return true;
    } };
    options.onPrepared?.(receipt);
    check();
    return receipt;
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'AbortError') throw new EpisodeScriptFileError('剧本保存期间项目或稿件已变化，草稿已保留，请回到原分集重试', { cause: reason });
    if (reason instanceof EpisodeScriptFileError) throw reason;
    throw new EpisodeScriptFileError('剧本 TXT 保存未确认完成，草稿已保留，请检查文件权限与磁盘空间', { cause: reason });
  } finally { stop?.(); }
}
