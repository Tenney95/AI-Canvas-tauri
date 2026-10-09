/** 仅保存任务摘要；原始要求、媒体位置和运行时授权不进入 metadata。 */
import { openDB, STORE_METADATA } from '../indexedDb/schema';
import type { PluginVideoReplicaJobSummary } from '../../types/plugin';

export const pluginVideoReplicaJobsKey = (projectId: string) => `video-replica-jobs:${projectId}`;
const statuses = new Set(['queued', 'preparing', 'generating', 'composing', 'succeeded', 'failed', 'cancelled', 'paused', 'unknown']);
const writes = new Map<string, Promise<void>>();
const HISTORY_MAX = 30;
const NODE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u;
// 摘要只能包含固定状态说明。拒绝地址、绝对路径、凭据与不透明授权标识。
const PRIVATE_TEXT_RE = /(?:[a-z]:[\\/]|\\\\[^\\\s]+\\|\b[a-z][a-z\d+.-]*:\/\/|\b(?:https?|file|asset|data|blob):|(?:^|[^a-z\d._-])\/[^\s]|(?:^|[^a-z])(?:api[_-]?key|secret|token|grant(?:[_-]?id)?|resource[_-]?id|bearer)(?:$|[^a-z])|\bsk-[a-z\d_-]{8,}|\bplugin-(?:ref|resource)-[a-z\d_-]+)/iu;
const safeText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 240 && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  && !PRIVATE_TEXT_RE.test(value);
const safeId = (value: unknown): value is string => typeof value === 'string' && ID_RE.test(value)
  && !value.split('/').some((part) => part === '.' || part === '..');
const safeInteger = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

export function sanitizeReplicaJobSummary(raw: unknown): PluginVideoReplicaJobSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const ids = ['jobId', 'projectId', 'pluginId', 'nodeId', 'modelId'];
  if (ids.some((key) => !safeId(value[key]))
    || !['sourceDigest', 'revisionDigest'].every((key) => typeof value[key] === 'string' && /^[a-f0-9]{64}$/u.test(value[key] as string))
    || typeof value.status !== 'string' || !statuses.has(value.status) || !safeText(value.stage)
    || !safeInteger(value.totalSegments, 1, 64) || !safeInteger(value.completedSegments, 0, value.totalSegments)
    || !safeInteger(value.createdAt, 0) || !safeInteger(value.updatedAt, value.createdAt)
    || typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1
    || !Array.isArray(value.segmentNodeIds) || value.segmentNodeIds.length > value.totalSegments
    || value.segmentNodeIds.some((id) => typeof id !== 'string' || !NODE_ID_RE.test(id))
    || new Set(value.segmentNodeIds).size !== value.segmentNodeIds.length
    || (value.outputNodeId !== undefined && (typeof value.outputNodeId !== 'string' || !NODE_ID_RE.test(value.outputNodeId)))
    || (value.error !== undefined && !safeText(value.error))
    || (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length > 8 || value.warnings.some((item) => !safeText(item))))) return null;
  const summary: PluginVideoReplicaJobSummary = {
    jobId: value.jobId as string, projectId: value.projectId as string, pluginId: value.pluginId as string,
    nodeId: value.nodeId as string, modelId: value.modelId as string, sourceDigest: value.sourceDigest as string,
    revisionDigest: value.revisionDigest as string, status: value.status as PluginVideoReplicaJobSummary['status'],
    stage: value.stage, totalSegments: value.totalSegments as number, completedSegments: value.completedSegments as number,
    progress: value.progress as number, createdAt: value.createdAt as number, updatedAt: value.updatedAt as number,
    segmentNodeIds: [...value.segmentNodeIds] as string[],
  };
  if (value.outputNodeId !== undefined) summary.outputNodeId = value.outputNodeId as string;
  if (value.error !== undefined) summary.error = value.error as string;
  if (value.warnings !== undefined) summary.warnings = [...value.warnings as string[]];
  return summary;
}

export async function readPluginVideoReplicaJobs(projectId: string): Promise<PluginVideoReplicaJobSummary[]> {
  if (!safeId(projectId)) throw new Error('复刻任务项目标识无效');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_METADATA, 'readonly').objectStore(STORE_METADATA).get(pluginVideoReplicaJobsKey(projectId));
    request.onsuccess = () => {
      if (request.result === undefined) { resolve([]); return; }
      if (!Array.isArray(request.result?.jobs) || request.result.jobs.length > HISTORY_MAX) {
        reject(new Error('复刻任务记录异常，请检查项目存储')); return;
      }
      resolve(request.result.jobs.map(sanitizeReplicaJobSummary)
        .filter((job: PluginVideoReplicaJobSummary | null): job is PluginVideoReplicaJobSummary => !!job && job.projectId === projectId));
    };
    request.onerror = () => reject(request.error);
  });
}

export function recoverPluginVideoReplicaJob(summary: PluginVideoReplicaJobSummary): PluginVideoReplicaJobSummary {
  const sanitized = sanitizeReplicaJobSummary(summary);
  if (!sanitized) throw new Error('复刻任务摘要无效');
  return ['queued', 'preparing', 'generating', 'composing'].includes(sanitized.status)
    ? { ...sanitized, status: sanitized.status === 'generating' ? 'unknown' : 'paused',
      stage: sanitized.status === 'generating' ? '生成状态待核对；未自动重新提交' : '任务已暂停；未自动继续' }
    : sanitized;
}

export function savePluginVideoReplicaJob(summary: PluginVideoReplicaJobSummary): Promise<void> {
  const sanitized = sanitizeReplicaJobSummary(summary);
  if (!sanitized) return Promise.reject(new Error('复刻任务摘要无效'));
  const projectId = sanitized.projectId;
  const previous = writes.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const prior = await readPluginVideoReplicaJobs(projectId);
    const jobs = [...prior.filter((job) => job.jobId !== sanitized.jobId), sanitized].slice(-HISTORY_MAX);
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_METADATA, 'readwrite');
      tx.objectStore(STORE_METADATA).put({ id: pluginVideoReplicaJobsKey(projectId), jobs });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  });
  writes.set(projectId, next);
  void next.finally(() => { if (writes.get(projectId) === next) writes.delete(projectId); }).catch(() => undefined);
  return next;
}
