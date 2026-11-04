/** 归档业务适配：持久化记录与跨设备快照之间的唯一转换入口。 */
import type { ProjectSaveData } from './storageService';
import type { ProjectExchangeEntity, ProjectExchangeEntityKind, ProjectExchangeIdentity, ProjectExchangeMedia,
  ProjectExchangeObject, ProjectExchangeReference, ProjectExchangeSnapshot, ProjectExchangeState, ProjectExchangeValue } from '../types/projectExchange';
import { parseProjectExchangeSnapshot, projectExchangeEntityKey, serializeProjectExchangeValue } from './projectExchangeFormat';
import { parseDramaMentionId } from '../types/dramaAssets';

export interface ArchiveAssetDigest { path: string; bytes: number; sha256: string }
const FILE_TOKEN = 'exchange-file:';
const omitted = new Set(['filePath', 'imageFilePath', 'dataFolder', 'snapshot', 'createdAt', 'updatedAt',
  'selected', 'dragging', 'resizing', 'measured', 'internals', 'positionAbsolute', 'assetId', 'imageAssetId', 'assetSource',
  'taskId', 'agentTaskId', 'abortController', 'progress', 'error', 'isGenerating', 'isLoading', 'generationStatus',
  'pollTaskId', 'requestId', 'apiKey', 'apiKeyRef', 'token', 'accessToken', 'refreshToken', 'password', 'authorization',
  'generationStartedAt', 'videoTaskState', 'mediaTaskState', 'mediaTaskStage', 'runninghubStage', 'workflowApiStage',
  'comfyH3MemoryApplied', 'thumbnailUrl', 'sourceUrl', 'artifactId', 'mediaVersion', 'volcengineBinding']);
const mediaUrls = new Set(['imageUrl', 'videoUrl', 'audioUrl', 'url']);
const textNodeTypes = new Set(['ai-text', 'source-text', 'ai-markdown']);
const nodeReferenceFields = new Set(['sourceNodeId', 'imageNodeId', 'nodeId', 'targetNodeId']);
const historicalAssetKinds = new Set<ProjectExchangeEntityKind>(['character', 'scene', 'prop', 'referenceImage',
  'voiceClip', 'action', 'actionMedia', 'imageMetadata']);
const collections: Array<[string, ProjectExchangeEntityKind]> = [['referenceImages', 'referenceImage'], ['voiceClips', 'voiceClip'],
  ['actions', 'action'], ['media', 'actionMedia'], ['shotlistRows', 'shot']];
export const exchangeObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const exchangeEqual = (a: unknown, b: unknown): boolean => a === undefined || b === undefined ? a === b : serializeProjectExchangeValue(a) === serializeProjectExchangeValue(b);
export function safeExchangePath(path: string): string {
  const normalized = path.normalize('NFC').replace(/\\/g, '/');
  if (!normalized || normalized.length > 1024 || normalized.split('/').some((part) => !part || part === '.' || part === '..'
    || /[<>:"|?*]/.test(part) || [...part].some((character) => character.charCodeAt(0) < 32)
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error('项目素材包含不安全的相对路径');
  }
  // 校验按 NFC，真实落盘名称保持原样，避免 Linux/NFD 文件被改指向不存在的 NFC 路径。
  return path.replace(/\\/g, '/');
}
function media(asset: ArchiveAssetDigest): ProjectExchangeMedia {
  const extension = asset.path.split('.').pop()?.toLowerCase() ?? 'bin';
  const normalizedExtension = /^[a-z0-9]{1,16}$/.test(extension) ? extension : 'bin';
  return { id: `${asset.sha256}_${normalizedExtension}`, sha256: asset.sha256, bytes: asset.bytes, extension: normalizedExtension,
    kind: /^(png|jpe?g|webp|gif|bmp|avif)$/.test(extension) ? 'image' : /^(mp4|webm|mov|mkv)$/.test(extension) ? 'video'
      : /^(mp3|wav|ogg|flac|m4a|aac)$/.test(extension) ? 'audio' : 'file' };
}

/** 字段中的引用由此重建；合并后不拼接旧 references 数组。 */
export function exchangeReferences(entity: ProjectExchangeEntity, all: readonly ProjectExchangeEntity[], root: string): ProjectExchangeReference[] {
  const result = new Map<string, ProjectExchangeReference>();
  const add = (kind: ProjectExchangeEntityKind, scopeId: string, id: string) => {
    const ref = { kind, scopeId, id }; result.set(projectExchangeEntityKey(ref), ref);
  };
  const node = (id: string) => {
    // 资产可以保留已删除源节点的出处；这类出处不是执行引用。
    if (all.some((item) => item.kind === 'node' && item.id === id && item.scopeId === entity.scopeId)) add('node', entity.scopeId, id);
  };
  const child = (owner: ProjectExchangeEntity, field: string, kind: ProjectExchangeEntityKind, id: string | undefined) => {
    const ids = owner.data[field];
    if (!id || !Array.isArray(ids) || !ids.includes(id)) return undefined;
    return all.find((item) => item.kind === kind && item.scopeId === root && item.id === id);
  };
  const walk = (value: ProjectExchangeValue, key = '', fieldPath = ''): void => {
    if (typeof value === 'string') {
      if (['relativePath', 'imageRelativePath', 'directorCaptureRelativePaths'].includes(key) && !value.startsWith(FILE_TOKEN)) {
        throw new Error('规范快照包含未绑定的素材路径');
      }
      if (value.startsWith(FILE_TOKEN)) add('file', root, value.slice(FILE_TOKEN.length));
      if (nodeReferenceFields.has(key)) node(value);
      for (const match of value.matchAll(/@\{([^:{}]+):[^}]*\}/g)) {
        // 共享资产保存的出图提示词是历史出处，与 imageNodeId 一样允许来源节点已删除。
        // 画布节点和镜头仍保留执行依赖，不能通过归档丢掉当前输入。
        if (historicalAssetKinds.has(entity.kind)) node(match[1]);
        else add('node', entity.scopeId, match[1]);
      }
      for (const match of value.matchAll(/@drama\{([^:{}]+):([^}]*)\}/g)) {
        const mention = parseDramaMentionId(match[1]);
        const target = all.find((item) => ['character', 'scene', 'prop'].includes(item.kind) && item.id === mention.assetId && item.scopeId === root);
        if (target) {
          add(target.kind, root, target.id);
          // 精确选图/音色/动作是当前执行输入；历史资产提示词保留既有出处边界。
          // 只补校验，不改合法旧 v3 的 references 和摘要。
          if (!historicalAssetKinds.has(entity.kind)) {
            let valid = true;
            if (mention.referenceImageId !== undefined) valid = !!child(target, 'referenceImagesIds', 'referenceImage', mention.referenceImageId);
            if (mention.voiceClipId !== undefined) valid = target.kind === 'character' && !!child(target, 'voiceClipsIds', 'voiceClip', mention.voiceClipId);
            if (mention.actionId !== undefined) {
              const action = target.kind === 'character' ? child(target, 'actionsIds', 'action', mention.actionId) : undefined;
              valid = !!action && !!child(action, 'mediaIds', 'actionMedia', mention.actionMediaId);
            }
            if (!valid) throw new Error(`项目引用的创作素材缺失或归属不一致；引用位置：${exchangeSourceLocation(entity, all, root)}；引用字段：${fieldPath}。请重新选择素材后重试。`);
          }
        } else if (!mention.assetId.startsWith('global/')) {
          throw new Error(`项目引用的创作资产缺失：${match[2] || '未命名资产'}（ID：${mention.assetId}）；引用位置：${exchangeSourceLocation(entity, all, root)}；引用字段：${fieldPath}。请移除失效引用或重新选择资产后重试。`);
        }
      }
    } else if (Array.isArray(value)) value.forEach((item, index) => walk(item, key, `${fieldPath}[${index}]`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([field, item]) => walk(item, field, fieldPath ? `${fieldPath}.${field}` : field));
  };
  walk(entity.data);
  if (entity.kind === 'project' && typeof entity.data.parentId === 'string') add('project', entity.data.parentId, entity.data.parentId);
  if (entity.kind === 'node' && typeof entity.data.parentId === 'string') add('node', entity.scopeId, entity.data.parentId);
  if (entity.kind === 'edge') for (const field of ['source', 'target']) if (typeof entity.data[field] === 'string') add('node', entity.scopeId, entity.data[field]);
  for (const [field, kind] of collections) {
    const ids = entity.data[`${field}Ids`];
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') add(kind, entity.scopeId, id);
  }
  for (const [field, kind] of [['nodes', 'node'], ['edges', 'edge'], ['groups', 'group'], ['characters', 'character'],
    ['scenes', 'scene'], ['props', 'prop']] as const) {
    const ids = entity.data[`${field}Ids`];
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') add(kind, entity.scopeId, id);
  }
  if (entity.kind === 'group' && Array.isArray(entity.data.nodeIds)) for (const id of entity.data.nodeIds) if (typeof id === 'string') add('node', entity.scopeId, id);
  if (typeof entity.data.primaryReferenceImageId === 'string') add('referenceImage', entity.scopeId, entity.data.primaryReferenceImageId);
  return [...result.values()];
}

export function validateExchangeDomain(snapshot: ProjectExchangeSnapshot): ProjectExchangeSnapshot {
  const entities = snapshot.entities.map((entity) => ({ ...entity, references: exchangeReferences(entity, snapshot.entities, snapshot.rootProjectId) }));
  let parsed: ProjectExchangeSnapshot;
  try { parsed = parseProjectExchangeSnapshot({ ...snapshot, entities }); }
  catch (error) {
    if (!(error instanceof Error) || !exchangeObject(error.cause) || typeof error.cause.fieldPath !== 'string') throw error;
    const entityIndex = /^entities\[(\d+)\]/.exec(error.cause.fieldPath);
    const mediaIndex = /^media\[(\d+)\]/.exec(error.cause.fieldPath);
    const entity = entityIndex ? entities[Number(entityIndex[1])] : mediaIndex
      ? entities.find((item) => item.kind === 'file' && item.data.mediaId === snapshot.media[Number(mediaIndex[1])]?.id) : undefined;
    if (!entity) throw error;
    error.message += `；所属位置：${exchangeSourceLocation(entity, entities, snapshot.rootProjectId)}`;
    throw error;
  }
  const childOwners = new Map<string, string>();
  for (const entity of entities) for (const [field, kind] of collections) {
    const ids = entity.data[`${field}Ids`];
    if (ids === undefined) continue;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
      throw new Error('子实体列表包含重复或无效身份');
    }
    for (const id of ids as string[]) {
      const key = projectExchangeEntityKey({ kind, scopeId: entity.scopeId, id });
      if (childOwners.has(key)) throw new Error('同一子实体不能同时属于多个对象');
      childOwners.set(key, projectExchangeEntityKey(entity));
    }
  }
  for (const entity of entities.filter((item) => collections.some(([, kind]) => kind === item.kind))) {
    const key = projectExchangeEntityKey(entity), visited = new Set([key]);
    let owner = childOwners.get(key);
    if (!owner) throw new Error('子实体缺少所属对象，请统一父对象和新增/删除选择');
    while (owner) {
      if (visited.has(owner)) throw new Error('子实体归属存在循环');
      visited.add(owner); owner = childOwners.get(owner);
    }
  }
  for (const project of entities.filter((item) => item.kind === 'project')) {
    if (project.id === snapshot.rootProjectId ? project.data.parentId !== undefined : project.data.parentId !== snapshot.rootProjectId) {
      throw new Error('分集归属不一致，请处理项目结构冲突');
    }
    for (const [field, kind] of [['nodes', 'node'], ['edges', 'edge'], ['groups', 'group'], ['characters', 'character'], ['scenes', 'scene'], ['props', 'prop']] as const) {
      const ids = project.data[`${field}Ids`];
      const actual = entities.filter((item) => item.kind === kind && item.scopeId === project.id);
      if (actual.length && (!Array.isArray(ids) || ids.length !== actual.length || new Set(ids).size !== ids.length
        || actual.some((item) => !ids.includes(item.id)))) throw new Error('实体与项目列表不一致，请统一列表顺序和新增/删除选择');
    }
  }
  for (const entity of entities) {
    if (entity.kind === 'node') {
      const seen = new Set([entity.id]); let parent = entity.data.parentId;
      while (typeof parent === 'string') {
        if (seen.has(parent)) throw new Error('分组存在循环，请重新选择分组结构');
        seen.add(parent);
        const owner = entities.find((item) => item.kind === 'node' && item.scopeId === entity.scopeId && item.id === parent);
        if (!owner || owner.data.type !== 'group') throw new Error('节点所属分组不存在');
        parent = owner.data.parentId;
      }
    }
    if (entity.kind === 'group' && !entities.some((node) => node.kind === 'node' && node.scopeId === entity.scopeId && node.id === entity.id)) {
      throw new Error('分组元数据缺少对应画布节点');
    }
  }
  return parsed;
}

export interface ExchangeCapture { snapshot: ProjectExchangeSnapshot; identities: ProjectExchangeIdentity[]; files: Map<string, string> }
function captureSourceLocation(parent: string, kind: string, source: Record<string, unknown>): string {
  const data = exchangeObject(source.data) ? source.data : source;
  const label = [data.label, source.name, source.shotNo].find((value): value is string => typeof value === 'string' && !!value.trim());
  const displayId = kind === '节点' && typeof data.displayId === 'number' && Number.isInteger(data.displayId)
    ? ` #${data.displayId}` : '';
  return `${parent} → ${kind}${displayId}「${label?.trim() || '未命名'}」（ID：${source.id}）`;
}

function exchangeSourceLocation(entity: ProjectExchangeEntity, all: readonly ProjectExchangeEntity[], root: string): string {
  const owner = all.find((item) => item.kind === 'project' && item.id === root);
  const project = all.find((item) => item.kind === 'project' && item.id === entity.scopeId);
  const location = `项目「${owner?.data.name || '未命名'}」${entity.scopeId !== root ? ` → 分集「${project?.data.name || '未命名'}」` : ''}`;
  const labels: Record<ProjectExchangeEntityKind, string> = { project: '项目记录', node: '节点', edge: '连线', group: '分组',
    character: '角色', scene: '场景', prop: '道具', referenceImage: '参考图', voiceClip: '音色', action: '动作',
    actionMedia: '动作素材', shot: '镜头', file: '文件', imageMetadata: '图片信息' };
  // 格式错误的 ID 可能本身是路径或正文，不能直接写入错误日志。
  const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entity.id) ? entity.id : '格式无效';
  return captureSourceLocation(location, labels[entity.kind], { ...entity.data, id });
}

function relativeProjectFile(path: string, projectDirectory?: string): string {
  const normalized = path.replace(/\\/g, '/'), root = projectDirectory?.replace(/\\/g, '/').replace(/\/$/, '');
  if (root && normalized.toLowerCase().startsWith(root.toLowerCase() + '/')) return normalized.slice(root.length + 1);
  if (/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path)) throw new Error('项目包含无法映射到项目目录的原生文件引用');
  return safeExchangePath(path);
}

function referencePath(value: Record<string, unknown>, projectDirectory?: string): string | undefined {
  if (value.relativePath) return typeof value.relativePath === 'string' ? safeExchangePath(value.relativePath) : undefined;
  return typeof value.filePath === 'string' ? safeExchangePath(relativeProjectFile(value.filePath, projectDirectory)) : undefined;
}

const cloudOutputKeys = new Set(['kind', 'url', 'sourceUrl', 'filePath', 'relativePath', 'assetId', 'nodeId']);

/** 当前主媒体已落盘时，识别不单独展示且确实缺失的单产物缓存；不推测其他业务字段。 */
export function findMissingSingleCloudOutputFields(data: Record<string, unknown>, assets: ReadonlyMap<string, ArchiveAssetDigest>,
  projectDirectory?: string, portablePaths?: ReadonlySet<string>): Array<'runninghubOutputs' | 'workflowApiOutputs'> {
  const candidates = (['runninghubOutputs', 'workflowApiOutputs'] as const).filter((field) => {
    const outputs = data[field];
    return Array.isArray(outputs) && outputs.length === 1 && exchangeObject(outputs[0])
      && Object.entries(outputs[0]).every(([key, value]) => cloudOutputKeys.has(key) && (value === undefined || typeof value === 'string'));
  });
  if (!candidates.length) return [];
  const primaryPath = referencePath(data, projectDirectory), primaryAsset = primaryPath ? assets.get(primaryPath) : undefined;
  const primaryKind = primaryAsset ? media(primaryAsset).kind : undefined;
  if (!primaryKind || primaryKind === 'file') return [];
  const knownPaths = portablePaths ?? new Set([...assets.keys()].map((path) => path.normalize('NFC').toLowerCase()));
  return candidates.filter((field) => {
    const output = (data[field] as Array<Record<string, unknown>>)[0];
    if (output.kind !== primaryKind) return false;
    const path = referencePath(output, projectDirectory);
    return !!path && !knownPaths.has(path.normalize('NFC').toLowerCase());
  });
}

export function captureExchangeSnapshot(records: readonly ProjectSaveData[], assets: readonly ArchiveAssetDigest[], previous: ProjectExchangeState | null,
  previousSnapshot?: ProjectExchangeSnapshot, projectDirectory?: string): ExchangeCapture {
  const owner = records[0]; if (!owner || owner.parentId) throw new Error('必须读取整部剧或独立项目');
  const lineageId = previous?.lineageId ?? crypto.randomUUID(), root = previous?.rootProjectId ?? owner.id;
  const identities: ProjectExchangeIdentity[] = [...(previous?.identities ?? [])];
  const logical = (kind: ProjectExchangeEntityKind, scopeId: string, localId: string): string => {
    const existing = identities.find((item) => item.kind === kind && item.scopeId === scopeId && item.localId === localId);
    if (existing) return existing.id;
    const id = kind === 'file' ? crypto.randomUUID() : localId;
    identities.push({ kind, scopeId, id, localId }); return id;
  };
  if (!identities.some((item) => item.kind === 'project' && item.localId === owner.id)) identities.push({ kind: 'project', scopeId: root, id: root, localId: owner.id });
  const projectIds = new Map(records.map((record) => {
    const id = identities.find((item) => item.kind === 'project' && item.localId === record.id)?.id ?? record.id;
    if (!identities.some((item) => item.kind === 'project' && item.id === id)) identities.push({ kind: 'project', scopeId: id, id, localId: record.id });
    return [record.id, id];
  }));
  const byPath = new Map(assets.map((asset) => [safeExchangePath(asset.path), asset]));
  const portablePaths = new Set([...byPath.keys()].map((path) => path.normalize('NFC').toLowerCase()));
  if (byPath.size !== assets.length || portablePaths.size !== assets.length) {
    throw new Error('项目素材存在大小写或 Unicode 重名，无法建立可移植的归档');
  }
  const entities: ProjectExchangeEntity[] = [], usedMedia = new Map<string, ProjectExchangeMedia>(), files = new Map<string, string>();
  const fileToken = (path: string, location = '', fieldPath = ''): string => {
    const safe = safeExchangePath(path), asset = byPath.get(safe);
    if (!asset) throw new Error(`项目引用的素材缺失：${safe}；引用位置：${location || '项目文件'}${fieldPath ? `；引用字段：${fieldPath}` : ''}。请恢复文件或重新选择素材后重试。`);
    const id = logical('file', root, safe);
    if (!files.has(id)) {
      const descriptor = media(asset); usedMedia.set(descriptor.id, descriptor); files.set(id, safe);
      entities.push({ kind: 'file', scopeId: root, id, data: { mediaId: descriptor.id,
        name: safe.split('/').pop()! }, references: [] });
    }
    return FILE_TOKEN + id;
  };
  const relativeFile = (path: string): string => {
    return relativeProjectFile(path, projectDirectory);
  };
  const clean = (value: unknown, key = '', location = '', fieldPath = '', textNodeOutput = false): ProjectExchangeValue | undefined => {
    if (value === undefined || omitted.has(key)) return undefined;
    if (typeof value === 'string') {
      if (['projectId', 'parentProjectId'].includes(key)) return projectIds.get(value) ?? value;
      if (key === 'relativePath' || key === 'imageRelativePath') return value ? fileToken(value, location, fieldPath) : undefined;
      if (mediaUrls.has(key) && (/^(blob:|data:|file:|asset:|https?:\/\/(?:asset\.localhost|tauri\.localhost)|[a-z]:[\\/])/i.test(value))) return undefined;
      if (key === 'status' && ['loading', 'generating', 'running', 'pending', 'polling'].includes(value)) return 'idle';
      if (/(?:paths?|directory|folder)$/i.test(key) && /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)) {
        throw new Error('项目包含尚未适配的本机路径字段，无法生成可迁移的完整快照');
      }
      if (/@asset\{/.test(value)) throw new Error('提示词含本机文件引用，请改用项目内节点引用后导出');
      return value;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (Array.isArray(value)) return value.map((item, index) => clean(item, key, location, `${fieldPath}[${index}]`, textNodeOutput) ?? null);
    if (!exchangeObject(value)) throw new Error('项目存在无法迁移的运行期对象');
    const result: ProjectExchangeObject = {};
    if (!value.relativePath && typeof value.filePath === 'string') result.relativePath = fileToken(relativeFile(value.filePath), location, fieldPath ? `${fieldPath}.filePath` : 'filePath');
    if (!value.relativePath && !value.imageRelativePath && !result.relativePath && [...mediaUrls].some((field) =>
      typeof value[field] === 'string' && /^(?:asset:|file:|blob:|data:|https?:\/\/(?:asset\.localhost|tauri\.localhost))/i.test(value[field] as string))) {
      throw new Error('项目包含尚未归档的本地媒体，请先将素材保存到项目目录');
    }
    for (const [field, item] of Object.entries(value)) {
      // 有相对身份的 URL 是本机投影，不能影响跨设备比较。
      if ((mediaUrls.has(field) || field === 'output' && !(textNodeOutput && fieldPath === 'data')
        && typeof item === 'string' && /^(?:https?:|asset:|blob:|data:)/i.test(item))
        && (value.relativePath || value.imageRelativePath || result.relativePath)) continue;
      if (field === 'directorCaptureUrls' && (value.directorCaptureFilePaths || value.directorCaptureRelativePaths)) continue;
      if ((field === 'directorCaptureFilePaths' || field === 'directorCaptureRelativePaths') && Array.isArray(item)) {
        if (field === 'directorCaptureFilePaths' && value.directorCaptureRelativePaths) continue;
        result.directorCaptureRelativePaths = item.map((path, index) => {
          if (typeof path !== 'string') throw new Error('导演截图引用不完整');
          return fileToken(relativeFile(path), location, `${fieldPath ? `${fieldPath}.` : ''}${field}[${index}]`);
        }); continue;
      }
      const next = clean(item, field, location, fieldPath ? `${fieldPath}.${field}` : field, textNodeOutput); if (next !== undefined) result[field] = next;
    }
    return result;
  };
  const add = (kind: ProjectExchangeEntityKind, scopeId: string, source: Record<string, unknown>, location: string) => {
    if (typeof source.id !== 'string') throw new Error('项目实体缺少稳定 ID');
    const id = logical(kind, scopeId, source.id);
    const nodeType = typeof source.type === 'string' ? source.type : exchangeObject(source.data) ? source.data.type : undefined;
    const data = clean(source, '', location, '', kind === 'node' && typeof nodeType === 'string' && textNodeTypes.has(nodeType)) as ProjectExchangeObject; delete data.id;
    // 已知的有序子实体单独对账，其顺序作为父级的原子字段。
    for (const [field, childKind] of collections) {
      if (!Array.isArray(source[field])) continue;
      const children = source[field] as unknown[];
      if (children.some((child) => !exchangeObject(child) || typeof child.id !== 'string')) continue;
      data[`${field}Ids`] = children.map((child) => add(childKind, scopeId, child as Record<string, unknown>, location));
      delete data[field];
    }
    entities.push({ kind, scopeId, id, data, references: [] }); return id;
  };
  for (const record of records) {
    const scope = projectIds.get(record.id)!;
    const location = `项目「${owner.name}」${record.parentId ? ` → 分集「${record.name}」` : ''}`;
    const { nodes, edges, groups, dramaAssets, ...metadata } = record;
    const data = clean(metadata, '', location) as ProjectExchangeObject; delete data.id; delete data.exchangeEpoch;
    if (record.parentId) data.parentId = root;
    entities.push({ kind: 'project', scopeId: scope, id: scope, data, references: [] });
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!exchangeObject(node)) throw new Error('节点结构损坏');
      // shotlistRows 位于 data 中，作为独立有序业务集合。
      const nodeData = exchangeObject(node.data) ? { ...node.data } : {};
      // 只修改导出副本；有效产物、多产物和其他文件引用仍完整校验。
      for (const field of findMissingSingleCloudOutputFields(nodeData, byPath, projectDirectory, portablePaths)) delete nodeData[field];
      const shotRows = nodeData.shotlistRows; delete nodeData.shotlistRows;
      const nodeLocation = captureSourceLocation(location, '节点', node);
      const id = add('node', scope, { ...node, data: nodeData }, nodeLocation);
      const entity = entities.find((item) => item.kind === 'node' && item.scopeId === scope && item.id === id)!;
      if (Array.isArray(shotRows) && shotRows.every((row) => exchangeObject(row) && typeof row.id === 'string')) {
        entity.data.shotlistRowsIds = shotRows.map((row) => add('shot', scope, row as Record<string, unknown>,
          captureSourceLocation(nodeLocation, '镜头', row as Record<string, unknown>)));
      } else if (shotRows !== undefined) (entity.data.data as ProjectExchangeObject).shotlistRows = clean(shotRows, '', nodeLocation)!;
    }
    for (const edge of Array.isArray(edges) ? edges : []) add('edge', scope, edge, captureSourceLocation(location, '连线', edge));
    for (const group of Array.isArray(groups) ? groups : []) add('group', scope, group, captureSourceLocation(location, '分组', group));
    data.nodesIds = Array.isArray(nodes) ? nodes.map((node) => (node as { id: string }).id) : [];
    data.edgesIds = Array.isArray(edges) ? edges.map((edge) => (edge as { id: string }).id) : [];
    data.groupsIds = Array.isArray(groups) ? groups.map((group) => (group as { id: string }).id) : [];
    if (!record.parentId) for (const [field, kind, label] of [['characters', 'character', '角色'], ['scenes', 'scene', '场景'], ['props', 'prop', '道具']] as const) {
      data[field + 'Ids'] = (dramaAssets?.[field] ?? []).map((asset) => {
        const source = asset as unknown as Record<string, unknown>;
        return add(kind, root, source, captureSourceLocation(location, label, source));
      });
    }
  }
  // 项目文件资产包含未被节点引用的原稿与附件；失败发布的孤儿 imports 目录不纳入新基线。
  for (const path of byPath.keys()) {
    const known = identities.find((item) => item.kind === 'file' && item.localId === path);
    if (path.startsWith('imports/') && !known) continue;
    if (known && previousSnapshot && !previousSnapshot.entities.some((item) => item.kind === 'file' && item.id === known.id) && !files.has(known.id)) continue;
    fileToken(path);
  }
  // 映射保留墓碑，避免删除后重用本机 ID 被误当作另一侧新增实体。
  return { snapshot: validateExchangeDomain({ format: 'ai-canvas-project-snapshot', canonicalVersion: 1, complete: true,
    lineageId, rootProjectId: root, entities, media: [...usedMedia.values()] }), identities, files };
}

export function materializeExchangeSnapshot(snapshot: ProjectExchangeSnapshot, identities: ProjectExchangeIdentity[],
  existing: readonly ProjectSaveData[], dataFolder: string, paths: ReadonlyMap<string, string>, preserveLocalBindings = true): ProjectSaveData[] {
  validateExchangeDomain(snapshot);
  const projects = snapshot.entities.filter((item) => item.kind === 'project');
  const local = (entity: ProjectExchangeReference): string => {
    let mapping = identities.find((item) => projectExchangeEntityKey(item) === projectExchangeEntityKey(entity));
    if (!mapping) {
      // 调用方可能传入完整实体；身份映射不能混入 data / references 等业务字段。
      mapping = { kind: entity.kind, scopeId: entity.scopeId, id: entity.id,
        localId: entity.kind === 'project' ? crypto.randomUUID() : entity.id };
      identities.push(mapping);
    }
    return mapping.localId;
  };
  projects.forEach(local);
  const decode = (value: ProjectExchangeValue, key = ''): unknown => {
    if (typeof value === 'string' && value.startsWith(FILE_TOKEN)) {
      const path = paths.get(value.slice(FILE_TOKEN.length)); if (!path) throw new Error('合并结果缺少素材'); return safeExchangePath(path);
    }
    if (typeof value === 'string' && ['projectId', 'parentProjectId'].includes(key)) {
      return identities.find((item) => item.kind === 'project' && item.id === value)?.localId ?? value;
    }
    if (Array.isArray(value)) return value.map((item) => decode(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, decode(item, field)]));
    return value;
  };
  const restore = (entity: ProjectExchangeEntity): Record<string, unknown> => {
    const data = decode(entity.data) as Record<string, unknown>;
    for (const [field, kind] of collections) if (Array.isArray(data[`${field}Ids`])) {
      const children = (data[`${field}Ids`] as string[]).map((id) => {
        const child = snapshot.entities.find((item) => item.kind === kind && item.scopeId === entity.scopeId && item.id === id);
        if (!child) throw new Error('合并结果缺少子实体'); return restore(child);
      });
      delete data[`${field}Ids`];
      if (field === 'shotlistRows' && entity.kind === 'node') (data.data as Record<string, unknown>)[field] = children;
      else data[field] = children;
    }
    return { ...data, id: local(entity) };
  };
  return projects.sort((a, b) => Number(b.id === snapshot.rootProjectId) - Number(a.id === snapshot.rootProjectId)).map((project) => {
    const id = local(project), before = existing.find((record) => record.id === id);
    const data = restore(project);
    const canvasList = (field: 'nodes' | 'edges' | 'groups', kind: ProjectExchangeEntityKind) => {
      const ids = data[field + 'Ids']; delete data[field + 'Ids'];
      if (!Array.isArray(ids)) throw new Error('项目缺少画布顺序');
      return ids.map((entityId) => {
        const entity = snapshot.entities.find((item) => item.kind === kind && item.scopeId === project.id && item.id === entityId);
        if (!entity) throw new Error('画布顺序引用的实体缺失'); return restore(entity);
      });
    };
    const lists: Record<string, unknown[]> = {};
    for (const [field, kind] of [['characters', 'character'], ['scenes', 'scene'], ['props', 'prop']] as const) {
      const ids = data[field + 'Ids']; delete data[field + 'Ids'];
      lists[field] = Array.isArray(ids) ? ids.map((assetId) => {
        const entity = snapshot.entities.find((item) => item.kind === kind && item.id === assetId && item.scopeId === project.id);
        if (!entity) throw new Error('合并结果缺少创作资产'); return restore(entity);
      }) : [];
    }
    const localCharacters = existing.find((record) => record.id === id)?.dramaAssets?.characters ?? [];
    for (const asset of lists.characters ?? []) {
      const character = asset as Record<string, unknown>;
      const binding = preserveLocalBindings ? localCharacters.find((item) => item.id === character.id)?.volcengineBinding : undefined;
      if (binding) character.volcengineBinding = binding;
    }
    const rootLocalId = local({ kind: 'project', scopeId: snapshot.rootProjectId, id: snapshot.rootProjectId });
    const nodes = canvasList('nodes', 'node'), edges = canvasList('edges', 'edge'), groups = canvasList('groups', 'group');
    return { ...data, id, dataFolder, createdAt: before?.createdAt ?? Date.now(), updatedAt: Date.now(), exchangeEpoch: before?.exchangeEpoch,
      parentId: project.id === snapshot.rootProjectId ? undefined : rootLocalId,
      nodes, edges, groups,
      dramaAssets: project.id === snapshot.rootProjectId ? { version: 2, ...lists } : undefined } as unknown as ProjectSaveData;
  });
}
