/** 同一套严格上下文解析/比较；不打开数据库，不读取localStorage，不刷新调用方旧意图。 */
import type { CanvasContext, EpisodeContext, ProjectExpectedContext, ProjectContext } from '../types/project';
import type { ProjectExecutionContextState } from '../types/projectExecutionContext';

export class ProjectExecutionContextError extends Error {
  readonly code: 'CONTEXT_REFRESH_REQUIRED' | 'NO_ACTIVE_CANVAS' | 'PROJECT_MODEL_EXECUTION_DISABLED';
  constructor(code: ProjectExecutionContextError['code'] = 'CONTEXT_REFRESH_REQUIRED') {
    super(code === 'NO_ACTIVE_CANVAS' ? '当前没有活动画布' : code === 'PROJECT_MODEL_EXECUTION_DISABLED'
      ? '正式新模型执行尚未开放' : '项目执行上下文已变化，请重新读取并判断原请求');
    this.code = code;
    this.name = 'ProjectExecutionContextError';
  }
}
const fail = (): never => { throw new ProjectExecutionContextError(); };
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim() && value.length <= 256
  && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159);

export function parseProjectExpectedContext(input: unknown): ProjectExpectedContext {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail();
  // 先拒访问器，再读取kind；不执行外部对象的getter。
  if (Object.getOwnPropertySymbols(input).length
    || Object.values(Object.getOwnPropertyDescriptors(input)).some((descriptor) => !('value' in descriptor) || !descriptor.enumerable)) return fail();
  const value = input as Record<string, unknown>;
  const common = ['kind', 'schemaVersion', 'modelGeneration'];
  const project = [...common, 'projectId', 'projectEpoch'];
  const required = value.kind === 'global' ? [...common, 'catalogRevision'] : value.kind === 'project' ? project
    : value.kind === 'episode' ? [...project, 'episodeId', 'episodeRevision']
      : value.kind === 'canvas' ? [...project, 'canvasId', 'episodeId', 'canvasEpoch', 'canvasRevision'] : fail();
  const allowed = [...required, 'runtimeEpoch', ...(value.kind === 'episode' ? ['sourceHash'] : [])];
  if (Object.getOwnPropertyNames(input).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))
    || value.schemaVersion !== 2 || !integer(value.modelGeneration)) return fail();
  if (value.runtimeEpoch !== undefined && (typeof value.runtimeEpoch !== 'string'
    || !/^[A-Za-z0-9-]{1,128}$/.test(value.runtimeEpoch))) return fail();
  if (value.kind === 'global') { if (!integer(value.catalogRevision)) return fail(); }
  else {
    if (!id(value.projectId) || !integer(value.projectEpoch)) return fail();
    if (value.kind === 'episode' && (!id(value.episodeId) || !integer(value.episodeRevision)
      || value.sourceHash !== undefined && (typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceHash)))) return fail();
    if (value.kind === 'canvas' && (!id(value.canvasId) || value.episodeId !== null && !id(value.episodeId)
      || !integer(value.canvasEpoch) || !integer(value.canvasRevision))) return fail();
  }
  return structuredClone(value) as unknown as ProjectExpectedContext;
}

interface ContextRuntime { epoch?: string; signature?: string; catalogRevision: number }
const runtime: ContextRuntime = import.meta.hot?.data.projectExecutionContextRuntime ?? { catalogRevision: 0 };
if (import.meta.hot) import.meta.hot.data.projectExecutionContextRuntime = runtime;
function epoch(): string { return runtime.epoch ??= crypto.randomUUID(); }
function catalogRevision(state: ProjectExecutionContextState): number {
  const signature = JSON.stringify([...(state.projects ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map((project) => [project.id, project.parentId, project.exchangeEpoch ?? 0, project.name, project.episodeNo]));
  if (signature !== runtime.signature) {
    if (runtime.catalogRevision >= Number.MAX_SAFE_INTEGER) return fail();
    runtime.signature = signature; runtime.catalogRevision += 1;
  }
  return runtime.catalogRevision;
}
function legacyTarget(state: ProjectExecutionContextState) {
  if (!state.currentProjectId || !state.projects || state.projectLoadStatus !== undefined && state.projectLoadStatus !== 'ready'
    || state.switchingProjectName != null || state.isCreatingProject || state.isReturningToStartPage) return null;
  const current = state.projects.find((item) => item.id === state.currentProjectId);
  const owner = current?.parentId ? state.projects.find((item) => item.id === current.parentId) : current;
  if (!current || !owner || owner.parentId || !integer(current.exchangeEpoch ?? 0) || !integer(owner.exchangeEpoch ?? 0)) return null;
  return { current, owner };
}
function projectPart(context: Exclude<ProjectExpectedContext, { kind: 'global' }>): ProjectContext {
  return { kind: 'project', schemaVersion: 2, modelGeneration: context.modelGeneration,
    projectId: context.projectId, projectEpoch: context.projectEpoch,
    ...(context.runtimeEpoch === undefined ? {} : { runtimeEpoch: context.runtimeEpoch }) };
}
export function captureLegacyCanvasContext(state: ProjectExecutionContextState): CanvasContext | null {
  if (state.projectExecutionContext !== undefined) {
    if (state.projectExecutionContext === null) return null;
    const current = parseProjectExpectedContext(state.projectExecutionContext);
    return current.kind === 'canvas' ? current : null;
  }
  const target = legacyTarget(state);
  if (!target) return null;
  const { current, owner } = target;
  // 旧普通画布也可先上传原著/保存全剧稿；series资料不证明它已成为无画布容器。
  // 真正零集的新模型由上方权威project上下文表达，不从旧元数据猜测。
  const series = !current.parentId && (state.projects ?? []).some((item) => item.parentId === current.id);
  const revision = state.getCurrentRevision();
  if (series || !integer(revision)) return null;
  return { kind: 'canvas', schemaVersion: 2, modelGeneration: 0, runtimeEpoch: epoch(),
    projectId: owner.id, projectEpoch: owner.exchangeEpoch ?? 0, canvasId: current.id,
    episodeId: current.parentId ? current.id : null, canvasEpoch: current.exchangeEpoch ?? 0, canvasRevision: revision };
}
export function captureLegacyEpisodeContext(state: ProjectExecutionContextState, episodeId: string): EpisodeContext | null {
  if (state.projectExecutionContext !== undefined) {
    if (state.projectExecutionContext === null) return null;
    const context = parseProjectExpectedContext(state.projectExecutionContext);
    return context.kind === 'episode' && context.episodeId === episodeId ? context : null;
  }
  const target = legacyTarget(state), episode = state.projects?.find((item) => item.id === episodeId);
  if (!target || !episode?.parentId || episode.parentId !== target.owner.id || !integer(episode.exchangeEpoch ?? 0)) return null;
  // 旧模型没有独立正文revision；原稿件hash/session basis继续负责正文并发条件。
  return { kind: 'episode', schemaVersion: 2, modelGeneration: 0, runtimeEpoch: epoch(), projectId: target.owner.id,
    projectEpoch: target.owner.exchangeEpoch ?? 0, episodeId, episodeRevision: episode.exchangeEpoch ?? 0 };
}
export function captureLegacyProjectExpectedContext(state: ProjectExecutionContextState,
  kind?: 'global' | 'project' | 'canvas'): ProjectExpectedContext {
  const authoritative = state.projectExecutionContext !== undefined ? parseProjectExpectedContext(state.projectExecutionContext) : null;
  if (authoritative) {
    if (kind === undefined || kind === authoritative.kind) return authoritative;
    if (kind === 'project' && authoritative.kind !== 'global') return projectPart(authoritative);
    if (kind === 'canvas') throw new ProjectExecutionContextError('NO_ACTIVE_CANVAS');
    return fail();
  }
  if (kind === 'global' || !state.currentProjectId && kind !== 'canvas' && kind !== 'project') {
    return { kind: 'global', schemaVersion: 2, modelGeneration: 0, runtimeEpoch: epoch(), catalogRevision: catalogRevision(state) };
  }
  const canvas = captureLegacyCanvasContext(state);
  if (canvas && kind !== 'project') return canvas;
  if (kind === 'canvas') throw new ProjectExecutionContextError('NO_ACTIVE_CANVAS');
  const target = legacyTarget(state);
  if (!target) return fail();
  return { kind: 'project', schemaVersion: 2, modelGeneration: 0, runtimeEpoch: epoch(), projectId: target.owner.id,
    projectEpoch: target.owner.exchangeEpoch ?? 0 };
}
export const getCurrentProjectExpectedContext = captureLegacyProjectExpectedContext;
export function isProjectExpectedContextCurrent(expected: ProjectExpectedContext,
  state: ProjectExecutionContextState | ProjectExpectedContext, options: { checkCanvasRevision?: boolean; checkRuntimeEpoch?: boolean } = {}): boolean {
  try {
    const parsed = parseProjectExpectedContext(expected);
    let actual: ProjectExpectedContext | null;
    if ('kind' in state) {
      actual = parseProjectExpectedContext(state);
      if (parsed.kind === 'project' && actual.kind !== 'global') actual = projectPart(actual);
    } else actual = parsed.kind === 'episode' ? captureLegacyEpisodeContext(state, parsed.episodeId)
      : captureLegacyProjectExpectedContext(state, parsed.kind);
    if (!actual || actual.kind !== parsed.kind || options.checkRuntimeEpoch !== false && actual.runtimeEpoch !== parsed.runtimeEpoch
      || actual.modelGeneration !== parsed.modelGeneration) return false;
    if (parsed.kind === 'global' && actual.kind === 'global') return actual.catalogRevision === parsed.catalogRevision;
    if (parsed.kind === 'global' || actual.kind === 'global' || actual.projectId !== parsed.projectId || actual.projectEpoch !== parsed.projectEpoch) return false;
    if (parsed.kind === 'episode' && actual.kind === 'episode') return actual.episodeId === parsed.episodeId
      && actual.episodeRevision === parsed.episodeRevision && actual.sourceHash === parsed.sourceHash;
    if (parsed.kind === 'canvas' && actual.kind === 'canvas') return actual.canvasId === parsed.canvasId && actual.episodeId === parsed.episodeId
      && actual.canvasEpoch === parsed.canvasEpoch && (options.checkCanvasRevision === false || actual.canvasRevision === parsed.canvasRevision);
    return parsed.kind === 'project' && actual.kind === 'project';
  } catch { return false; }
}
export function assertProjectExpectedContextCurrent(expected: ProjectExpectedContext,
  state: ProjectExecutionContextState | ProjectExpectedContext, options?: { checkCanvasRevision?: boolean; checkRuntimeEpoch?: boolean }): void {
  if (!isProjectExpectedContextCurrent(expected, state, options)) throw new ProjectExecutionContextError();
}
