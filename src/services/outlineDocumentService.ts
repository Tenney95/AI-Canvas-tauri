/** 主窗口持有的大纲资料会话；正文、文件路径和草稿仅保存在本实例内存中。 */
import { open as selectFiles } from '@tauri-apps/plugin-dialog';
import { lstat, mkdir, open as fsOpen, readDir } from '@tauri-apps/plugin-fs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { t } from '../i18n';
import type { OutlineDocumentAction, OutlineDocumentFile, OutlineDocumentHandoff, OutlineDocumentKind, OutlineDocumentSummary, OutlineOpenedDocument } from '../types/outlineDocument';
import { useAppStore } from '../store/useAppStore';
import { seriesOwnerId } from '../store/store.utils';
import { copyAssetFileToFolder, createAssetTextFile, ensureProjectDataDir, getProjectDataDir, isTauriEnv, joinPath, notifyProjectDiskChanged, readAssetTextFile, saveAssetTextFile, stripVerbatimPrefix, type AssetTextSnapshot } from './fileService';

const DIRECTORY = 'outline-documents';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = ['md', 'txt', 'pdf', 'ppt', 'pptx', 'doc', 'docx'];
const KINDS: Record<string, OutlineDocumentKind> = { md: 'text', txt: 'text', pdf: 'pdf', ppt: 'presentation', pptx: 'presentation', doc: 'legacy-word', docx: 'word' };
class OutlineError extends Error {}

function mainWindowOnly() {
  if (isTauriEnv() && getCurrentWindow().label !== 'main') throw new OutlineError('请通过主窗口管理大纲文件');
}

function captureBinding(seriesId: string) {
  mainWindowOnly();
  if (!isTauriEnv()) throw new OutlineError('请在桌面应用中管理大纲文件');
  const state = useAppStore.getState();
  if (!state.currentProjectId || state.projectLoadStatus !== 'ready' || state.isCreatingProject
    || state.isReturningToStartPage || state.switchingProjectName !== null
    || seriesOwnerId(state.projects, state.currentProjectId) !== seriesId) {
    throw new OutlineError('当前剧集已切换或尚未加载，请回到原剧集后重试');
  }
  const owner = state.projects.find((project) => project.id === seriesId && !project.parentId);
  if (!owner) throw new OutlineError('当前剧集不存在');
  const native = (owner as typeof owner & { nativeView?: { projectId: string; canvasId: string | null; episodeId: string | null } }).nativeView;
  return { seriesId, currentProjectId: state.currentProjectId, projectName: owner.name, folder: owner.dataFolder,
    exchangeEpoch: owner.exchangeEpoch ?? 0, baseDirectory: state.config?.baseDataDir,
    nativeIdentity: native ? JSON.stringify([native.projectId, native.canvasId, native.episodeId]) : undefined };
}
type Binding = ReturnType<typeof captureBinding>;
type Operation = { binding: Binding; check: () => void; signal: AbortSignal };
type FileInfo = Awaited<ReturnType<typeof lstat>>;
type DocumentDirectory = { root: string; path: string; rootInfo: FileInfo; info: FileInfo };

function isLink(info: FileInfo) {
  // Windows junction 与其他 reparse point 也不能作为托管文档目录或文件。
  return info.isSymlink || ((info.fileAttributes ?? 0) & 0x400) !== 0;
}

function sameDirectory(left: FileInfo, right: FileInfo) {
  return right.isDirectory && !isLink(right)
    && (left.dev == null || right.dev == null || left.dev === right.dev)
    && (left.ino == null || right.ino == null || left.ino === right.ino)
    && (!left.birthtime || !right.birthtime || left.birthtime.getTime() === right.birthtime.getTime());
}

function sameStorage(left: Binding, right: Binding) {
  return left.seriesId === right.seriesId && left.projectName === right.projectName && left.folder === right.folder
    && left.exchangeEpoch === right.exchangeEpoch && left.baseDirectory === right.baseDirectory && left.nativeIdentity === right.nativeIdentity;
}

function comparablePath(path: string) {
  const normalized = stripVerbatimPrefix(path).replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

function validFileName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && name.lastIndexOf('.') > 0 && name !== '.' && name !== '..'
    && !/[\\/:*?"<>|]/.test(name) && ![...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && !/[. ]$/.test(name)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) && /\.(md|txt|pdf|pptx?|docx?)$/i.test(name);
}

function enforceSize(fileName: string, size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new OutlineError('文件超过 32 MB 或大小无效，无法导入或预览');
  if (KINDS[fileName.split('.').pop()!.toLowerCase()] === 'text' && size > MAX_TEXT_BYTES) throw new OutlineError('文本文件超过 2 MB，请使用外部编辑器');
}

function safeError(reason: unknown): string {
  if (reason instanceof OutlineError) return reason.message;
  const message = reason instanceof Error ? reason.message : '';
  const known = ['文件不是有效 UTF-8，已停止编辑以避免乱码', '文件包含二进制数据，无法作为文本编辑',
    '文件超过 2 MB，请使用外部编辑器', '磁盘文件已被修改，请保留草稿并重新载入后再保存',
    '内容超过 2 MB，无法保存', '文本不能包含二进制空字符', '已写入磁盘，但无法重新读取确认；草稿已保留，请重新载入检查'];
  return known.includes(message) ? message : '大纲文件操作失败，已有草稿和原文件已保留；请检查文件权限、文件可用性和磁盘空间后重试';
}

function encodeBase64(bytes: Uint8Array) {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(''));
}

export function createOutlineDocumentSession(options: { seriesId: string; onChange?: () => void }) {
  let disposed = false;
  let generation = 0;
  let loaded = false;
  let files: OutlineDocumentFile[] = [];
  let fileMap = new Map<string, OutlineDocumentFile>();
  let catalogBinding: Binding | undefined;
  let catalogRoot: string | undefined;
  let selected = false;
  let error: string | undefined;
  let document: { file: OutlineDocumentFile; documentId: string; revision: number; acceptedSequence: number;
    content?: string; baseline?: AssetTextSnapshot; binding: Binding; root: string } | undefined;
  let active: { controller: AbortController; stop: () => void } | undefined;
  const listeners = new Set<() => void>();
  const changed = () => { if (!disposed) { options.onChange?.(); listeners.forEach((listener) => listener()); } };
  const live = () => { if (disposed) throw new OutlineError('大纲文件会话已关闭'); mainWindowOnly(); };
  const isDirty = () => document?.content !== undefined && !!document.baseline && document.content !== document.baseline.content;
  const idle = () => { if (active) throw new OutlineError('大纲文件正在处理，请稍候'); };
  const assertStorage = (binding: Binding, exactProject = false) => {
    live();
    const current = captureBinding(options.seriesId);
    if (!sameStorage(binding, current) || exactProject && current.currentProjectId !== binding.currentProjectId) {
      throw new OutlineError('剧集或存储目录已变化，草稿已保留，请重新打开原剧集');
    }
  };
  const ensureClean = () => { if (isDirty()) throw new OutlineError('请先保存当前草稿，或重新载入并明确放弃草稿后再切换文件'); };
  const textSnapshot = (): Extract<OutlineOpenedDocument, { kind: 'text' }> => {
    if (!document || document.content === undefined) throw new OutlineError('请先打开 Markdown 或 TXT 文件');
    return { kind: 'text', documentId: document.documentId, fileName: document.file.fileName,
      revision: document.revision, acceptedSequence: document.acceptedSequence, content: document.content };
  };

  async function operate<T>(run: (operation: Operation) => Promise<T>): Promise<T> {
    live(); idle();
    const binding = captureBinding(options.seriesId);
    if (catalogBinding) assertStorage(catalogBinding);
    const capturedGeneration = generation;
    const controller = new AbortController();
    const check = () => {
      live(); controller.signal.throwIfAborted();
      if (capturedGeneration !== generation) throw new OutlineError('大纲文件操作已取消，草稿已保留');
      assertStorage(binding, true);
    };
    const stop = useAppStore.subscribe(() => { try { check(); } catch { controller.abort(); } });
    const operation = { controller, stop };
    active = operation; error = undefined; changed();
    try { return await run({ binding, check, signal: controller.signal }); }
    finally { stop(); if (active === operation) active = undefined; changed(); }
  }

  async function directory(operation: Operation, create = false): Promise<DocumentDirectory | undefined> {
    const root = create ? await ensureProjectDataDir(options.seriesId, { throwOnError: true }) : await getProjectDataDir(options.seriesId);
    operation.check();
    if (!root) throw new OutlineError('剧集文件目录不可用，请重新打开剧集');
    if (catalogRoot && comparablePath(root) !== comparablePath(catalogRoot)) throw new OutlineError('剧集文件目录已变化，草稿已保留，请重新打开剧集');
    const rootInfo = await lstat(root); operation.check();
    if (!rootInfo.isDirectory || isLink(rootInfo)) throw new OutlineError('剧集文件目录必须是普通文件夹');
    const path = joinPath(root, DIRECTORY);
    let info: FileInfo;
    try { info = await lstat(path); }
    catch (reason) {
      operation.check();
      // 只有成功读取父目录并确认条目缺失，才把异常解释为空目录。
      const siblings = await readDir(root); operation.check();
      if (siblings.some((entry) => entry.name.toLowerCase() === DIRECTORY)) throw reason;
      const checkedRoot = await lstat(root); operation.check();
      if (!sameDirectory(rootInfo, checkedRoot)) throw new OutlineError('剧集文件目录在读取期间已变化，请重新打开剧集');
      if (!create) { catalogRoot = root; catalogBinding = operation.binding; return undefined; }
      try { await mkdir(path); } catch { /* 并发创建后仍须重新检查真实目录。 */ }
      operation.check(); info = await lstat(path);
    }
    operation.check();
    if (!info.isDirectory || isLink(info)) throw new OutlineError('大纲资料目录必须是普通文件夹');
    const folder = { root, path, rootInfo, info };
    await verifyDirectory(folder, operation);
    catalogRoot = root; catalogBinding = operation.binding;
    return folder;
  }

  async function verifyDirectory(folder: DocumentDirectory, operation: Operation) {
    const rootInfo = await lstat(folder.root); operation.check();
    const info = await lstat(folder.path); operation.check();
    if (!sameDirectory(folder.rootInfo, rootInfo) || !sameDirectory(folder.info, info)) {
      throw new OutlineError('文档目录在操作期间已变化，草稿已保留，请重新打开剧集');
    }
  }

  async function scan(operation: Operation) {
    const folder = await directory(operation); operation.check();
    const next: OutlineDocumentFile[] = [];
    if (folder) {
      const entries = await readDir(folder.path); operation.check();
      await verifyDirectory(folder, operation);
      const candidates = entries.filter((entry) => entry.isFile && !entry.isSymlink && validFileName(entry.name));
      if (candidates.length > 2000) throw new OutlineError('大纲文件过多，请整理资料目录后重试');
      for (const entry of candidates) {
        const info = await lstat(joinPath(folder.path, entry.name)); operation.check();
        if (!info.isFile || isLink(info)) continue;
        const modifiedAt = info.mtime?.getTime();
        next.push({ id: entry.name, fileName: entry.name, kind: KINDS[entry.name.split('.').pop()!.toLowerCase()], size: info.size,
          ...(modifiedAt !== undefined && Number.isFinite(modifiedAt) ? { modifiedAt } : {}) });
      }
      await verifyDirectory(folder, operation);
    }
    operation.check();
    next.sort((left, right) => left.fileName.localeCompare(right.fileName, undefined, { numeric: true }));
    files = next; fileMap = new Map(next.map((file) => [file.id, file])); loaded = true; changed();
  }

  async function openFile(id: string, operation: Operation, reload = false): Promise<OutlineOpenedDocument> {
    const file = typeof id === 'string' && validFileName(id) ? fileMap.get(id) : undefined;
    if (!file) throw new OutlineError('该文件不在当前大纲资料列表中，请刷新列表后重试');
    if (!reload && document?.file.id === id && document.content !== undefined) {
      assertStorage(document.binding); selected = true; changed(); return textSnapshot();
    }
    if (!reload) ensureClean();
    const previousDocument = document;
    const assertUnchanged = () => {
      operation.check();
      if (document !== previousDocument) throw new OutlineError('读取期间草稿已变化，最新输入已保留，请重新选择文件');
    };
    const folder = await directory(operation); operation.check();
    if (!folder) throw new OutlineError('大纲资料目录不存在，请刷新文件列表');
    const path = joinPath(folder.path, file.fileName);
    const info = await lstat(path); operation.check();
    if (!info.isFile || isLink(info)) throw new OutlineError('仅支持普通文档文件，不能打开链接或文件夹');
    enforceSize(file.fileName, info.size);
    const next = { file: { ...file, size: info.size }, documentId: crypto.randomUUID(), revision: 0, acceptedSequence: 0,
      binding: operation.binding, root: folder.root };
    if (file.kind === 'text') {
      const snapshot = await readAssetTextFile(path, operation.signal);
      await verifyDirectory(folder, operation); assertUnchanged();
      document = { ...next, content: snapshot.content, baseline: snapshot }; selected = true; changed();
      return textSnapshot();
    }
    const handle = await fsOpen(path, { read: true });
    const buffer = new Uint8Array(info.size + 1);
    let length = 0;
    try {
      operation.check();
      while (length < buffer.length) {
        const count = await handle.read(buffer.subarray(length)); operation.check();
        if (!count) break;
        length += count;
      }
    } finally { await handle.close(); }
    operation.check(); enforceSize(file.fileName, length);
    const currentInfo = await lstat(path); operation.check();
    if (!currentInfo.isFile || isLink(currentInfo) || currentInfo.size !== info.size || length !== info.size
      || currentInfo.mtime?.getTime() !== info.mtime?.getTime()) throw new OutlineError('文件在读取期间已变化，请重新打开');
    await verifyDirectory(folder, operation);
    const base64 = encodeBase64(buffer.subarray(0, length)); assertUnchanged();
    document = next; selected = true; changed();
    return { kind: file.kind, documentId: next.documentId, fileName: file.fileName, base64 };
  }

  function flush(handoff: OutlineDocumentHandoff) {
    live();
    if (!document || document.content === undefined || !document.baseline) throw new OutlineError('请先打开 Markdown 或 TXT 文件');
    assertStorage(document.binding);
    if (!handoff || handoff.documentId !== document.documentId || !Number.isSafeInteger(handoff.sequence) || handoff.sequence < 0
      || typeof handoff.content !== 'string') throw new OutlineError('大纲文件编辑版本不匹配，请重新打开文件');
    if (handoff.sequence <= document.acceptedSequence) return;
    const content = handoff.content.replace(/\r\n/g, '\n');
    if (content.includes('\0')) throw new OutlineError('文本不能包含二进制空字符');
    if (new TextEncoder().encode(content).byteLength > MAX_TEXT_BYTES) throw new OutlineError('内容超过 2 MB，无法保存');
    document = { ...document, content, acceptedSequence: handoff.sequence,
      revision: document.revision + (document.content !== content ? 1 : 0) };
    error = undefined; changed();
  }

  async function handle(action: OutlineDocumentAction): Promise<OutlineOpenedDocument | undefined> {
    try {
      live();
      switch (action.type) {
        case 'outline_select_builtin': idle(); selected = false; error = undefined; changed(); return;
        case 'outline_edit': flush(action.handoff); return textSnapshot();
        case 'outline_list': await operate(scan); return;
        case 'outline_open': return await operate((operation) => openFile(action.id, operation));
        case 'outline_create':
          ensureClean();
          if ((action.extension !== 'md' && action.extension !== 'txt') || typeof action.name !== 'string') throw new OutlineError('只能新建 Markdown 或 TXT 文件');
          return await operate(async (operation) => {
            const previousDocument = document;
            const name = action.name.trim();
            const fileName = name.toLowerCase().endsWith(`.${action.extension}`) ? name : `${name}.${action.extension}`;
            if (!name || !validFileName(fileName)) throw new OutlineError('文件名无效，请去掉目录、特殊字符或系统保留名称');
            await directory(operation, true); operation.check();
            const created = await createAssetTextFile(options.seriesId, '', fileName,
              { signal: operation.signal, assertCurrent: operation.check, projectSubdirectory: DIRECTORY }); operation.check();
            await scan(operation); operation.check();
            if (document !== previousDocument) throw new OutlineError('新建期间草稿已变化，草稿和新文件已保留，请重新选择文件');
            return openFile(created.fileName, operation);
          });
        case 'outline_import':
          await operate(async (operation) => {
            const selectedFiles = await selectFiles({ multiple: true, title: t('导入大纲资料'), filters: [{ name: t('大纲资料'), extensions: EXTENSIONS }] }); operation.check();
            if (!selectedFiles) return;
            const paths = typeof selectedFiles === 'string' ? [selectedFiles] : selectedFiles;
            if (paths.length > 50) throw new OutlineError('每次最多导入 50 个文档');
            for (const path of paths) {
              const fileName = path.split(/[\\/]/).pop();
              if (!validFileName(fileName)) throw new OutlineError('只支持 MD、TXT、PDF、PPT、PPTX、DOC 和 DOCX 文件');
              const info = await lstat(path); operation.check();
              if (!info.isFile || isLink(info)) throw new OutlineError('只能导入普通文档文件，不能导入链接或文件夹');
              enforceSize(fileName, info.size);
            }
            const folder = await directory(operation, true); operation.check();
            if (!folder) throw new OutlineError('无法创建大纲资料目录，请检查写入权限');
            try {
              for (const path of paths) {
                const result = await copyAssetFileToFolder(path, folder.path, { signal: operation.signal, assertCurrent: operation.check });
                operation.check(); notifyProjectDiskChanged();
                enforceSize(result.path.split(/[\\/]/).pop() ?? '', result.totalBytes);
              }
            } finally { operation.check(); await scan(operation); }
          });
          return;
        case 'outline_save':
          return await operate(async (operation) => {
            const captured = document;
            if (!captured || captured.content === undefined || !captured.baseline) throw new OutlineError('请先打开 Markdown 或 TXT 文件');
            assertStorage(captured.binding);
            const folder = await directory(operation); operation.check();
            if (!folder || comparablePath(folder.root) !== comparablePath(captured.root) || !fileMap.has(captured.file.id)) {
              throw new OutlineError('文档目录或文件列表已变化，草稿已保留，请重新载入');
            }
            if (!isDirty()) return textSnapshot();
            const saved = await saveAssetTextFile(joinPath(folder.path, captured.file.fileName), captured.baseline, captured.content, operation.signal);
            await verifyDirectory(folder, operation);
            if (document?.documentId !== captured.documentId) throw new OutlineError('大纲文件会话已变化，草稿已保留');
            document = { ...document, baseline: saved }; changed();
            await scan(operation); operation.check();
            return textSnapshot();
          });
        case 'outline_reload':
          if (action.discard !== undefined && typeof action.discard !== 'boolean') throw new OutlineError('放弃草稿选项无效');
          if (!action.discard) ensureClean();
          return await operate(async (operation) => {
            const previousDocument = document;
            const id = document?.file.id;
            if (!id) throw new OutlineError('请先选择需要重新载入的文件');
            await scan(operation); operation.check();
            if (document !== previousDocument) throw new OutlineError('重新载入期间草稿已变化，最新输入已保留，请再次选择是否放弃草稿');
            return openFile(id, operation, true);
          });
        default: throw new OutlineError('不支持的大纲文件操作');
      }
    } catch (reason) {
      const cancelled = reason instanceof DOMException && reason.name === 'AbortError';
      error = cancelled ? '大纲文件操作已取消，已有草稿和原文件已保留' : safeError(reason);
      changed(); throw new Error(error, { cause: reason });
    }
  }

  return {
    readDraft(): Extract<OutlineOpenedDocument, { kind: 'text' }> {
      live();
      if (!selected || !document || document.content === undefined) throw new OutlineError('请先选择 Markdown 或 TXT 文件');
      assertStorage(document.binding);
      return textSnapshot();
    },
    getSummary(): OutlineDocumentSummary {
      return { files: files.map((file) => ({ ...file })), loaded, selected, busy: !!active, dirty: isDirty(),
        fileId: document?.file.id, documentId: document?.documentId, revision: document?.revision ?? 0, acceptedSequence: document?.acceptedSequence ?? 0,
        fileName: document?.file.fileName, error };
    },
    subscribe(listener: () => void) {
      live(); listeners.add(listener);
      return () => { listeners.delete(listener); if (!listeners.size) active?.controller.abort(); };
    },
    handle, flush, isDirty, isBusy: () => !!active,
    discard() {
      generation++; active?.controller.abort(); document = undefined; selected = false; error = undefined; changed();
    },
    dispose() {
      disposed = true; generation++; active?.controller.abort(); listeners.clear(); document = undefined; files = []; fileMap.clear(); loaded = false;
    },
  };
}
