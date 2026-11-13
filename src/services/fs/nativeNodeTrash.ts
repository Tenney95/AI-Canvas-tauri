/** 新结构节点回收前核对整作品引用；只排除本次删除节点，不改写回执或恢复材料。 */
import { invoke } from '@tauri-apps/api/core';
import { configValuesEqual } from '../configPatch';
import { readNativeProjectCapture } from '../indexedDb/nativeProjectRepository';
import {
  getConversationMessages, getProjectConversations, getTrashConversations,
} from '../indexedDbService';
import { getNativeProjectOwner, getProjectDataDir } from './core';
import {
  collectNativeStorageReferences, nativeStorageProjectProtected, nativeStorageProjectRows,
  readNativeStorageSnapshot,
} from './nativeStorageReferences';

type Capture = NonNullable<Awaited<ReturnType<typeof readNativeProjectCapture>>>;
type ProjectRows = ReturnType<typeof nativeStorageProjectRows>;

/** 原生生成历史已由回执保护；所有会话（包括可恢复会话）的附件另外参与核对。 */
async function collectRelatedReferences(capture: Capture, rows: ProjectRows, roots: ReadonlyMap<string, string>): Promise<Set<string>> {
  const { project, canvases } = capture.aggregate;
  const paths = new Set<string>();
  const identities = new Set([project.id, ...canvases.map((item) => item.id),
    ...rows.retired.filter((item) => item.kind === 'canvas').map((item) => item.id)]);
  for (const id of identities) {
    const rootRef = canvases.find((item) => item.id === id)?.storageRootRef ?? project.storageRootRef;
    const collect = (value: unknown) => {
      for (const path of collectNativeStorageReferences(value, roots, rootRef)) paths.add(path);
    };
    const conversations = [...await getProjectConversations(id), ...await getTrashConversations(id)];
    for (const conversation of conversations) {
      let offset = 0;
      while (true) {
        const page = await getConversationMessages(conversation.id, offset, 200);
        collect(page.messages);
        offset += page.messages.length;
        if (offset >= page.total) break;
        if (!page.messages.length) throw new Error('节点回收的消息引用读取不完整');
      }
    }
  }
  return paths;
}

async function resolveRoots(capture: Capture, canvasId: string): Promise<Map<string, string>> {
  const { project } = capture.aggregate;
  const roots = new Map<string, string>();
  for (const binding of project.storageBindings) {
    const root = binding.rootRef === project.storageRootRef
      ? await getProjectDataDir(canvasId)
      : await invoke<string>('resolve_native_project_media_subroot', {
        projectId: project.id, rootRef: binding.rootRef, create: false,
      });
    if (typeof root !== 'string' || !root) throw new Error('节点回收的素材根无法确认');
    roots.set(binding.rootRef, root);
  }
  if (!roots.has(project.storageRootRef)) throw new Error('节点回收的主素材根无法确认');
  return roots;
}

async function collectReferences(capture: Capture, rows: ProjectRows, roots: ReadonlyMap<string, string>,
  canvasId: string, deleted: ReadonlySet<string>): Promise<Set<string>> {
  const aggregate = { ...capture.aggregate, canvases: capture.aggregate.canvases.map((item) => item.id !== canvasId
    ? item : { ...item, nodes: item.nodes.filter((node) => !node || typeof node !== 'object'
      || !('id' in node) || typeof node.id !== 'string' || !deleted.has(node.id)) }) };
  // aggregate.canvas 是同一画布的兼容选择投影；不能重新带入已排除的删除前节点。
  aggregate.canvas = aggregate.canvases.find((item) => item.id === aggregate.canvas?.id) ?? null;
  const references = collectNativeStorageReferences(aggregate, roots, capture.aggregate.project.storageRootRef);
  for (const path of collectNativeStorageReferences([rows.exchange, rows.transfers], roots, capture.aggregate.project.storageRootRef)) {
    references.add(path);
  }
  for (const path of await collectRelatedReferences(capture, rows, roots)) references.add(path);
  return references;
}

export async function createNativeNodeTrashGuard(canvasId: string, deletedNodeIds: readonly string[]): Promise<{
  references: ReadonlySet<string>; isCurrent: () => Promise<boolean>;
}> {
  const owner = getNativeProjectOwner(canvasId);
  if (!owner) throw new Error('节点回收的作品身份尚未登记');
  const [capture, snapshot] = await Promise.all([
    readNativeProjectCapture(owner), readNativeStorageSnapshot(),
  ]);
  const canvas = capture?.aggregate.canvases.find((item) => item.id === canvasId);
  if (!capture || capture.aggregate.project.id !== owner || !canvas || canvas.projectId !== owner) {
    throw new Error('节点回收的画布归属无法确认');
  }
  if (nativeStorageProjectProtected(snapshot, owner)) throw new Error('作品原操作尚未结束，暂时保留节点文件');
  const rows = nativeStorageProjectRows(snapshot, owner);
  const roots = await resolveRoots(capture, canvasId);
  const deleted = new Set(deletedNodeIds);
  const references = await collectReferences(capture, rows, roots, canvasId, deleted);
  return { references, isCurrent: async () => {
    try {
      if (getNativeProjectOwner(canvasId) !== owner) return false;
      const [latest, currentSnapshot] = await Promise.all([
        readNativeProjectCapture(owner), readNativeStorageSnapshot(),
      ]);
      const latestCanvas = latest?.aggregate.canvases.find((item) => item.id === canvasId);
      if (!latest || latest.aggregate.project.id !== owner || !latestCanvas || latestCanvas.projectId !== owner
        || latestCanvas.storageRootRef !== canvas.storageRootRef
        || nativeStorageProjectProtected(currentSnapshot, owner)
        || !configValuesEqual(nativeStorageProjectRows(currentSnapshot, owner), rows)) return false;
      if (!configValuesEqual([...await resolveRoots(latest, canvasId)], [...roots])) return false;
      const currentReferences = await collectReferences(latest, rows, roots, canvasId, deleted);
      if ([...currentReferences].some((path) => !references.has(path))) return false;
      // 允许本次删除的自动保存已经提交；扫描期间发生新变更仍保留原文件。
      const [settled, settledSnapshot] = await Promise.all([
        readNativeProjectCapture(owner), readNativeStorageSnapshot(),
      ]);
      return !!settled && getNativeProjectOwner(canvasId) === owner
        && settled.changeRevision === latest.changeRevision
        && configValuesEqual(settled.aggregate, latest.aggregate)
        && configValuesEqual(nativeStorageProjectRows(settledSnapshot, owner), rows)
        && configValuesEqual([...await resolveRoots(settled, canvasId)], [...roots]);
    } catch { return false; }
  } };
}
