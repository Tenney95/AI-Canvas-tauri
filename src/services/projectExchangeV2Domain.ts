/** 旧规范的确定性比较投影；不是修改旧修订或猜测本机目录的迁移。 */
import type { ProjectExchangeObject, ProjectExchangeRevision, ProjectExchangeSnapshot, ProjectExchangeValue } from '../types/projectExchange';
import type { AnyProjectExchangeRevision } from '../types/projectExchangeV2';
import type { ProjectExchangeEntityV2, ProjectExchangeSnapshotV2 } from '../types/projectArchiveV4';
import { PROJECT_ARCHIVE_V4_CONTRACT } from '../types/projectArchiveV4';
import { parseProjectExchangeSnapshot, projectExchangeId, serializeProjectExchangeValue, verifyProjectExchangeRevision } from './projectExchangeFormat';
import { safeExchangePath, validateExchangeDomain } from './projectExchangeDomain';
import { exchangeReferencesV2, parseProjectExchangeSnapshotV2, verifyProjectExchangeRevisionV2 } from './projectExchangeV2Format';
import { sha256BytesHex } from './mediaDataUrl';
import { normalizeStoryGraph } from './storyGraphService';

export { exchangeReferencesV2 } from './projectExchangeV2Format';
export const validateExchangeDomainV2 = parseProjectExchangeSnapshotV2;
export interface LegacyExchangeProjectionProof {
  /** 只接受由旧包实际 assets 根证明的逻辑根映射，不接受本机目录。 */
  roots?: Array<{ scopeId: string; rootRef: string }>;
  files?: Array<{ fileId: string; rootRef: string; relativePath: string }>;
}
const review = (): never => { throw new Error('旧规范资料缺少可证明的映射，请补充材料或人工比较（LEGACY_PROJECTION_REQUIRES_REVIEW）'); };
const object = (value: ProjectExchangeValue | undefined): ProjectExchangeObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return review();
  return value;
};
const creativeFields = { episodeOutline: 'outline', episodeScript: 'script', episodeScriptFile: 'scriptFile',
  episodeCreative: 'creative', episodeAssetRoster: 'assetRoster' } as const;
const metadataFields = new Set(['name', 'parentId', 'episodeNo', 'settings', 'series', 'nodesIds', 'edgesIds', 'groupsIds',
  'charactersIds', 'scenesIds', 'propsIds', 'creationProfile', 'teamProfileOverride', 'revisionScope', ...Object.keys(creativeFields)]);
const clone = <T>(value: T): T => structuredClone(value);

/** 新逻辑 Canvas/根身份由旧来源、旧逻辑 scope 和冻结版本决定，不使用本机随机 ID。 */
export async function deriveLegacyExchangeIdentity(lineageId: string, scopeId: string, kind: 'canvas' | 'root'): Promise<string> {
  projectExchangeId(lineageId); projectExchangeId(scopeId);
  const bytes = new TextEncoder().encode(serializeProjectExchangeValue([PROJECT_ARCHIVE_V4_CONTRACT.adapterVersion, lineageId, scopeId, kind]));
  return `${kind}_${await sha256BytesHex(bytes)}`;
}

export async function adaptSnapshotV1ToV2(input: ProjectExchangeSnapshot,
  proof: LegacyExchangeProjectionProof = {}): Promise<ProjectExchangeSnapshotV2> {
  const original = parseProjectExchangeSnapshot(input), snapshot = validateExchangeDomain(original);
  const root = snapshot.rootProjectId, owners = snapshot.entities.filter((entity) => entity.kind === 'project');
  const owner = owners.find((entity) => entity.id === root);
  if (!owner || owners.some((entity) => Object.keys(entity.data).some((field) => !metadataFields.has(field)))) return review();
  const children = owners.filter((entity) => entity.id !== root);
  const isSeries = children.length > 0;
  if (isSeries && (['nodesIds', 'edgesIds', 'groupsIds'].some((field) => Array.isArray(owner.data[field]) && owner.data[field].length > 0)
    || Object.keys(creativeFields).some((field) => owner.data[field] !== undefined)
    || owner.data.creationProfile !== undefined || owner.data.teamProfileOverride !== undefined)) return review();
  if (children.some((entity) => entity.data.series !== undefined)) return review();
  const numbers = children.map((entity) => entity.data.episodeNo);
  if (numbers.some((value) => !Number.isSafeInteger(value) || Number(value) < 1) || new Set(numbers).size !== numbers.length) return review();
  children.sort((a, b) => Number(a.data.episodeNo) - Number(b.data.episodeNo));
  const scopes = new Set(owners.map((entity) => entity.id)), rootMap = new Map<string, string>(), canvasMap = new Map<string, string>();
  for (const item of proof.roots ?? []) {
    if (!scopes.has(item.scopeId) || rootMap.has(item.scopeId)) return review();
    rootMap.set(projectExchangeId(item.scopeId), projectExchangeId(item.rootRef));
  }
  for (const entity of owners) {
    rootMap.set(entity.id, rootMap.get(entity.id) ?? await deriveLegacyExchangeIdentity(snapshot.lineageId, entity.id, 'root'));
    if (!isSeries || entity.id !== root) canvasMap.set(entity.id, await deriveLegacyExchangeIdentity(snapshot.lineageId, entity.id, 'canvas'));
  }
  const rootRef = rootMap.get(root)!;
  const roots = [...new Set(rootMap.values())].sort().map((id) => ({ id, role: id === rootRef ? 'shared' : 'canvas' }));
  const fileProofs = new Map<string, NonNullable<LegacyExchangeProjectionProof['files']>[number]>();
  const sourceFiles = new Set(snapshot.entities.filter((entity) => entity.kind === 'file').map((entity) => entity.id));
  const occupied = new Set<string>();
  for (const item of proof.files ?? []) {
    if (!sourceFiles.has(item.fileId) || fileProofs.has(item.fileId) || !roots.some((entry) => entry.id === item.rootRef)
      || safeExchangePath(item.relativePath) !== item.relativePath) return review();
    const identity = JSON.stringify([item.rootRef, item.relativePath.normalize('NFC').toLowerCase()]);
    if (occupied.has(identity)) return review();
    occupied.add(identity); fileProofs.set(item.fileId, { fileId: projectExchangeId(item.fileId), rootRef: projectExchangeId(item.rootRef), relativePath: item.relativePath });
  }
  const creative = (data: ProjectExchangeObject): ProjectExchangeObject | undefined => {
    const content: ProjectExchangeObject = {};
    for (const [oldField, newField] of Object.entries(creativeFields)) if (data[oldField] !== undefined) content[newField] = clone(data[oldField]);
    return Object.keys(content).length ? { ...content, storageRootRef: rootRef } : undefined;
  };
  const content: ProjectExchangeObject = {};
  if (owner.data.series !== undefined) {
    const series = object(owner.data.series);
    if (Object.keys(series).some((field) => !['originalWork', 'script', 'storyGraph'].includes(field))) return review();
    Object.assign(content, clone(series));
  }
  const standalone = !isSeries ? creative(owner.data) : undefined;
  if (standalone || !isSeries && (owner.data.creationProfile !== undefined || owner.data.teamProfileOverride !== undefined)) {
    content.standaloneCreative = { ...(standalone ?? { storageRootRef: rootRef }),
      ...(owner.data.creationProfile !== undefined ? { creationProfile: clone(owner.data.creationProfile) } : {}),
      ...(owner.data.teamProfileOverride !== undefined ? { teamProfileOverride: clone(owner.data.teamProfileOverride) } : {}) };
  }
  const projectData: ProjectExchangeObject = { name: owner.data.name, kind: isSeries ? 'series' : 'standalone',
    storageRoots: roots, ...(!isSeries ? { standaloneCanvasId: canvasMap.get(root)! } : {}), content,
    ...(owner.data.settings !== undefined ? { defaultSettings: clone(owner.data.settings) } : {}) };
  if (['charactersIds', 'scenesIds', 'propsIds'].some((field) => Array.isArray(owner.data[field]) && owner.data[field].length > 0)) {
    content.dramaAssets = { version: 2 };
    for (const field of ['charactersIds', 'scenesIds', 'propsIds']) projectData[field] = clone(owner.data[field] ?? []);
  }
  const entities: ProjectExchangeEntityV2[] = [{ kind: 'project', scopeId: root, id: root, data: projectData, references: [] }];
  for (const [index, child] of children.entries()) {
    const childContent = creative(child.data) ?? {};
    entities.push({ kind: 'episode', scopeId: root, id: child.id, references: [], data: {
      projectId: root, canvasId: canvasMap.get(child.id)!, name: child.data.name, orderRank: index,
      displayNo: child.data.episodeNo, content: childContent,
      settingsPolicy: { mode: 'legacy-pinned', snapshot: clone(child.data.settings ?? {}) },
      ...(child.data.creationProfile !== undefined ? { creationProfile: clone(child.data.creationProfile) } : {}),
      ...(child.data.teamProfileOverride !== undefined ? { teamProfileOverride: clone(child.data.teamProfileOverride) } : {}),
    } });
  }
  for (const [scope, id] of canvasMap) {
    const source = owners.find((entity) => entity.id === scope)!;
    if (source.data.revisionScope !== undefined && !['project', 'global'].includes(String(source.data.revisionScope))) return review();
    entities.push({ kind: 'canvas', scopeId: root, id, references: [], data: { projectId: root,
      episodeId: isSeries ? scope : null, storageRootRef: rootMap.get(scope)!, revisionScope: source.data.revisionScope ?? 'project',
      nodesIds: clone(source.data.nodesIds ?? []), edgesIds: clone(source.data.edgesIds ?? []), groupsIds: clone(source.data.groupsIds ?? []) } });
  }
  for (const entity of snapshot.entities) {
    if (entity.kind === 'project') continue;
    const onCanvas = ['node', 'edge', 'group', 'shot'].includes(entity.kind);
    const scopeId = onCanvas ? canvasMap.get(entity.scopeId) : root;
    if (!scopeId) return review();
    const data = clone(entity.data);
    if (entity.kind === 'file') {
      const verified = fileProofs.get(entity.id);
      data.rootRef = verified?.rootRef ?? rootRef;
      if (verified) data.relativePath = verified.relativePath;
      else data.legacyPathUnavailable = true;
    }
    entities.push({ ...entity, scopeId, data, references: [] });
  }
  const historicalTargets: ProjectExchangeSnapshotV2['historicalTargets'] = [];
  if (content.storyGraph !== undefined) {
    const graph = normalizeStoryGraph({ ...object(content.storyGraph), revision: 0 });
    const sourceIds = new Set(children.map((child) => child.id));
    if (!isSeries) sourceIds.add(root);
    const retired = new Set<string>();
    for (const item of [...graph.nodes, ...graph.edges]) for (const id of [...item.episodeIds, ...item.evidence.map((entry) => entry.episodeId),
      ...('fromEpisodeId' in item && item.fromEpisodeId ? [item.fromEpisodeId] : []),
      ...('toEpisodeId' in item && item.toEpisodeId ? [item.toEpisodeId] : [])]) if (!sourceIds.has(id)) retired.add(id);
    // 旧故事出处只证明显示身份，不证明删除，也不恢复可执行分集。
    for (const id of retired) historicalTargets.push({ state: 'retired', kind: id === root ? 'standalone-creative' : 'episode', projectId: root, id });
  }
  const result: ProjectExchangeSnapshotV2 = { format: 'ai-canvas-project-snapshot', canonicalVersion: 2,
    lineageId: snapshot.lineageId, rootProjectId: root, complete: true, entities: entities.map((entity) => ({ ...entity,
      references: exchangeReferencesV2(entity, entities, root) })), media: clone(snapshot.media), historicalTargets };
  return parseProjectExchangeSnapshotV2(result);
}

/** 缺真实根/文件证明的旧比较视图不可直接用于自动跨规范合并或新包发布。 */
export function assertCompleteLegacyProjection(snapshot: ProjectExchangeSnapshotV2): void {
  if (snapshot.entities.some((entity) => entity.kind === 'file' && entity.data.legacyPathUnavailable === true)) return review();
}

/** 只从完整、无业务变化的直接迁移修订证明旧基线文件位置；不用当前改名后的文件反推历史。 */
export async function deriveLegacyProjectionProofFromRevisions(input: ProjectExchangeRevision,
  revisions: readonly AnyProjectExchangeRevision[]): Promise<LegacyExchangeProjectionProof> {
  const old = await verifyProjectExchangeRevision(input), proofs = new Map<string, LegacyExchangeProjectionProof>();
  for (const input of revisions) {
    if (input.canonicalVersion !== 2 || input.adapterVersion !== PROJECT_ARCHIVE_V4_CONTRACT.adapterVersion
      || input.parents.length !== 1 || input.parents[0].canonicalVersion !== 1 || input.parents[0].revisionId !== old.revisionId) continue;
    const candidate = await verifyProjectExchangeRevisionV2(input);
    if (candidate.lineageId !== old.lineageId || candidate.snapshot.rootProjectId !== old.snapshot.rootProjectId) continue;
    const project = candidate.snapshot.entities.find((entity) => entity.kind === 'project')!;
    const roots = project.data.storageRoots as ProjectExchangeObject[];
    const sharedRoot = roots.find((entry) => entry.role === 'shared')?.id ?? roots[0]?.id;
    if (typeof sharedRoot !== 'string') continue;
    const proof: LegacyExchangeProjectionProof = { roots: [], files: [] };
    let complete = true;
    for (const owner of old.snapshot.entities.filter((entity) => entity.kind === 'project')) {
      const canvasId = await deriveLegacyExchangeIdentity(old.lineageId, owner.id, 'canvas');
      const canvas = candidate.snapshot.entities.find((entity) => entity.kind === 'canvas' && entity.id === canvasId);
      const rootRef = canvas?.data.storageRootRef ?? (owner.id === old.snapshot.rootProjectId ? sharedRoot : undefined);
      if (typeof rootRef !== 'string') { complete = false; break; }
      proof.roots!.push({ scopeId: owner.id, rootRef });
    }
    if (!complete) continue;
    for (const file of old.snapshot.entities.filter((entity) => entity.kind === 'file')) {
      const target = candidate.snapshot.entities.find((entity) => entity.kind === 'file' && entity.id === file.id);
      if (!target || target.data.mediaId !== file.data.mediaId || typeof target.data.rootRef !== 'string' || typeof target.data.relativePath !== 'string') { complete = false; break; }
      proof.files!.push({ fileId: file.id, rootRef: target.data.rootRef, relativePath: target.data.relativePath });
    }
    if (!complete) continue;
    let projected: ProjectExchangeSnapshotV2;
    try { projected = await adaptSnapshotV1ToV2(old.snapshot, proof); }
    catch { continue; }
    if (serializeProjectExchangeValue(projected) !== serializeProjectExchangeValue(candidate.snapshot)) continue;
    proof.roots!.sort((a, b) => a.scopeId < b.scopeId ? -1 : a.scopeId > b.scopeId ? 1 : 0);
    proof.files!.sort((a, b) => a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0);
    proofs.set(serializeProjectExchangeValue(proof), proof);
  }
  if (proofs.size !== 1) return review();
  return proofs.values().next().value!;
}
