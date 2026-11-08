/**
 * assetUsageService — 查询资产在项目中的使用位置并定位关联节点。
 */
import { t } from '../i18n';
import type { AssetUsageLocation, AssetUsageReport, AssetUsageTarget } from '../types/assetUsage';
import { parseDramaMentionId, type DramaAssetKind } from '../types/dramaAssets';
import { localMediaUrlToPath } from '../utils/mediaUrl';
import { getBaseDir, getProjectDataDir, joinPath } from './fileService';
import { invoke } from '@tauri-apps/api/core';
import { configValuesEqual } from './configPatch';
import { listProjectCatalog } from './projectModelRouter';
import { readNativeProjectCapture, listNativeRetiredCanvasIds, type NativeProjectAggregate } from './indexedDb/nativeProjectRepository';
import { projectNativeCatalogEntry, type NativeProjectViewItem } from '../store/nativeProjectView';
import {
  getProjectById, getAllGlobalCharacters, getAllGlobalDramaAssets,
  getHistoryEntriesPage, getProjectConversations, getTrashConversations, getConversationMessages,
  getProjectAgentTasks, listVideoEditorProjectsByProject, getAllWorkflows, getAllPresets,
  getAssetImageRecords,
  type HistoryPageCursor,
} from './indexedDbService';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export const assetUsagePathKey = (value: string) => {
  const path = (localMediaUrlToPath(value) ?? value).replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
};
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException(t('素材查询已取消'), 'AbortError'); };

/** 只匹配稳定身份、精确路径及真实 @drama 协议，不按名称猜测。 */
export function matchesAssetUsage(value: unknown, target: AssetUsageTarget | readonly AssetUsageTarget[], context: {
  root?: string; ownerId?: string; global?: boolean; nodeIds?: ReadonlySet<string>;
  projectKinds?: ReadonlyMap<string, DramaAssetKind>; globalKinds?: ReadonlyMap<string, DramaAssetKind>;
  projectAssets?: ReadonlyMap<string, unknown>; globalAssets?: ReadonlyMap<string, unknown>; nodes?: ReadonlyMap<string, unknown>;
} = {}): boolean {
  if (!('kind' in target)) return target.some((entry) => matchesAssetUsage(value, entry, context));
  const seen = new WeakSet<object>();
  const visit = (item: unknown): boolean => {
    if (typeof item === 'string') {
      if (target.kind === 'file') {
        if (assetUsagePathKey(item) === assetUsagePathKey(target.path)) return true;
        for (const match of item.matchAll(/@asset\{([^}\r\n]+)\}/g)) {
          try { if (assetUsagePathKey(decodeURIComponent(match[1])) === assetUsagePathKey(target.path)) return true; }
          catch { /* 损坏 token 不按显示名或部分路径猜测。 */ }
        }
        for (const match of item.matchAll(/@\{([^:}\r\n]+):[^}\r\n]+\}/g)) if (context.nodeIds?.has(match[1])) return true;
        for (const match of item.matchAll(/@drama\{([^:}\r\n]+):[^}\r\n]*\}/g)) {
          const parsed = parseDramaMentionId(match[1]);
          const global = parsed.assetId.startsWith('global/');
          const asset = record((global ? context.globalAssets : context.projectAssets)?.get(global ? parsed.assetId.slice(7) : parsed.assetId));
          if (!asset.id) continue;
          const members = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
          let picks: Record<string, unknown>[];
          if (parsed.voiceClipId !== undefined) picks = members(asset.voiceClips).filter((voice) => voice.id === parsed.voiceClipId);
          else if (parsed.actionId !== undefined) picks = members(members(asset.actions).find((action) => action.id === parsed.actionId)?.media)
            .filter((media) => media.id === parsed.actionMediaId);
          else {
            const references = members(asset.referenceImages);
            if (parsed.mergeAll) picks = references.length ? references : [asset];
            else if (parsed.referenceImageId !== undefined) picks = references.filter((reference) => reference.id === parsed.referenceImageId);
            else picks = [references.find((reference) => reference.id === asset.primaryReferenceImageId) ?? references[0] ?? asset];
          }
          for (const pick of picks) {
            const plainImage = parsed.referenceImageId === undefined && !parsed.mergeAll
              && parsed.voiceClipId === undefined && parsed.actionId === undefined;
            const sourceId = parsed.voiceClipId !== undefined || parsed.actionId !== undefined ? undefined
              : pick.sourceNodeId ?? (plainImage ? asset.imageNodeId : undefined);
            const node = !global && typeof sourceId === 'string' ? record(record(context.nodes?.get(sourceId)).data) : {};
            const resolved = parsed.voiceClipId !== undefined ? node.audioUrl : node.imageUrl || node.thumbnailUrl;
            const fallback = pick === asset ? { assetId: asset.assetId, imageAssetId: asset.imageAssetId,
              relativePath: asset.relativePath, imageRelativePath: asset.imageRelativePath, imageUrl: asset.imageUrl } : pick;
            const value = resolved ? { assetId: node.assetId, filePath: node.filePath, url: resolved } : fallback;
            if (matchesAssetUsage(value, target, { root: context.root, global })) return true;
          }
        }
        return false;
      }
      for (const match of item.matchAll(/@drama\{([^:}\r\n]+):[^}\r\n]*\}/g)) {
        const id = parseDramaMentionId(match[1]).assetId;
        if (target.scope === 'global' ? id === `global/${target.assetId}` && context.globalKinds?.get(target.assetId) === target.assetKind
          : !id.startsWith('global/') && id === target.assetId && context.ownerId === target.ownerId
            && context.projectKinds?.get(target.assetId) === target.assetKind) return true;
      }
      return false;
    }
    if (!item || typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) return item.some(visit);
    const data = record(item);
    if (target.kind === 'file') {
      if (target.assetId && (data.assetId === target.assetId || data.imageAssetId === target.assetId)) return true;
      for (const relative of [data.relativePath, data.imageRelativePath]) {
        if (context.root && typeof relative === 'string' && !relative.split(/[\\/]/).some((part) => !part || part === '..' || part === '.' || part.includes(':'))
          && assetUsagePathKey(joinPath(context.root, relative)) === assetUsagePathKey(target.path)) return true;
      }
      if (!context.global && context.nodeIds && [data.imageNodeId, data.sourceNodeId].some((id) => typeof id === 'string' && context.nodeIds!.has(id))) return true;
    } else {
      if (data.kind === 'character' && target.assetKind === 'prop'
        && Array.isArray(data.weaponIds) && data.weaponIds.includes(target.assetId)
        && (target.scope === 'global' ? context.global === true : context.global !== true && context.ownerId === target.ownerId)) return true;
      if (data.dramaAssetId === target.assetId && (data.dramaAssetKind === undefined || data.dramaAssetKind === target.assetKind)
        && target.scope === 'project' && context.ownerId === target.ownerId) return true;
      for (const item of Array.isArray(data.characterLibraryLinks) ? data.characterLibraryLinks : []) {
        const link = record(item);
        if (link.characterId === target.assetId && target.assetKind === 'character' && link.scope === target.scope
          && (target.scope === 'global' || context.ownerId === target.ownerId)) return true;
      }
    }
    return Object.values(data).some(visit);
  };
  return visit(value);
}

/** 读取失败即失败，不将未知持久化记录当作“未使用”。 */
export async function loadAssetUsage(target: AssetUsageTarget | readonly AssetUsageTarget[], signal?: AbortSignal): Promise<AssetUsageReport> {
  check(signal);
  const targets = 'kind' in target ? [target] : target;
  if (targets.some((entry) => entry.kind === 'creative' && entry.scope === 'project' && !entry.ownerId)) throw new Error(t('项目资产缺少所属项目，请重新选择'));
  const { useAppStore } = await import('../store/useAppStore');
  const initial = useAppStore.getState();
  const catalog = await listProjectCatalog(); check(signal);
  const nativeCatalog = catalog.filter((entry): entry is Extract<typeof entry, { dataModel: 'native' }> => entry.dataModel === 'native');
  const nativeViews = nativeCatalog.flatMap(projectNativeCatalogEntry);
  const nativeById = new Map(nativeViews.map((project) => [project.id, project]));
  for (const project of initial.projects) {
    const binding = (project as NativeProjectViewItem).nativeView, catalogView = nativeById.get(project.id);
    if (binding ? !catalogView || !configValuesEqual(binding, catalogView.nativeView) : !!catalogView) {
      throw new Error(t('项目引用读取不完整，请重试'));
    }
  }
  const summaries = catalog.filter((entry) => entry.dataModel === 'legacy').map((entry) => entry.project);
  const projects = new Map([...summaries, ...nativeViews, ...initial.projects].filter((project) => project.id !== 'default').map((project) => [project.id, project]));
  const nativeCaptures = new Map<string, { aggregate: NativeProjectAggregate; changeRevision: number; retired: string[] }>();
  for (const entry of nativeCatalog) {
    const [capture, retired] = await Promise.all([readNativeProjectCapture(entry.project.id), listNativeRetiredCanvasIds(entry.project.id)]); check(signal);
    if (!capture || !configValuesEqual(capture.aggregate.project, entry.project)
      || !configValuesEqual(capture.aggregate.episodes, [...entry.episodes].sort((a, b) => a.orderRank - b.orderRank))
      || !configValuesEqual([...capture.aggregate.canvases.map((canvas) => canvas.id)].sort(), [...entry.canvasIds].sort())) {
      throw new Error(t('项目引用读取不完整，请重试'));
    }
    nativeCaptures.set(entry.project.id, { aggregate: capture.aggregate, changeRevision: capture.changeRevision, retired });
  }
  const storedProjects = new Map<string, { nodes: unknown[]; dramaAssets?: unknown }>();
  for (const project of projects.values()) {
    const binding = (project as NativeProjectViewItem).nativeView;
    if (binding) {
      const aggregate = nativeCaptures.get(binding.projectId)?.aggregate;
      const canvas = binding.canvasId ? aggregate?.canvases.find((item) => item.id === binding.canvasId) : undefined;
      if (!aggregate || binding.canvasId && (!canvas || canvas.episodeId !== binding.episodeId)
        || !binding.canvasId && (aggregate.project.kind !== 'series' || project.id !== aggregate.project.id)) {
        throw new Error(t('项目引用读取不完整，请重试'));
      }
      storedProjects.set(project.id, { nodes: canvas?.nodes ?? [], dramaAssets: aggregate.content.dramaAssets });
    } else {
      const stored = await getProjectById(project.id); check(signal);
      if (!stored || !Array.isArray(stored.nodes)) throw new Error(t('项目引用读取不完整，请重试'));
      storedProjects.set(project.id, { nodes: stored.nodes, dramaAssets: stored.dramaAssets });
    }
  }
  const storedGlobals = [...await getAllGlobalCharacters(), ...await getAllGlobalDramaAssets()]; check(signal);
  const kinds = (library: unknown): Map<string, DramaAssetKind> => {
    const result = new Map<string, DramaAssetKind>();
    for (const [key, kind] of [['characters', 'character'], ['scenes', 'scene'], ['props', 'prop']] as const) {
      for (const item of (Array.isArray(record(library)[key]) ? record(library)[key] : []) as unknown[]) {
        const card = record(item); if (typeof card.id === 'string' && !result.has(card.id)) result.set(card.id, kind);
      }
    }
    return result;
  };
  const globalKinds = kinds({ characters: [...initial.globalCharacters, ...storedGlobals.filter((card) => card.kind === 'character')],
    scenes: [...initial.globalScenes, ...storedGlobals.filter((card) => card.kind === 'scene')], props: [...initial.globalProps, ...storedGlobals.filter((card) => card.kind === 'prop')] });
  const assetMap = (library: unknown) => {
    const result = new Map<string, unknown>();
    for (const key of ['characters', 'scenes', 'props']) for (const item of (Array.isArray(record(library)[key]) ? record(library)[key] : []) as unknown[]) {
      const card = record(item); if (typeof card.id === 'string' && !result.has(card.id)) result.set(card.id, card);
    }
    return result;
  };
  const globalAssets = assetMap({ characters: [...initial.globalCharacters, ...storedGlobals.filter((card) => card.kind === 'character')],
    scenes: [...initial.globalScenes, ...storedGlobals.filter((card) => card.kind === 'scene')], props: [...initial.globalProps, ...storedGlobals.filter((card) => card.kind === 'prop')] });
  const locations = new Map<string, AssetUsageLocation>();
  const add = (location: AssetUsageLocation) => { const previous = locations.get(location.key); locations.set(location.key, previous?.live ? previous : location); };
  const nativeRoots = new Map<string, Map<string, string>>();
  const needsFileRoots = targets.some((item) => item.kind === 'file');
  for (const [ownerId, capture] of nativeCaptures) {
    const view = nativeViews.find((item) => item.nativeView.projectId === ownerId);
    if (!view) throw new Error(t('项目引用读取不完整，请重试'));
    const primary = await getProjectDataDir(view.id); check(signal);
    if (!primary && needsFileRoots) throw new Error(t('项目素材目录读取不完整，请重试'));
    const roots = new Map<string, string>();
    if (primary) roots.set(capture.aggregate.project.storageRootRef, primary);
    for (const binding of capture.aggregate.project.storageBindings) if (binding.rootRef !== capture.aggregate.project.storageRootRef && needsFileRoots) {
      const root = await invoke<string>('resolve_native_project_media_subroot', { projectId: ownerId, rootRef: binding.rootRef, create: false }); check(signal);
      if (!root) throw new Error(t('项目素材目录读取不完整，请重试'));
      roots.set(binding.rootRef, root);
    }
    nativeRoots.set(ownerId, roots);
  }
  const rootsByProject = new Map<string, string | undefined>();
  for (const project of projects.values()) {
    check(signal);
    const stored = storedProjects.get(project.id)!;
    const binding = (project as NativeProjectViewItem).nativeView;
    const aggregate = binding ? nativeCaptures.get(binding.projectId)?.aggregate : undefined;
    const canvas = binding?.canvasId ? aggregate?.canvases.find((item) => item.id === binding.canvasId) : undefined;
    const roots = binding ? nativeRoots.get(binding.projectId) : undefined;
    const primaryRoot = aggregate ? roots?.get(aggregate.project.storageRootRef) : undefined;
    const root = binding ? (canvas ? roots?.get(canvas.storageRootRef) : primaryRoot) : await getProjectDataDir(project.id); check(signal);
    if (binding && needsFileRoots && !root) throw new Error(t('项目素材目录读取不完整，请重试'));
    rootsByProject.set(project.id, root ?? undefined);
    const ownerId = project.parentId ?? project.id;
    const library = record(storedProjects.get(ownerId)).dramaAssets;
    const context = { root: root ?? undefined, ownerId, projectKinds: kinds(library), globalKinds, globalAssets, projectAssets: assetMap(library),
      nodes: new Map((stored.nodes as unknown[]).map((node) => [String(record(node).id), node] as const)), nodeIds: new Set<string>() };
    const outputIds = (nodes: unknown[]) => new Set(nodes.filter((item) => {
      const node = record(item); const data = record(node.data); const type = String(node.type ?? data.type ?? '');
      const media = type.includes('video') ? { videoUrl: data.videoUrl } : type.includes('audio') ? { audioUrl: data.audioUrl } : { imageUrl: data.imageUrl, thumbnailUrl: data.thumbnailUrl };
      return matchesAssetUsage({ assetId: data.assetId, filePath: data.filePath, relativePath: data.relativePath, ...media }, target, context);
    }).map((item) => String(record(item).id)));
    const scanNodes = (nodes: unknown[], live = false, projectKinds = context.projectKinds) => {
      const matched = outputIds(nodes);
      const projectAssets = live ? assetMap(useAppStore.getState().dramaAssets) : context.projectAssets;
      const sourceNodes = new Map(nodes.map((node) => [String(record(node).id), node] as const));
      if (!live) context.nodeIds = matched;
      for (const item of nodes) {
        const node = record(item); const data = record(node.data);
        if (typeof node.id !== 'string' || !matchesAssetUsage(data, target, { ...context, projectKinds, projectAssets, nodes: sourceNodes, nodeIds: matched })) continue;
        add({ key: `node:${project.id}:${node.id}`, kind: 'node', projectId: project.id, projectName: project.name,
          nodeId: node.id, name: typeof data.label === 'string' ? data.label : node.id, live });
      }
      return matched;
    };
    const storedNodeIds = scanNodes(stored.nodes as unknown[]);
    const latest = useAppStore.getState();
    const liveNodeIds = latest.currentProjectId === project.id ? scanNodes(latest.nodes, true, kinds(latest.dramaAssets)) : new Set<string>();
    const scanCards = (library: unknown, nodeIds: ReadonlySet<string>, live = false) => {
      for (const kind of ['characters', 'scenes', 'props']) for (const item of (Array.isArray(record(library)[kind]) ? record(library)[kind] : []) as unknown[]) {
        const card = record(item);
        if (!matchesAssetUsage(card, target, { ...context, root: binding ? primaryRoot : context.root, nodeIds })) continue;
        add({ key: `creative:${ownerId}:${kind}:${String(card.id)}`, kind: 'creative', projectId: ownerId,
          projectName: projects.get(ownerId)?.name ?? project.name, name: String(card.name ?? card.id), live });
      }
    };
    scanCards(library, storedNodeIds);
    if (latest.currentProjectId === project.id) scanCards(latest.dramaAssets, liveNodeIds, true);
    if (aggregate && binding) {
      const body = binding.episodeId ? aggregate.episodeContents.find((item) => item.episodeId === binding.episodeId) : aggregate.content.standaloneCreative;
      const projectContent = binding.episodeId ? undefined : { ...aggregate.content, dramaAssets: undefined };
      const extras = [canvas?.edges, canvas?.groups, body, projectContent, aggregate.project.defaultSettings];
      // 正文、稿件或设置可绑定到不同素材根；逐根扫描以避免误判为未引用。
      if ([...(roots?.values() ?? []), undefined].some((candidate) => matchesAssetUsage(extras, target, { ...context, root: candidate }))) {
        add({ key: `native-content:${project.id}`, kind: 'creative', projectId: project.id, projectName: project.name, name: t('项目资料') });
      }
    }
    let cursor: HistoryPageCursor | null = null;
    do {
      const page = await getHistoryEntriesPage(project.id, 200, cursor); check(signal);
      for (const entry of page.records) if (matchesAssetUsage(entry, target, context)) add({ key: `history:${entry.id}`, kind: 'history',
        projectId: project.id, projectName: project.name, nodeId: entry.nodeId, name: entry.nodeLabel || entry.nodeId });
      if (!page.hasMore) break;
      if (!page.nextCursor) throw new Error(t('项目引用读取不完整，请重试'));
      cursor = page.nextCursor;
    } while (cursor);
    const conversations = [...await getProjectConversations(project.id), ...await getTrashConversations(project.id)]; check(signal);
    for (const conversation of conversations) {
      let offset = 0;
      while (true) {
        const page = await getConversationMessages(conversation.id, offset, 200); check(signal);
        for (const message of page.messages) if (matchesAssetUsage(message, target, context)) add({ key: `chat:${message.id}`, kind: 'chat',
          projectId: project.id, projectName: project.name, name: conversation.title || t('对话记录') });
        offset += page.messages.length;
        if (offset >= page.total) break;
        if (!page.messages.length) throw new Error(t('项目引用读取不完整，请重试'));
      }
    }
    for (const task of await getProjectAgentTasks(project.id)) if (matchesAssetUsage(task, target, context)) add({ key: `task:${task.id}`, kind: 'task',
      projectId: project.id, projectName: project.name, name: t('助手任务') });
    for (const editor of await listVideoEditorProjectsByProject(project.id)) if (matchesAssetUsage(editor, target, context)) add({ key: `video-editor:${editor.id}`, kind: 'video-editor',
      projectId: project.id, projectName: project.name, nodeId: editor.nodeId, name: t('剪辑工程') });
  }
  // 已删除画布的业务正文已移除，但历史、会话和任务仍可能引用素材。
  for (const [ownerId, capture] of nativeCaptures) {
    const view = nativeViews.find((item) => item.nativeView.projectId === ownerId)!;
    const historyOwners = [...capture.retired, ...(!projects.has(ownerId) ? [ownerId] : [])];
    const roots = [...(nativeRoots.get(ownerId)?.values() ?? []), undefined];
    for (const id of historyOwners) {
      const matches = (value: unknown) => {
        if (capture.retired.includes(id)) {
          const pending = [value], seen = new WeakSet<object>(); let visited = 0;
          while (pending.length) {
            const item = pending.pop();
            if (++visited > 1_000_000) throw new Error(t('已删除画布的历史引用无法确认，请先核对'));
            if (typeof item === 'string' && /@\{[^:}\r\n]+:[^}\r\n]+\}/.test(item)) {
              throw new Error(t('已删除画布的历史引用无法确认，请先核对'));
            }
            if (!item || typeof item !== 'object' || seen.has(item)) continue;
            seen.add(item); pending.push(...Object.values(item));
          }
        }
        return roots.some((root) => matchesAssetUsage(value, target, { root,
          ownerId: capture.aggregate.project.kind === 'standalone' ? view.id : ownerId,
          projectKinds: kinds(capture.aggregate.content.dramaAssets), projectAssets: assetMap(capture.aggregate.content.dramaAssets),
          globalKinds, globalAssets }));
      };
      let cursor: HistoryPageCursor | null = null;
      do {
        const page = await getHistoryEntriesPage(id, 200, cursor); check(signal);
        for (const entry of page.records) if (matches(entry)) add({ key: `history:${entry.id}`, kind: 'history',
          projectId: view.id, projectName: view.name, name: entry.nodeLabel || entry.nodeId });
        if (!page.hasMore) break;
        if (!page.nextCursor) throw new Error(t('项目引用读取不完整，请重试'));
        cursor = page.nextCursor;
      } while (cursor);
      const conversations = [...await getProjectConversations(id), ...await getTrashConversations(id)]; check(signal);
      for (const conversation of conversations) {
        let offset = 0;
        while (true) {
          const page = await getConversationMessages(conversation.id, offset, 200); check(signal);
          for (const message of page.messages) if (matches(message)) add({ key: `chat:${message.id}`, kind: 'chat',
            projectId: view.id, projectName: view.name, name: conversation.title || t('对话记录') });
          offset += page.messages.length;
          if (offset >= page.total) break;
          if (!page.messages.length) throw new Error(t('项目引用读取不完整，请重试'));
        }
      }
      for (const task of await getProjectAgentTasks(id)) if (matches(task)) add({ key: `task:${task.id}`, kind: 'task',
        projectId: view.id, projectName: view.name, name: t('助手任务') });
      for (const editor of await listVideoEditorProjectsByProject(id)) if (matches(editor)) add({ key: `video-editor:${editor.id}`, kind: 'video-editor',
        projectId: view.id, projectName: view.name, name: t('剪辑工程') });
    }
  }
  const latest = useAppStore.getState();
  if (latest.currentProjectId === 'default') {
    for (const node of latest.nodes) if (matchesAssetUsage(node.data, target, { ownerId: 'default' })) add({
      key: `node:default:${node.id}`, kind: 'node', projectId: 'default', projectName: latest.projectName,
      nodeId: node.id, name: node.data.label || node.id, live: true,
    });
  }
  const liveOwner = latest.projects.find((project) => project.id === latest.currentProjectId)?.parentId ?? latest.currentProjectId ?? undefined;
  const liveRoot = latest.currentProjectId ? rootsByProject.get(latest.currentProjectId) ?? await getProjectDataDir(latest.currentProjectId) : null;
  const liveContext = { root: liveRoot ?? undefined, ownerId: liveOwner, projectKinds: kinds(latest.dramaAssets), globalKinds,
    projectAssets: assetMap(latest.dramaAssets), globalAssets };
  for (const [index, snapshot] of latest.history.entries()) {
    const context = { ...liveContext, nodes: new Map(snapshot.nodes.map((source) => [source.id, source] as const)) };
    for (const node of snapshot.nodes) {
      if (!matchesAssetUsage(node.data, target, context)) continue;
      add({ key: `undo:${index}:${node.id}`, kind: 'history', projectId: latest.currentProjectId ?? undefined,
        projectName: latest.projectName, name: `${t('画布撤销记录')} · ${node.data.label || node.id}`, live: true });
    }
  }
  for (const message of latest.messages) if (matchesAssetUsage(message, target, liveContext)) add({
    key: `chat:${message.id}`, kind: 'chat', projectId: latest.currentProjectId ?? undefined, projectName: latest.projectName, name: t('对话记录'), live: true,
  });
  const globalCards = [...storedGlobals, ...latest.globalCharacters, ...latest.globalScenes, ...latest.globalProps]; check(signal);
  for (const card of globalCards) if (matchesAssetUsage(card, target, { global: true, globalKinds })) add({ key: `global:${card.kind}:${card.id}`,
    kind: 'creative', name: card.name, projectName: t('全局创作资产') });
  for (const workflow of await getAllWorkflows()) if (matchesAssetUsage(workflow, target, { globalKinds })) add({ key: `workflow:${workflow.id}`, kind: 'workflow', name: workflow.name });
  for (const preset of await getAllPresets()) if (matchesAssetUsage(preset, target, { globalKinds })) add({ key: `preset:${preset.id}`, kind: 'preset', name: preset.name });
  for (const workflow of latest.workflows) if (matchesAssetUsage(workflow, target, { globalKinds })) add({ key: `workflow:${workflow.id}`, kind: 'workflow', name: workflow.name, live: true });
  for (const preset of latest.userPresets) if (matchesAssetUsage(preset, target, { globalKinds })) add({ key: `preset:${preset.id}`, kind: 'preset', name: preset.name, live: true });
  const base = await getBaseDir(); check(signal);
  for (const details of await getAssetImageRecords(signal)) if (matchesAssetUsage(details, target, { root: base ?? undefined, globalKinds })) {
    add({ key: `image-details:${details.id}`, kind: 'image-details', name: details.fileName });
  }
  check(signal);
  for (const [id, captured] of nativeCaptures) {
    const [latestCapture, retired] = await Promise.all([readNativeProjectCapture(id), listNativeRetiredCanvasIds(id)]); check(signal);
    if (!latestCapture || latestCapture.changeRevision !== captured.changeRevision
      || !configValuesEqual([...retired].sort(), [...captured.retired].sort())) throw new Error(t('项目引用已变化，请刷新使用位置'));
  }
  if (useAppStore.getState().currentProjectId !== initial.currentProjectId) throw new Error(t('画布项目已变化，请刷新使用位置'));
  const result = [...locations.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { locations: result, signature: JSON.stringify(result.map(({ key }) => key)) };
}

export async function locateAssetUsage(location: AssetUsageLocation, signal?: AbortSignal): Promise<void> {
  if (!location.projectId || !location.nodeId) return;
  check(signal);
  const { useAppStore } = await import('../store/useAppStore');
  const state = useAppStore.getState();
  const opened = state.currentProjectId === location.projectId ? location.projectId : await state.switchProject(location.projectId, { signal });
  check(signal);
  const latest = useAppStore.getState();
  if (opened !== location.projectId || latest.currentProjectId !== location.projectId || !latest.nodes.some((node) => node.id === location.nodeId)) throw new Error(t('引用节点已不存在，请刷新使用位置'));
  latest.setAssetsPanelOpen(false);
  window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId: location.nodeId, pulse: true } }));
}
